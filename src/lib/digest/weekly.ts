import { MAX_WECHAT_LENGTH } from "@/lib/broadcast/rules";
import type { Visibility } from "@/lib/db/schema/forum";

/**
 * 每周精选。纯函数。
 *
 * ─────────────────────────────────────────
 * 三条不能让步的
 * ─────────────────────────────────────────
 *
 * **① 只收所有社群成员都能看的帖子。**
 * 精选是一条发进所有群的消息，内容对每个群都一样。
 * 只要有一条是「仅 A 群可见」的，它就会被念给 B 群听。
 * 所以 role / group / private 一律不收 —— 群聊转帖锁在原群里，
 * 这是 FORUM.md 里写死的硬约束，精选不能成为绕过它的路。
 *
 * **② 没内容就不发。**
 * 一条「本周精选：（空）」教会所有人以后忽略这个消息。
 * 宁可这周没有，也不要发一条没有东西的。
 *
 * **③ 生成的是草稿，不是发送。**
 * 定时任务只把草稿备好，发不发由人按。一个每周自动向
 * 一千六百人广播的机器人，被风控只是时间问题 ——
 * 而且没有人会为一条没人看过的自动消息负责。
 */

export const MAX_ITEMS = 5;
/** 一条帖子至少要有点动静才配进精选 —— 否则精选就只是「最近发了什么」 */
export const MIN_ENGAGEMENT = 2;
/**
 * 同一个人最多占几条。
 *
 * 没有这条限制的话，一个高产的成员可以把整期精选占满 ——
 * 而精选那条消息是发进所有群的，看起来就成了「本周某某专场」。
 * 这不是他的错，是排序分只看单条帖子、不看整期长什么样。
 *
 * 2 条是留出空间又不至于把人挤掉的分寸：五条里最多两条同一个人。
 */
export const MAX_PER_AUTHOR = 2;

/** 允许出现在精选里的可见性 —— 白名单，不是黑名单 */
const BROADCASTABLE: readonly Visibility[] = ["public", "unlisted", "member"] as const;

export function isBroadcastable(visibility: Visibility): boolean {
  return BROADCASTABLE.includes(visibility);
}

export interface DigestCandidate {
  id: string;
  title: string;
  excerpt: string | null;
  authorName: string;
  /**
   * 作者 id。用来做「同一个人最多几条」这条限制。
   *
   * 用 id 而不是 authorName：显示名会重名，也会改；
   * 而且匿名帖的 authorName 一律是「匿名」——
   * 按名字算的话，两个不同人的匿名帖会被当成同一个人。
   */
  authorId: string | null;
  visibility: Visibility;
  status: string;
  featured: boolean;
  replyCount: number;
  reactionCount: number;
  viewCount: number;
  createdAt: number;
  /** 是否来自群聊转帖 */
  fromGroupChat: boolean;
}

export interface DigestItem extends DigestCandidate {
  score: number;
  reason: string;
}

/**
 * 排序分。
 *
 * 回复比表情重要得多：表情是一秒钟的事，回复意味着有人真的坐下来写了点什么。
 * 浏览数**不算分** —— 它主要反映标题好不好，而不是内容值不值得再看一遍。
 *
 * 加精给 20 分（≈7 条回复）。定 10 分的时候，一个三回复三表情的普通帖
 * 就能压过编辑亲手挑的那条 —— 那等于加精没有意义。
 * 但也不给无穷大：一个二十回复的真热帖该排在一条安静的加精帖前面。
 */
export const FEATURED_BONUS = 20;

export function scorePost(post: DigestCandidate): number {
  return post.replyCount * 3 + post.reactionCount + (post.featured ? FEATURED_BONUS : 0);
}

/** 为什么它在这儿 —— 精选要说得出理由，否则就是「编辑随便挑的」 */
export function reasonFor(post: DigestCandidate): string {
  if (post.featured) return "已加精";
  if (post.replyCount >= 5) return `${post.replyCount} 条回复`;
  if (post.replyCount > 0) return `${post.replyCount} 条回复`;
  return `${post.reactionCount} 个表情`;
}

export interface SelectOptions {
  /** 已经进过往期精选的帖子 id */
  alreadySent?: Set<string>;
  max?: number;
  minEngagement?: number;
  /** 同一个作者最多占几条 —— 0 或负数表示不限 */
  maxPerAuthor?: number;
}

export interface Selection {
  items: DigestItem[];
  /** 被挡下的和原因 —— 空手而归时要说得出为什么 */
  rejected: { id: string; reason: string }[];
}

