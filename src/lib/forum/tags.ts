"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { posts } from "@/lib/db/schema";
import { can } from "@/lib/rbac/can";

import { cleanTags } from "./tag-rules";
import { applyTags } from "./tags-write";

/**
 * 标签。
 *
 * 允许用户新建标签，但**用 slug 做唯一键并归一化** ——
 * 不然「RAG」「rag」「Rag」会变成三个标签，
 * 一年后标签墙上全是同义词，筛选功能等于废了。
 */


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

  const wanted = cleanTags(names);

  db.transaction((tx) => applyTags(tx, postId, wanted, user.id));

  revalidatePath(`/forum/p/${postId}`);
  return { ok: true };
}
