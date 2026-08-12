import "server-only";

import { and, eq, inArray, ne } from "drizzle-orm";

import { paletteIndexFor } from "@/components/Avatar";
import { db } from "@/lib/db";
import { githubConnections, githubFacts, githubRepoCache, people, users } from "@/lib/db/schema";
import { resolveDisplayName } from "@/lib/users/display-name";

import { canonicalUrl, parseRepoRef, repoRefKey } from "./link-refs";
import {
  MAX_PROJECTS,
  isShowcaseWorthy,
  languageFacets,
  rankProjects,
  type LanguageFacet,
  type ProjectSort,
} from "./project-rules";
import type { RepoFact } from "./repo-rules";

/**
 * 项目目录与项目页。
 *
 * ═════════════════════════════════════════
 * 隐私口径：这一页允许推断出什么，不允许推断出什么
 * ═════════════════════════════════════════
 *
 * 它把「站内某个人」和「某个 GitHub 账号」摆在同一行上。
 * ROADMAP 上那句话说得很准：**绑定关系是公开的**（那些仓库本来
 * 就在 GitHub 上摆着），但不能因此把「这个微信号是这个 GitHub 账号」
 * 送到不该看的人面前。
 *
 * 所以三道门，一道都不能省：
 *
 * ① **他自己打开了「在主页展示 GitHub」**（`showOnProfile`）。
 *    绑定 ≠ 同意公开 —— 有人绑定只是为了那条「要不要发帖分享」的
 *    提醒。默认是关的，这一页不做任何「反正他绑了」的推定。
 *
 * ② **他没有隐身**（`users.directory_hidden`）。这一条容易被漏掉，
 *    因为它看起来是「成员目录」那一页的事。但那个开关自己的原话是
 *    「不出现在成员列表和搜人结果里」—— 而**一个按语言可筛的项目目录
 *    就是一份换了个维度的成员名册**：照着人找项目和照着项目找人
 *    是同一件事。漏掉它，一个刚刚把自己从成员目录里摘出去的人，
 *    会在另一页上带着名字和头像重新出现。
 *
 * ③ **要登录**（`/projects` 在 PROTECTED_PREFIXES 里，拦在 proxy 那一层）。
 *    这一条挡的是访客和搜索引擎 —— 只在页面里 redirect 的话，
 *    爬虫拿到的是 200 加一个壳，而壳里已经渲染过一遍了（见 LESSONS）。
 *
 * 过了这三道之后，可见的范围**和成员主页上那一栏完全一样**
 * （见 `publicConnectionOf`：任何登录成员都看得到）。
 * 这一页因此没有制造出任何新的暴露面 —— 它只是把已经公开的东西
 * 换了个排法。这一句是整个口径的落点：新页面不新增可见性。
 */

export interface ProjectEntry {
  /** `owner/repo`，小写。地址、反查、去重都用它 */
  key: string;
  /** GitHub 上那个大小写原样的名字，显示用 */
  fullName: string;
  name: string;
  description: string | null;
  htmlUrl: string;
  language: string | null;
  stars: number;
  forks: number;
  archived: boolean;
  isFork: boolean;
  pushedAt: number;
  createdAt: number;
  /**
   * 站内是谁做的。
   *
   * **不是可选的** —— 过不了上面三道门的人根本不会进到这个列表里，
   * 所以这一页上的每一个项目都说得出是谁做的。
   * 做成可空的话，「不知道是谁」和「他不想让你知道是谁」
   * 会长成同一个样子。
   */
  builder: Builder;
}

export interface Builder {
  userId: string;
  name: string;
  avatar: string | null;
  /**
   * 占位头像的配色下标。
   *
   * **传下标而不是传 wx_id** —— 一个只用来算颜色的值一旦进了组件的
   * props，就会被序列化进 RSC 载荷、出现在网页源码里
   * （见 Avatar.paletteIndexFor 上那段）。
   */
  paletteIndex: number;
  /**
   * 有没有主页可以点进去。
   *
   * 只给一个布尔而不是 wxId：落点走 `/members/by/<账号 id>` 的中转，
   * 和成员目录同一条规矩 —— 目录里有一群从没在群里说过话的人，
   * 他们的 wx_id 不该因为「让名字可以点」就摊在页面源码里。
   */
  hasProfile: boolean;
  githubLogin: string;
  githubUrl: string;
}

