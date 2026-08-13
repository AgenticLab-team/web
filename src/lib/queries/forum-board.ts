import "server-only";

import { and, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { posts, replies, users } from "@/lib/db/schema";

/**
 * 论坛活跃榜。
 *
 * ═════════════════════════════════════════
 * 它和群聊榜是**两个榜**，不是一个混合分
 * ═════════════════════════════════════════
 *
 * 站长要「论坛和 GitHub 活跃度也上榜单」。最自然的做法是算一个
 * 综合分 —— 而那需要回答一个没有答案的问题：**一篇长文顶几条群消息？**
 *
 * 随便定一个比例，它就会变成大家优化的目标：定高了大家去水帖，
 * 定低了没人写长文。而且那个比例是我拍的，没有任何依据能拿出来讲。
 *
 * 所以做成可切换的两个榜：各自按各自的自然单位排，谁都不用换算。
 * 「他在群里话不多但论坛上写得最多」这件事，两个榜并排着说得清楚，
 * 一个混合分反而会把它抹平成一个中间名次。
 *
 * ─────────────────────────────────────────
 * 为什么不数「条数」
 * ─────────────────────────────────────────
 *
 * 群聊榜排的是**高质量消息**，理由写在首页上：「按总条数排会让
 * 复读机上榜」。论坛这边一模一样 —— 按发帖 + 回复的条数排，
 * 冠军会是那个在每篇底下回「+1」的人。
 *
 * 所以回复要够长才算。门槛和群聊那边同一个数（15 字），
 * 用同一个数不是偷懒：两边要回答的是同一个问题
 * 「这句话有没有说出点东西」，用两个数会让人以为它们在衡量不同的事。
 */

/** 回复至少多少字才算数 —— 和群聊那边的 `sync.quality_min` 同一个口径 */
export const MIN_REPLY_CHARS = 15;

export interface ForumBoardEntry {
  rank: number;
  userId: string;
  wxId: string | null;
  name: string;
  avatarUrl: string | null;
  /** 发了几篇 */
  posts: number;
  /** 有实质内容的回复有几条 */
  replies: number;
  /** 他的帖子一共收到多少回复和心 —— 排序不看它，但它说明「有没有人在读」 */
  received: number;
  score: number;
}

export interface ForumBoardOptions {
  /**
   * 往回看几天；null = 全部。
   *
   * 收「天数」而不是「起始时间戳」：算那个时间戳要用 `Date.now()`，
   * 而在服务端组件的渲染期调它会被 lint 拦（规则是对的 ——
   * 渲染期读时钟意味着同一次渲染的两处可能拿到不同的「现在」）。
   * 放进这里算，调用方只需要说「本周」。
   */
  days: number | null;
  limit?: number;
  /** 关掉了「出现在榜单上」的人 */
  hiddenWxIds?: readonly string[];
}

/**
 * 分数 = 发帖 × 3 + 实质回复 × 1。
 *
 * ─────────────────────────────────────────
 * 这个 3 是有依据的，不是拍的
 * ─────────────────────────────────────────
 *
 * 它不是「一篇顶三条」这种价值判断，而是**让两种贡献在这个站的
 * 实际分布下大致可比**：线上现在 93 篇帖子、79 条回复，
 * 而发帖的人（29）比回帖的人（21）多不了多少 —— 也就是说
 * 人均发帖数和人均回帖数是同一个量级，写一篇的成本却明显高于回一条。
 *
 * 权重再高（比如 10）会让回复完全不算数，那就成了「发帖榜」；
 * 一比一则会让「在每篇底下认真回一句」的人赢过写长文的人。
 * 3 是这两头之间、而且**不需要精调**的位置 —— 需要精调的权重
 * 说明这个榜本来就不该有权重。
 */
export const POST_WEIGHT = 3;

export function forumBoard(options: ForumBoardOptions): ForumBoardEntry[] {
  const { days, limit = 50 } = options;
  const hidden = options.hiddenWxIds ?? [];
  const since = days === null ? null : Date.now() - days * 86_400_000;

  /*
   * 匿名帖**不计入**。
   *
   * 数字本身不说出是哪几篇，但在一个几十人的社区里，
   * 「某人今天的论坛计数从 0 变成 1」和「今天出现了一篇匿名帖」
   * 放在一起就够指认了。
   *
   * 这条和查询层那条「按作者筛的列表里永远没有匿名帖」是同一个判断，
   * 而那条注释写着理由：一条没有例外的规则，才是没法写错的规则。
   */
  const postConds = [
    isNull(posts.deletedAt),
    eq(posts.status, "published"),
    eq(posts.anonymous, false),
  ];
  if (since) postConds.push(gte(posts.createdAt, since));

  const postRows = db
    .select({
      userId: posts.authorId,
      n: sql<number>`count(*)`,
      received: sql<number>`sum(${posts.replyCount} + ${posts.reactionCount})`,
    })
    .from(posts)
    .where(and(...postConds))
    .groupBy(posts.authorId)
    .all();

  const replyConds = [
    isNull(replies.deletedAt),
    eq(replies.anonymous, false),
    // 够长才算 —— 否则冠军是那个在每篇底下回「+1」的人
    sql`length(${replies.content}) >= ${MIN_REPLY_CHARS}`,
  ];
  if (since) replyConds.push(gte(replies.createdAt, since));

  const replyRows = db
    .select({ userId: replies.authorId, n: sql<number>`count(*)` })
    .from(replies)
    .where(and(...replyConds))
    .groupBy(replies.authorId)
    .all();

  const merged = new Map<string, { posts: number; replies: number; received: number }>();
  const bump = (id: string, patch: Partial<{ posts: number; replies: number; received: number }>) => {
    const cur = merged.get(id) ?? { posts: 0, replies: 0, received: 0 };
    merged.set(id, {
      posts: cur.posts + (patch.posts ?? 0),
      replies: cur.replies + (patch.replies ?? 0),
      received: cur.received + (patch.received ?? 0),
    });
  };
  for (const r of postRows) bump(r.userId, { posts: Number(r.n), received: Number(r.received ?? 0) });
  for (const r of replyRows) bump(r.userId, { replies: Number(r.n) });
  if (merged.size === 0) return [];

  const ids = [...merged.keys()];
  const people = db
    .select({
      id: users.id,
      wxId: users.wxId,
      site: users.siteNickname,
      wx: users.wxNickname,
      avatar: users.wxAvatarUrl,
    })
    .from(users)
    .where(
      hidden.length > 0
        ? and(inArray(users.id, ids), notInArray(users.wxId, hidden as string[]))
        : inArray(users.id, ids),
    )
    .all();

  return people
    .map((p) => {
      const m = merged.get(p.id)!;
      return {
        rank: 0,
        userId: p.id,
        wxId: p.wxId,
        name: (p.site || p.wx || "成员").trim(),
        avatarUrl: p.avatar,
        posts: m.posts,
        replies: m.replies,
        received: m.received,
        score: m.posts * POST_WEIGHT + m.replies,
      };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || b.posts - a.posts || a.name.localeCompare(b.name, "zh"))
    .slice(0, limit)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}