export function selectDigest(
  candidates: DigestCandidate[],
  options: SelectOptions = {},
): Selection {
  const alreadySent = options.alreadySent ?? new Set<string>();
  const minEngagement = options.minEngagement ?? MIN_ENGAGEMENT;
  const rejected: { id: string; reason: string }[] = [];
  const items: DigestItem[] = [];

  for (const post of candidates) {
    if (post.status !== "published") {
      rejected.push({ id: post.id, reason: `状态是 ${post.status}` });
      continue;
    }
    /*
     * 可见性用白名单挡。
     * 黑名单写法（「排除 private」）在新增一个可见性级别时会默认放行 ——
     * 而那一次放行没有任何人会注意到。
     */
    if (!isBroadcastable(post.visibility)) {
      rejected.push({
        id: post.id,
        reason: `可见性是 ${post.visibility} —— 只在部分人可见的内容不能发进所有群`,
      });
      continue;
    }
    if (alreadySent.has(post.id)) {
      rejected.push({ id: post.id, reason: "往期精选发过了" });
      continue;
    }

    const engagement = post.replyCount + post.reactionCount;
    if (!post.featured && engagement < minEngagement) {
      rejected.push({ id: post.id, reason: `只有 ${engagement} 条互动，够不上` });
      continue;
    }

    items.push({ ...post, score: scorePost(post), reason: reasonFor(post) });
  }

  items.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);

  /*
   * ─────────────────────────────────────────
   * 同一个人最多占几条
   * ─────────────────────────────────────────
   *
   * **排完序之后再筛**，不是排序之前 —— 要留下的是每个人分最高的那几条，
   * 而不是碰巧先遇到的那几条。
   *
   * 匿名帖（authorId 为空）不参与这条限制：它们本来就不署名，
   * 「某某专场」的观感不存在，而按空 id 归成一堆会把不同人的匿名帖
   * 算成同一个人。
   */
  const perAuthor = options.maxPerAuthor ?? MAX_PER_AUTHOR;
  const kept: DigestItem[] = [];
  const seen = new Map<string, number>();
  for (const item of items) {
    if (perAuthor > 0 && item.authorId) {
      const n = seen.get(item.authorId) ?? 0;
      if (n >= perAuthor) {
        rejected.push({ id: item.id, reason: `同一个人这期已经有 ${perAuthor} 条了` });
        continue;
      }
      seen.set(item.authorId, n + 1);
    }
    kept.push(item);
  }

  return { items: kept.slice(0, options.max ?? MAX_ITEMS), rejected };
}

// ── 文案 ────────────────────────────────────────────────────

export interface RenderOptions {
  siteUrl: string;
  weekLabel: string;
  maxLength?: number;
}

/**
 * 渲染成微信里能看的纯文本。
 *
 * 微信不支持 Markdown，链接也不会自动折叠 —— 所以格式全靠换行和符号。
 * 每条一定带链接：一条看得见标题却打不开的精选，只会让人来群里问。
 */
export function renderDigest(items: DigestItem[], options: RenderOptions): string {
  const base = options.siteUrl.replace(/\/+$/, "");
  const lines = [`📌 ${options.weekLabel} 社区精选`, ""];

  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title}`);
    if (item.excerpt) lines.push(`   ${truncate(item.excerpt, 40)}`);
    lines.push(`   ${item.authorName} · ${item.reason}`);
    lines.push(`   ${base}/forum/p/${item.id}`);
    lines.push("");
  });

  lines.push(`完整列表：${base}/forum`);

  const text = lines.join("\n");
  const limit = options.maxLength ?? MAX_WECHAT_LENGTH;
  if (text.length <= limit) return text;

  // 超长就少放几条，而不是从中间截断 —— 截断会切出半个链接
  return items.length > 1
    ? renderDigest(items.slice(0, items.length - 1), options)
    : text.slice(0, limit);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 2026-08-03 那一周 → 「8 月 3 日那周」 */
export function weekLabel(weekStart: string): string {
  const [, month, day] = weekStart.split("-");
  return `${Number(month)} 月 ${Number(day)} 日那周`;
}

/**
 * 给定时间落在哪一周（周一为起点，东八区）。
 *
 * 用周一而不是周日：这个社群的活跃度在工作日，
 * 周日切周会把一个连续的讨论劈成两周。
 */
export function weekStartOf(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = (date.getUTCDay() + 6) % 7; // 周一 = 0
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

export interface DigestVerdict {
  ok: boolean;
  reason: string;
}

/**
 * 这一周该不该出精选。
 *
 * 「东西太少就不发」是刻意的：一条只有一项的精选，
 * 比没有精选更让人觉得这个社区没什么在发生。
 */
export function shouldPublish(selection: Selection, minItems = 2): DigestVerdict {
  if (selection.items.length === 0) {
    return { ok: false, reason: "这一周没有够格进精选的帖子 —— 不发比发一条空的好" };
  }
  if (selection.items.length < minItems) {
    return {
      ok: false,
      reason: `只有 ${selection.items.length} 条够格（至少要 ${minItems} 条）—— 一条精选比没有精选更显得冷清`,
    };
  }
  return { ok: true, reason: `选出 ${selection.items.length} 条` };
}
