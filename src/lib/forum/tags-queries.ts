import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { postTags, tags } from "@/lib/db/schema";

/**
 * 标签的读取与归一化。
 *
 * 与 tags.ts 分开：那个文件是 "use server"，只能导出 async 函数。
 */

/**
 * 归一化：小写、去空白、把常见分隔符统一成连字符。
 *
 * 不归一化的话「RAG」「rag」「Rag」会变成三个标签，
 * 一年后标签墙上全是同义词，筛选功能等于废了。
 */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_/\\]+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function listTags(limit = 40) {
  return db
    .select()
    .from(tags)
    .where(sql`${tags.postCount} > 0`)
    .orderBy(desc(tags.postCount))
    .limit(limit)
    .all();
}

export function tagsOfPosts(postIds: string[]) {
  if (postIds.length === 0) return new Map<string, { slug: string; name: string }[]>();
  const rows = db
    .select({ postId: postTags.postId, slug: tags.slug, name: tags.name })
    .from(postTags)
    .innerJoin(tags, eq(tags.id, postTags.tagId))
    .where(inArray(postTags.postId, postIds))
    .all();

  const map = new Map<string, { slug: string; name: string }[]>();
  for (const row of rows) {
    if (!map.has(row.postId)) map.set(row.postId, []);
    map.get(row.postId)!.push({ slug: row.slug, name: row.name });
  }
  return map;
}

export function postIdsWithTag(slug: string): string[] {
  return db
    .select({ postId: postTags.postId })
    .from(postTags)
    .innerJoin(tags, eq(tags.id, postTags.tagId))
    .where(and(eq(tags.slug, slug)))
    .all()
    .map((r) => r.postId);
}
