import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { bookmarks, postViews, reactions } from "@/lib/db/schema";
import { REACTION_KINDS } from "@/lib/db/schema/forum";

import type { ReactionState } from "@/components/forum/ReactionBar";

/**
 * 一次查完整页的反应状态，而不是每条回复各查一次。
 * 一个 50 楼的帖子，逐条查就是 200 次查询。
 */
export function reactionStates(
  targets: { type: "post" | "reply"; id: string }[],
  userId: string | null,
): Map<string, ReactionState[]> {
  const result = new Map<string, ReactionState[]>();
  if (targets.length === 0) return result;

  const ids = targets.map((t) => t.id);
  const rows = db
    .select({
      targetType: reactions.targetType,
      targetId: reactions.targetId,
      kind: reactions.kind,
      count: sql<number>`count(*)`,
      mine: sql<number>`SUM(CASE WHEN ${reactions.userId} = ${userId ?? ""} THEN 1 ELSE 0 END)`,
    })
    .from(reactions)
    .where(sql`${reactions.targetId} IN ${ids}`)
    .groupBy(reactions.targetType, reactions.targetId, reactions.kind)
    .all();

  const byTarget = new Map<string, Map<string, { count: number; mine: boolean }>>();
  for (const row of rows) {
    if (!byTarget.has(row.targetId)) byTarget.set(row.targetId, new Map());
    byTarget.get(row.targetId)!.set(row.kind, {
      count: Number(row.count),
      mine: Number(row.mine) > 0,
    });
  }

  for (const target of targets) {
    const found = byTarget.get(target.id);
    result.set(
      target.id,
      REACTION_KINDS.map((kind) => ({
        kind,
        count: found?.get(kind)?.count ?? 0,
        mine: found?.get(kind)?.mine ?? false,
      })),
    );
  }

  return result;
}

export function isBookmarked(userId: string, postId: string): boolean {
  return Boolean(
    db
      .select()
      .from(bookmarks)
      .where(and(eq(bookmarks.userId, userId), eq(bookmarks.postId, postId)))
      .get(),
  );
}

/** 上次读到第几楼。没记录返回 0，调用方据此决定要不要给「跳回」入口 */
export function readFloor(userId: string, postId: string): number {
  return (
    db
      .select({ floor: postViews.lastReadFloor })
      .from(postViews)
      .where(and(eq(postViews.userId, userId), eq(postViews.postId, postId)))
      .get()?.floor ?? 0
  );
}

export function listBookmarks(userId: string) {
  return db
    .select({ postId: bookmarks.postId, createdAt: bookmarks.createdAt })
    .from(bookmarks)
    .where(eq(bookmarks.userId, userId))
    .all();
}
