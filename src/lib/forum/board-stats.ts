import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { boards, posts } from "@/lib/db/schema";

/**
 * 版块帖子计数。
 *
 * boards.postCount 是冗余计数，历史上只有网页发帖（createPost）会 +1：
 * 群聊转帖不加、删帖不减。「群聊沉淀」版的帖子只能从转帖进来，
 * 于是它在线上常年显示 0 —— 一个悄悄漂移的计数器，
 * 把「统计坏了」伪装成了「确实没有帖子」，读者无从分辨。
 *
 * 修法不是在每个写路径各自 +1/-1 —— 那等于把「哪些帖子算数」
 * 这个口径抄写 N 遍，漏掉任何一处就再次漂移。
 * 而是收口成一个「从 posts 表重算」的函数：任何改变帖子存亡的
 * 写路径都调它，计数永远可以从源头重建，不存在只加不减的第二份真相。
 * count(*) 走 forum_posts_board_idx，帖子量级下代价可以忽略。
 */

/**
 * 哪些状态算「版块里有这篇帖子」：读者点进版块能看到的那些。
 * draft/hidden/deleted 不算 —— 把读者看不到的帖子计进去，
 * 版块列表会显示「有 5 篇」点进去却只有 2 篇，跟显示 0 一样是假数字。
 */
const COUNTED_STATUSES = ["published", "locked"] as const;

/** db 或事务对象都行 —— 发帖/转帖要求计数与帖子在同一个事务里落库 */
type Executor = Pick<typeof db, "select" | "update">;

/** 重算单个版块的帖子数并写回，返回新值 */
export function recountBoardPosts(boardId: string, executor: Executor = db): number {
  const n =
    executor
      .select({ n: sql<number>`count(*)` })
      .from(posts)
      .where(
        and(
          eq(posts.boardId, boardId),
          isNull(posts.deletedAt),
          inArray(posts.status, [...COUNTED_STATUSES]),
        ),
      )
      .get()?.n ?? 0;

  executor.update(boards).set({ postCount: n }).where(eq(boards.id, boardId)).run();
  return n;
}

export interface BoardRecount {
  key: string;
  name: string;
  before: number;
  after: number;
}

/** 全量重算所有版块，返回每个版块的修正前后值。给校准脚本与巡检用 */
export function recountAllBoards(executor: Executor = db): BoardRecount[] {
  const rows = executor
    .select({ id: boards.id, key: boards.key, name: boards.name, before: boards.postCount })
    .from(boards)
    .all();

  return rows.map((row) => ({
    key: row.key,
    name: row.name,
    before: row.before,
    after: recountBoardPosts(row.id, executor),
  }));
}