/** 一个人 → 一批仓库。已经过完三道门 */
function consentedRepos(): { builder: Builder; repos: RepoFact[] }[] {
  const conns = db
    .select({
      userId: githubConnections.userId,
      login: githubConnections.login,
      htmlUrl: githubConnections.htmlUrl,
    })
    .from(githubConnections)
    // ① 展示开关。绑定不等于同意公开
    .where(eq(githubConnections.showOnProfile, true))
    .all();
  if (conns.length === 0) return [];

  const ids = conns.map((c) => c.userId);
  const accounts = db
    .select({
      id: users.id,
      wxId: users.wxId,
      siteNickname: users.siteNickname,
      wxNickname: users.wxNickname,
      avatar: users.wxAvatarUrl,
      hidden: users.directoryHidden,
    })
    .from(users)
    // 机器人账号不算社区成员的项目
    .where(and(inArray(users.id, ids), ne(users.kind, "bot")))
    .all();

  const wxIds = accounts.map((a) => a.wxId).filter(Boolean) as string[];
  const profiles = new Map(
    wxIds.length
      ? db
          .select({ wxId: people.wxId, name: people.displayName, avatar: people.avatarUrl })
          .from(people)
          .where(inArray(people.wxId, wxIds))
          .all()
          .map((p) => [p.wxId, p])
      : [],
  );

  const caches = new Map(
    db
      .select({ userId: githubRepoCache.userId, repos: githubRepoCache.repos })
      .from(githubRepoCache)
      .where(inArray(githubRepoCache.userId, ids))
      .all()
      .map((r) => [r.userId, Array.isArray(r.repos) ? (r.repos as RepoFact[]) : []]),
  );

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out: { builder: Builder; repos: RepoFact[] }[] = [];

  for (const conn of conns) {
    const account = byId.get(conn.userId);
    if (!account) continue;
    // ② 隐身。理由写在文件头 —— 项目目录是一份换了维度的成员名册
    if (account.hidden) continue;

    const profile = account.wxId ? profiles.get(account.wxId) : undefined;
    out.push({
      builder: {
        userId: account.id,
        // 存量数据里 people.displayName 混着 wx_id，必须走统一解析
        name: resolveDisplayName([account.siteNickname, account.wxNickname, profile?.name], {
          wxId: account.wxId,
          fallback: "成员",
        }),
        avatar: account.avatar ?? profile?.avatar ?? null,
        paletteIndex: paletteIndexFor(account.wxId ?? account.id),
        hasProfile: Boolean(account.wxId),
        githubLogin: conn.login,
        /*
         * 用绑定时 GitHub 自己给的 html_url，**不拿 login 拼**。
         * 拼的那一版在他改过用户名之后会指向一个已经被别人注册走的
         * 地址 —— 那是这个站唯一一处会把人送到冒充者那里去的链接。
         */
        githubUrl: conn.htmlUrl,
      },
      repos: caches.get(conn.userId) ?? [],
    });
  }
  return out;
}

function toEntry(repo: RepoFact, builder: Builder): ProjectEntry | null {
  const parsed = parseRepoRef(repo.fullName);
  // 认不出来的名字不进目录 —— 它会被拼进项目页的地址
  if (!parsed) return null;
  return {
    key: repoRefKey(parsed),
    fullName: repo.fullName,
    name: repo.name,
    description: repo.description,
    htmlUrl: repo.htmlUrl,
    language: repo.language,
    stars: repo.stars,
    forks: repo.forks,
    archived: repo.archived,
    isFork: repo.isFork,
    pushedAt: repo.pushedAt,
    createdAt: repo.createdAt,
    builder,
  };
}

export interface ProjectDirectory {
  projects: ProjectEntry[];
  facets: LanguageFacet[];
  /** 一共有多少（筛之前）—— 页面要说得出自己有多空 */
  total: number;
  /** 有几个人的项目摆在这儿。「一个社区」和「一个人的仓库列表」的区别 */
  builders: number;
}

