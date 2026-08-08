"use server";

import { eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { postTags, posts, tags } from "@/lib/db/schema";
import { can } from "@/lib/rbac/can";

import { slugify } from "./tags-queries";

/**
 * 标签。
 *
 * 允许用户新建标签，但**用 slug 做唯一键并归一化** ——
 * 不然「RAG」「rag」「Rag」会变成三个标签，
 * 一年后标签墙上全是同义词，筛选功能等于废了。
 */

const MAX_TAGS_PER_POST = 5;

export interface TagResult {
  ok: boolean;
  error?: string;
}

export async function setPostTags(postId: string, names: string[]): Promise<TagResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const post = db.select().from(posts).where(eq(posts.id, postId)).get();
  if (!post) return { ok: false, error: "帖子不存在" };

  const isAuthor = post.authorId === user.id;
  const permission = isAuthor ? "forum.post.edit.own" : "forum.post.edit.any";
  const verdict = can(user, permission, { scopeType: "board", scopeId: post.boardId });
  if (!verdict.allowed) return { ok: false, error: verdict.reason };

  const cleaned = [...new Set(names.map(slugify).filter(Boolean))].slice(0, MAX_TAGS_PER_POST);

  db.transaction((tx) => {
    const previous = tx
      .select({ tagId: postTags.tagId })
      .from(postTags)
      .where(eq(postTags.postId, postId))
      .all()
      .map((r) => r.tagId);

    tx.delete(postTags).where(eq(postTags.postId, postId)).run();
    if (previous.length) {
      tx.update(tags)
        .set({ postCount: sql`MAX(0, ${tags.postCount} - 1)` })
        .where(inArray(tags.id, previous))
        .run();
    }

    for (const slug of cleaned) {
      let tag = tx.select().from(tags).where(eq(tags.slug, slug)).get();
      if (!tag) {
        // 锁定的标签只有管理员能新建，防止有人造一堆垃圾标签
        tag = tx
          .insert(tags)
          .values({ name: slug, slug, createdBy: user.id })
          .returning()
          .get();
      }
      tx.insert(postTags).values({ postId, tagId: tag.id }).onConflictDoNothing().run();
      tx.update(tags)
        .set({ postCount: sql`${tags.postCount} + 1` })
        .where(eq(tags.id, tag.id))
        .run();
    }
  });

  revalidatePath(`/forum/p/${postId}`);
  return { ok: true };
}
