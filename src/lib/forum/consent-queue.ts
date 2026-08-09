import "server-only";

import { eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { boards, postSources, posts } from "@/lib/db/schema";
import type { ConsentEntry } from "@/lib/forum/convert-queries";

/**
 * 「全员已同意，等人提升可见范围」的队列。
 *
 * ─────────────────────────────────────────
 * 这条路走到头之后没有人知道
 * ─────────────────────────────────────────
 *
 * 从群聊整理出来的帖子默认只有原群成员可见。要让更多人看到，
 * 每一位被引用的原作者都要点同意 —— 这条规矩是对的，
 * 引用别人在群里说的话本来就该由他自己说了算。
 *
 * 问题在**同意齐了之后**：
 *
 *   · 提升可见范围的按钮只有版主看得到（这也是对的 ——
 *     放大别人的话是一次治理动作，不该由整理者自己按）
 *   · 而**没有任何地方告诉版主「这一篇已经齐了」**
 *
 * 于是帖子停在那儿。线上真的有一篇：三位原作者全同意了，
 * 可见性还是 group，而谁也不知道它在等。
 *
 * 整理者那一侧看到的是「3/3 位原作者同意公开」——
 * 一个看起来该公开却没公开的状态，读起来像是坏了。
 *
 * ─────────────────────────────────────────
 * 为什么是队列，不是通知
 * ─────────────────────────────────────────
 *
 * 通知会被读完就消失，而这件事是**有状态的**：
 * 它一直「在等」，直到有人处理或者有人明确说不提。
 * 一条读过的通知不会再提醒任何人，而一个队列会一直摆在那儿。
 */

export interface ReadyToRaise {
  postId: string;
  title: string;
  boardName: string;
  /** 版块封顶 —— 有的版块本来就到不了 public，界面要说清楚 */
  boardMax: string;
  visibility: string;
  authors: number;
  convertedAt: number;
}

/**
 * 齐了、但还没提的。
 *
 * 只看**还锁在原群**的（`visibility = "group"`）：已经提到
 * member / public 的说明处理过了，再列出来就是噪音。
 */
export function readyToRaise(limit = 20): ReadyToRaise[] {
  const rows = db
    .select({
      postId: posts.id,
      title: posts.title,
      visibility: posts.visibility,
      /*
       * 用**转帖那一刻**的时间，不是帖子的 createdAt。
       *
       * 两者在转帖的当下相等，但帖子会被移版块、被改，
       * 而「这次转帖发生在什么时候」是来源表自己的事实 ——
       * 队列按等待时长排序，等的正是这个时刻起算的。
       */
      createdAt: postSources.convertedAt,
      boardName: boards.name,
      boardMax: boards.maxVisibility,
      log: postSources.consentLog,
    })
    .from(postSources)
    .innerJoin(posts, eq(posts.id, postSources.postId))
    .innerJoin(boards, eq(boards.id, posts.boardId))
    .where(isNull(posts.deletedAt))
    .all();

  return rows
    .filter((r) => r.visibility === "group")
    .map((r) => ({ ...r, entries: (r.log as ConsentEntry[] | null) ?? [] }))
    .filter((r) => r.entries.length > 0 && r.entries.every((e) => e.status === "granted"))
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, limit)
    .map((r) => ({
      postId: r.postId,
      title: r.title,
      boardName: r.boardName,
      boardMax: r.boardMax,
      visibility: r.visibility,
      authors: r.entries.length,
      convertedAt: r.createdAt,
    }));
}

/**
 * 还在等谁。
 *
 * 和上面那个相反：**没齐**的那些。列出来是为了让整理者
 * 和版主都看得见「卡在哪儿」—— 一个不说明卡在谁身上的等待，
 * 会被当成系统坏了。
 */
export function awaitingConsent(limit = 20): (ReadyToRaise & { pending: number })[] {
  const rows = db
    .select({
      postId: posts.id,
      title: posts.title,
      visibility: posts.visibility,
      /*
       * 用**转帖那一刻**的时间，不是帖子的 createdAt。
       *
       * 两者在转帖的当下相等，但帖子会被移版块、被改，
       * 而「这次转帖发生在什么时候」是来源表自己的事实 ——
       * 队列按等待时长排序，等的正是这个时刻起算的。
       */
      createdAt: postSources.convertedAt,
      boardName: boards.name,
      boardMax: boards.maxVisibility,
      log: postSources.consentLog,
    })
    .from(postSources)
    .innerJoin(posts, eq(posts.id, postSources.postId))
    .innerJoin(boards, eq(boards.id, posts.boardId))
    .where(isNull(posts.deletedAt))
    .all();

  return rows
    .map((r) => ({ ...r, entries: (r.log as ConsentEntry[] | null) ?? [] }))
    .filter((r) => r.entries.some((e) => e.status === "pending"))
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, limit)
    .map((r) => ({
      postId: r.postId,
      title: r.title,
      boardName: r.boardName,
      boardMax: r.boardMax,
      visibility: r.visibility,
      authors: r.entries.length,
      pending: r.entries.filter((e) => e.status === "pending").length,
      convertedAt: r.createdAt,
    }));
}
