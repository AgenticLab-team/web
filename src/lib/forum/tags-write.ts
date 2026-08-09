import "server-only";

import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { postTags, tags } from "@/lib/db/schema";
import type { CleanTag } from "./tag-rules";


/**
 * 写标签的那一段，抽出来给两个调用方共用。
 *
 * ─────────────────────────────────────────
 * 为什么不能直接复用那个 Server Action
 * ─────────────────────────────────────────
 *
 * 原来只有 `setPostTags`（一个 `"use server"` 的动作）会写标签，
 * 而发帖时要在**和帖子同一个事务里**写 —— 分两步的话，
 * 第二步失败会留下一篇没有标签的帖子，而作者未必知道该回去补。
 * 这和投票那边「和帖子在同一个事务里建」是同一条理由。
 *
 * `"use server"` 的文件只能导出 async 函数，也没法接收一个事务句柄，
 * 所以核心挪到这里，两边都调它。
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 把一篇帖子的标签设成给定的这些（先清后建）。
 *
 * `postCount` 是缓存列，加减都在这里做 —— 少做一边的话，
 * 标签墙上的数字会慢慢和真实情况脱节，而没有人查得出来是哪一次漏的。
 */
export function applyTags(tx: Tx, postId: string, wanted: CleanTag[], userId: string): void {
  const previous = tx
    .select({ tagId: postTags.tagId })
    .from(postTags)
    .where(eq(postTags.postId, postId))
    .all()
    .map((r) => r.tagId);

  tx.delete(postTags).where(eq(postTags.postId, postId)).run();
  if (previous.length > 0) {
    tx.update(tags)
      .set({ postCount: sql`MAX(0, ${tags.postCount} - 1)` })
      .where(inArray(tags.id, previous))
      .run();
  }

  for (const item of wanted) {
    let tag = tx.select().from(tags).where(eq(tags.slug, item.slug)).get();

    if (!tag) {
      /*
       * `name` 上有唯一索引，而两个不同的 slug 可能撞同一个 name
       * （虽然罕见）。撞了就退回用 slug 当 name —— 显示得难看一点，
       * 总比整篇帖子发不出去强。
       */
      try {
        tag = tx.insert(tags).values({ name: item.name, slug: item.slug, createdBy: userId }).returning().get();
      } catch {
        tag = tx.insert(tags).values({ name: item.slug, slug: item.slug, createdBy: userId }).returning().get();
      }
    }

    tx.insert(postTags).values({ postId, tagId: tag.id }).onConflictDoNothing().run();
    tx.update(tags)
      .set({ postCount: sql`${tags.postCount} + 1` })
      .where(eq(tags.id, tag.id))
      .run();
  }
}