/**
 * 项目目录。**纯读缓存表，一个网络请求都不发。**
 *
 * 仓库快照由本人打开自己的页面时在后台刷（见 repos.ts）。
 * 这一页跟着那份缓存走，代价是某个人的 star 数可能旧几个小时 ——
 * 而在这一页上，那个数字旧半天没有任何人看得出来。
 */
export function projectDirectory(
  options: { language?: string; sort?: ProjectSort; limit?: number } = {},
): ProjectDirectory {
  const entries: ProjectEntry[] = [];
  const seen = new Set<string>();
  let builders = 0;

  for (const { builder, repos } of consentedRepos()) {
    let any = false;
    for (const repo of repos) {
      if (!isShowcaseWorthy(repo)) continue;
      const entry = toEntry(repo, builder);
      if (!entry) continue;
      /*
       * 同一个仓库两个人都列着（一个是 owner，一个 fork 之后改了名
       * 又同名）时只留第一个 —— 项目页是按 `owner/repo` 定位的，
       * 同一个 key 出现两行的话，两行点进去是同一页。
       */
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      entries.push(entry);
      any = true;
    }
    if (any) builders++;
  }

  const facets = languageFacets(entries);
  const filtered = options.language
    ? entries.filter((e) => e.language === options.language)
    : entries;

  return {
    projects: rankProjects(filtered, options.sort ?? "active").slice(0, options.limit ?? MAX_PROJECTS),
    facets,
    total: entries.length,
    builders,
  };
}

export interface ProjectHeader {
  key: string;
  owner: string;
  repo: string;
  url: string;
  /** 站内做它的人。没有就是这个项目和站内成员没有绑定关系 —— 很正常 */
  builders: Builder[];
  /** 从缓存里拿到的那一份事实。拿不到就是 null，页面照常显示 */
  entry: ProjectEntry | null;
  /** 「这篇提到的」那张卡片攒下来的简介 —— 没有站内成员做它时的兜底 */
  cachedSummary: string | null;
}

/**
 * 一个项目页要的表头。
 *
 * ─────────────────────────────────────────
 * 项目**不必**是站内谁绑过的
 * ─────────────────────────────────────────
 *
 * 有人聊一个跟这个社区毫无关系的上游仓库，这完全正常，
 * 而那正是「站里聊过它的帖子」最有价值的一种情况。
 * 所以这一页在没有任何站内绑定时也要打得开 ——
 * 那时它只有一个名字、一条去 GitHub 的链接，和底下那些帖子。
 *
 * 简介退而求其次地从 `github_facts`（帖子卡片那份缓存）里拿。
 * **不联网**：拿不到就不显示简介，而不是现问一次。
 */
export function projectHeader(rawOwner: string, rawRepo: string): ProjectHeader | null {
  const parsed = parseRepoRef(`${rawOwner}/${rawRepo}`);
  if (!parsed) return null;
  const key = repoRefKey(parsed);

  const builders: Builder[] = [];
  let entry: ProjectEntry | null = null;
  for (const { builder, repos } of consentedRepos()) {
    for (const repo of repos) {
      const ref = parseRepoRef(repo.fullName);
      if (!ref || repoRefKey(ref) !== key) continue;
      builders.push(builder);
      // 第一个拿到的快照当表头 —— 同一个仓库两份快照的内容是一样的
      entry ??= toEntry(repo, builder);
      break;
    }
  }

  const cached = db
    .select({ summary: githubFacts.summary, gone: githubFacts.gone })
    .from(githubFacts)
    .where(eq(githubFacts.key, `repo:${key}`))
    .get();

  return {
    key,
    owner: parsed.owner,
    repo: parsed.repo,
    // 地址由我们自己拼，不用接口回的 —— 和卡片那边同一条规矩
    url: canonicalUrl({ kind: "repo", owner: parsed.owner, repo: parsed.repo }),
    builders,
    entry,
    cachedSummary: cached && !cached.gone ? cached.summary : null,
  };
}
