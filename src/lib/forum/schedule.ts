import "server-only";

import { and, asc, eq, isNotNull, isNull, lte } from "drizzle-orm";

import { db } from "@/lib/db";
import { boards, posts, users } from "@/lib/db/schema";
import { resolveDisplayName } from "@/lib/users/display-name";

import { COMMUNITY_TIMEZONE } from "@/lib/time";

import { recountBoardPosts } from "./board-stats";
import { notifyNewPost } from "./notify";
import { publishedCreatedAt } from "./schedule-rules";

/**
 * 到点了就把定时的帖子发出去。
 *
 * ─────────────────────────────────────────
 * 挂在五分钟一轮的定时任务上
 * ─────────────────────────────────────────
 *
 * 服务器上跑着 `agenticlab-health.timer`。这个函数是它的一步 ——
 * 而不是一个自己的定时器：多一个定时器就多一处会悄悄停掉、
 * 而且没人看得出来的东西。挂进已经在跑、已经有告警的那一轮里，
 * 它停了会和别的步骤一起被发现。
 *
 * ─────────────────────────────────────────
 * 一篇失败不能连累其它篇
 * ─────────────────────────────────────────
 *
 * 一轮里可能有好几篇同时到点。逐篇各自成事务 ——
 * 一起放进一个事务的话，某一篇的通知扇出抛异常，
 * 会把同一轮里其它人的帖子一起回滚，而他们完全无辜。
 */

export interface PublishResult {
  published: number;
  failed: { postId: string; error: string }[];
}

export function publishDueScheduled(now = Date.now()): PublishResult {
  const due = db
    .select({ post: posts, board: boards })
    .from(posts)
    .innerJoin(boards, eq(boards.id, posts.boardId))
    .where(
      and(
        eq(posts.status, "draft"),
        isNotNull(posts.scheduledAt),
        lte(posts.scheduledAt, now),
        isNull(posts.deletedAt),
      ),
    )
    // 早该发的先发 —— 服务停过一段时间时，顺序才符合作者的本意
    .orderBy(asc(posts.scheduledAt))
    .all();

  const result: PublishResult = { published: 0, failed: [] };

  for (const { post, board } of due) {
    try {
      /*
       * 发帖时间算发布那一刻，不算写下那一刻。
       *
       * 列表按 created_at 排序，保留写作时间的话，
       * 一个周一写、周五发的帖子一发出来就排在四天前的位置 ——
       * 对所有人来说它是新的，而它出现在没人会翻到的地方。
       */
      const createdAt = publishedCreatedAt(post.scheduledAt ?? now, now);

      db.transaction((tx) => {
        tx.update(posts)
          .set({ status: "published", createdAt })
          .where(eq(posts.id, post.id))
          .run();

        // 计数走重算，不手写 +1 —— 「+1」是第二份真相
        recountBoardPosts(board.id, tx);
        tx.update(boards).set({ lastPostAt: createdAt }).where(eq(boards.id, board.id)).run();
      });

      /*
       * 扇出放在事务**外面**。
       *
       * 通知是可以重来的，帖子状态不是。放进去的话，
       * 一次扇出失败会把「已经发布」这件事回滚掉，
       * 而下一轮又会重发一遍 —— 中间那段时间帖子忽有忽无。
       */
      const author = db
        .select({ siteNickname: users.siteNickname, wxNickname: users.wxNickname, wxId: users.wxId })
        .from(users)
        .where(eq(users.id, post.authorId))
        .get();

      notifyNewPost({
        postId: post.id,
        title: post.title,
        authorId: post.authorId,
        // 匿名与否由 notifyNewPost 自己从帖子行上判
        authorName: resolveDisplayName([author?.siteNickname, author?.wxNickname], {
          wxId: author?.wxId,
          fallback: "有人",
        }),
        boardId: board.id,
        boardName: board.name,
      });

      result.published++;
    } catch (error) {
      // 记下来接着跑下一篇 —— 一篇的问题不该让这一轮剩下的都发不出去
      result.failed.push({
        postId: post.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

export interface ScheduledPost {
  id: string;
  title: string;
  boardKey: string;
  boardName: string;
  scheduledAt: number;
  createdAt: number;
  /**
   * 已经过点、还没轮到这一轮定时任务。
   *
   * 在查询层算而不是在组件里 —— 组件里读时钟既不纯（React 编译器
   * 会拦），而且一页里早晚两行会用上不同的「现在」。
   */
  due: boolean;
  /** 「今天 09:00」「8 月 12 日 09:00」—— 同样在这里算 */
  whenLabel: string;
}

/**
 * 我定了时还没发出去的。
 *
 * 只查自己的 —— 这些帖子还没公开，没有「看别人的待发布」这回事。
 */
export function listScheduled(userId: string, now = Date.now()): ScheduledPost[] {
  return db
    .select({
      id: posts.id,
      title: posts.title,
      boardKey: boards.key,
      boardName: boards.name,
      scheduledAt: posts.scheduledAt,
      createdAt: posts.createdAt,
    })
    .from(posts)
    .innerJoin(boards, eq(boards.id, posts.boardId))
    .where(
      and(
        eq(posts.authorId, userId),
        eq(posts.status, "draft"),
        isNotNull(posts.scheduledAt),
        isNull(posts.deletedAt),
      ),
    )
    .orderBy(asc(posts.scheduledAt))
    .all()
    .map((r) => {
      const at = r.scheduledAt ?? 0;
      return { ...r, scheduledAt: at, due: at <= now, whenLabel: whenLabel(at, now) };
    });
}

/**
 * 「今天 09:00」「明天 09:00」「8 月 12 日 09:00」。
 *
 * 一律按社区时区（东八区）算，不看服务器自己的时区 ——
 * 服务器换个机房，所有人看到的时间就都错了。
 */
function whenLabel(at: number, now: number): string {
  const fmt = (ms: number, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("zh-CN", { timeZone: COMMUNITY_TIMEZONE, ...opts }).format(ms);

  const hhmm = fmt(at, { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (ms: number) => fmt(ms, { year: "numeric", month: "2-digit", day: "2-digit" });

  if (day(at) === day(now)) return `今天 ${hhmm}`;
  if (day(at) === day(now + 86_400_000)) return `明天 ${hhmm}`;
  return `${fmt(at, { month: "numeric", day: "numeric" })} ${hhmm}`;
}

