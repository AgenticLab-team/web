import "server-only";

import { and, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { boards, drafts, messages, posts, replies, users } from "@/lib/db/schema";
import type { CurrentUser } from "@/lib/auth/session";
import { canSeePost } from "@/lib/forum/visibility";
import { buildViewerContext } from "@/lib/forum/context";
import { toVisibilityInfo } from "@/lib/forum/queries";
import { resolveDisplayName } from "@/lib/users/display-name";
import { startOfDayMs, shiftDateKey, todayKey } from "@/lib/time";

/**
 * 「你不在的时候」。
 *
 * 这是让人第二天愿意再打开网站的那块内容。签到本身不构成理由 ——
 * 签到是**已经来了之后**做的事；先得有个理由回来。
 *
 * 所以这里回答的是一个很具体的问题：**我不在的这段时间，错过了什么。**
 * 数字要小、要具体、要能点进去。「新增 137 条消息」没有意义，
 * 「有 2 个人回复了你」才会让人点开。
 *
 * 口径刻意用「最近 24 小时」而不是「上次访问以来」：
 * lastActiveAt 每次请求都在更新，用它算出来的永远是 0。
 */

export interface Digest {
  /** 回复了你的人数 */
  repliesToMe: number;
  /** 最近 24 小时的新帖（只算你看得见的） */
  newPosts: number;
  /** 昨天你所在的群里有多少条高质量发言 */
  chatQualityYesterday: number;
  /**
   * 上面那个数字说的是哪一天（YYYY-MM-DD，东八区）。
   *
   * 页面要用它拼「去回看那一天」的链接，所以日期必须在这里算好带出去 ——
   * 让渲染的时候自己去读 Date.now() 既过不了 React Compiler 那关，
   * 也可能和统计口径差一天（跨过零点那次请求）。
   */
  chatDateKey: string;
  /**
   * 没写完的草稿。
   *
   * ─────────────────────────────────────────
   * 这是「明天还会打开」最强的一个理由
   * ─────────────────────────────────────────
   *
   * 线上 56 篇帖子对着 8 份草稿，其中两份上千字 ——
   * 有人认真写了一半，然后**没有任何地方提醒过他**。
   * 草稿页藏在「我的」下面，离开那个编辑器之后它就消失了。
   *
   * 一篇写了一半的东西，比任何「有 3 篇新帖」都更能把人叫回来 ——
   * 那是他自己的东西。
   */
  drafts: number;
  /**
   * 只有一份草稿时，把标题带出来。
   *
   * 「《人脑相当于多大的 AI 模型？》还没写完」比「你有 1 篇没写完的」
   * 强得多：前者他一眼就想起来自己写到哪儿了，后者他得先点进去看。
   *
   * 没标题的那些给 null —— 编不出名字就不编。
   */
  draftTitle: string | null;
  /** 最新的几篇帖子，直接给入口 */
  latest: { id: string; title: string; boardName: string; authorName: string; createdAt: number }[];
}

export function buildDigest(user: CurrentUser | null, convIds: string[]): Digest {
  const since = Date.now() - 86_400_000;

  /*
   * 草稿不设时间窗。
   *
   * 别的几项都只看最近 24 小时（「你不在的时候」发生了什么），
   * 而一份写了一半的东西**不会因为放了三天就不算数** ——
   * 恰恰相反，放得越久越需要有人提一句。
   */
  const draftRows = user
    ? db
        .select({ title: drafts.title, updatedAt: drafts.updatedAt })
        .from(drafts)
        .where(eq(drafts.userId, user.id))
        .orderBy(desc(drafts.updatedAt))
        .all()
    : [];

  const repliesToMe = user
    ? Number(
        db
          .select({ n: sql<number>`count(distinct ${replies.authorId})` })
          .from(replies)
          .innerJoin(posts, eq(posts.id, replies.postId))
          .where(
            and(
              eq(posts.authorId, user.id),
              // 自己回自己的帖不算「有人回复了你」
              ne(replies.authorId, user.id),
              isNull(replies.deletedAt),
              gt(replies.createdAt, since),
            ),
          )
          .get()?.n ?? 0,
      )
    : 0;

  // 「昨天」只算一次：分两处各算一次的话，跨零点的那一次请求会前后不一致
  const chatDateKey = shiftDateKey(todayKey(), -1);

  const chatQualityYesterday =
    convIds.length > 0
      ? Number(
          db
            .select({ n: sql<number>`count(*)` })
            .from(messages)
            .where(
              and(
                inArray(messages.convId, convIds),
                eq(messages.isQuality, true),
                sql`${messages.ts} >= ${startOfDayMs(chatDateKey)}`,
                sql`${messages.ts} < ${startOfDayMs(todayKey())}`,
              ),
            )
            .get()?.n ?? 0,
        )
      : 0;

  /*
   * 候选取多一些再按可见性过滤。
   * 直接在 SQL 里拼可见性条件会把六级可见性的判定抄成第二份 ——
   * 判定只有 canSeePost 一处，这里宁可多查几行再过。
   */
  const viewer = buildViewerContext(user);
  const candidates = db
    .select({
      post: posts,
      boardName: boards.name,
      authorSite: users.siteNickname,
      authorWx: users.wxNickname,
    })
    .from(posts)
    .innerJoin(boards, eq(boards.id, posts.boardId))
    .leftJoin(users, eq(users.id, posts.authorId))
    .where(and(isNull(posts.deletedAt), eq(posts.status, "published")))
    .orderBy(desc(posts.createdAt))
    .limit(40)
    .all();

  const visible = candidates.filter((r) => canSeePost(toVisibilityInfo(r.post), viewer).visible);

  return {
    repliesToMe,
    newPosts: visible.filter((r) => r.post.createdAt > since).length,
    chatQualityYesterday,
    chatDateKey,
    drafts: draftRows.length,
    // 只有一份时才报标题 —— 多份的时候报哪一份都是武断的
    draftTitle: draftRows.length === 1 ? (draftRows[0].title?.trim() || null) : null,
    latest: visible.slice(0, 3).map((r) => ({
      id: r.post.id,
      title: r.post.title,
      boardName: r.boardName,
      // 兜底不能落到 wxid：那是隐私，不该出现在任何界面上
      authorName: resolveDisplayName([r.authorSite, r.authorWx], { fallback: "社区成员" }),
      createdAt: r.post.createdAt,
    })),
  };
}
