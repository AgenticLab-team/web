/**
 * 「主页上展示哪些仓库、怎么排」的纯规则。不碰数据库、不碰网络。
 */

/** 我们从 GitHub 那边留下来的字段。**没有一个是私有数据** */
export interface RepoFact {
  id: string;
  fullName: string;
  name: string;
  description: string | null;
  htmlUrl: string;
  language: string | null;
  stars: number;
  forks: number;
  /** 这是不是一个 fork 来的仓库 */
  isFork: boolean;
  archived: boolean;
  /** 仓库自己声明的可见性。只该是 public —— 见 dropNonPublic */
  isPrivate: boolean;
  createdAt: number;
  pushedAt: number;
}

/** 主页上最多摆几个。再多就成了仓库列表页，而这一页是人的主页 */
export const MAX_SHOWCASE = 6;

/** 缓存多久算旧。6 小时 —— 一个人一天推几次代码，主页上差半天没人看得出来 */
export const REPO_CACHE_TTL_MS = 6 * 3_600_000;

/**
 * 两次抓取之间至少隔这么久。
 *
 * GitHub 的限流是**按服务器出口 IP 算的**，不是按用户 ——
 * 一个人狂点刷新会把全站的额度耗光，而症状是别人主页上的项目
 * 突然全空了。所以刷新有硬冷却，按钮点了也不一定真的去抓。
 */
export const REPO_REFRESH_COOLDOWN_MS = 10 * 60_000;

/**
 * 私有仓库一律丢掉。
 *
 * 抓取用的是 `/users/{login}/repos`，这个接口**按定义只返回公开仓库**，
 * 而且我们的 token 连一个 scope 都没有 —— 私有仓库在两道门之外。
 *
 * 那为什么还要这一层？因为这三道防线的**成本完全不对等**：
 * 前两道任何一次改动都可能悄悄放开（换个接口、加个 scope 图省事），
 * 而这一行不会。它是唯一一道写在我们自己代码里、
 * 会被测试盯着的防线。
 */
export function dropNonPublic(repos: RepoFact[]): RepoFact[] {
  return repos.filter((r) => !r.isPrivate);
}

/**
 * 排序。
 *
 * ─────────────────────────────────────────
 * 为什么不是「按 star 排」这么简单
 * ─────────────────────────────────────────
 *
 * 纯按 star 排，绝大多数人的主页会是一排 0 star 的仓库按随机顺序摆着 ——
 * 因为这个社群里大部分人的项目**都是 0 star**，而 star 数在这种情况下
 * 不携带任何信息。纯按更新时间排又会让一个昨天改了个 typo 的
 * 旧仓库压过认真做了半年的东西。
 *
 * 所以：本人置顶的最优先（他自己知道哪个值得看），剩下的
 * 先按 star 分档、档内按最近推送。fork 且没 star 的排到最后 ——
 * 那多半是「点了个 fork 按钮」，不是作品。
 */
export function rankRepos(repos: RepoFact[], pinned: string[] = []): RepoFact[] {
  const pinnedOrder = new Map(pinned.map((fullName, i) => [fullName, i]));

  return [...repos].sort((a, b) => {
    const pa = pinnedOrder.get(a.fullName);
    const pb = pinnedOrder.get(b.fullName);
    if (pa !== undefined || pb !== undefined) {
      if (pa === undefined) return 1;
      if (pb === undefined) return -1;
      return pa - pb;
    }

    const wa = weightOf(a);
    const wb = weightOf(b);
    if (wa !== wb) return wb - wa;
    if (a.stars !== b.stars) return b.stars - a.stars;
    return b.pushedAt - a.pushedAt;
  });
}

/** 只有三档：像样的作品 / 普通仓库 / 顺手 fork 的。档内再比 star 和时间 */
function weightOf(repo: RepoFact): number {
  if (repo.isFork && repo.stars === 0) return 0;
  if (repo.archived && repo.stars === 0) return 1;
  return 2;
}

/** 真正摆到主页上的那几个 */
export function showcaseRepos(
  repos: RepoFact[],
  pinned: string[] = [],
  limit = MAX_SHOWCASE,
): RepoFact[] {
  return rankRepos(dropNonPublic(repos), pinned).slice(0, limit);
}

/** 缓存旧了吗。fetchedAt 为 0 表示从来没抓过 */
export function isStale(fetchedAt: number, now: number, ttlMs = REPO_CACHE_TTL_MS): boolean {
  return now - fetchedAt >= ttlMs;
}

/** 现在可以再抓一次吗 —— 冷却期内一律不行，哪怕上次是失败的 */
export function mayRefresh(attemptedAt: number | null, now: number): boolean {
  if (!attemptedAt) return true;
  return now - attemptedAt >= REPO_REFRESH_COOLDOWN_MS;
}

/**
 * 置顶清单的清洗。
 *
 * 只留下真的存在于这个人仓库列表里的名字，且去重、限长 ——
 * 不清洗的话，前端传什么就存什么，一个构造出来的请求可以往
 * 这一列里塞任意长度的任意字符串，而它会被原样渲染到主页上。
 */
export function sanitizePinned(raw: unknown, owned: RepoFact[], limit = MAX_SHOWCASE): string[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set(dropNonPublic(owned).map((r) => r.fullName));
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    if (!valid.has(item)) continue;
    if (out.includes(item)) continue;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 自荐语的长度上限。
 *
 * ─────────────────────────────────────────
 * 140 是**故意短**的
 * ─────────────────────────────────────────
 *
 * 它要放在目录里每一行的第一句，而这一页的价值是**能扫**：
 * 二十个项目一屏看完，看到感兴趣的再点进去。
 * 允许写一段的话，前三个项目就占满一屏，第四个开始没人看得见 ——
 * 于是这个功能会奖励「谁先写、谁写得长」，而不是「谁做得好」。
 *
 * 短还有第二个好处：一句话逼人回答「这是什么、给谁用」，
 * 而一段话会滑向项目背景介绍 —— 那个 README 里已经有了。
 */
export const MAX_PITCH_CHARS = 140;

export interface PitchVerdict {
  ok: boolean;
  text: string;
  error: string | null;
}

/**
 * 洗一遍自荐语。
 *
 * 按**码点**数而不是 `.length` —— emoji 会被算成两个，
 * 而这个上限是给人看的「大概一句话」，不是给存储用的。
 */
export function validatePitch(raw: unknown): PitchVerdict {
  if (typeof raw !== "string") return { ok: false, text: "", error: "推荐语得是一段文字" };

  /*
   * 换行折成空格。
   *
   * 它渲染在列表行里，多行会把那一行撑高、把别人的项目挤下去 ——
   * 一个人多写两个回车就能占掉别人的位置，那是不该存在的杠杆。
   */
  const text = raw.replace(/\s+/g, " ").trim();

  if (!text) return { ok: true, text: "", error: null }; // 空 = 撤掉自荐
  if ([...text].length > MAX_PITCH_CHARS) {
    return { ok: false, text: "", error: `最多 ${MAX_PITCH_CHARS} 个字 —— 一句话说清楚它是什么` };
  }
  return { ok: true, text, error: null };
}
