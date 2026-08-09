import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { boards, postTags, posts, tags } from "@/lib/db/schema";
import { canSeePost, type ViewerContext } from "@/lib/forum/visibility";
import { toVisibilityInfo } from "@/lib/forum/queries";

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
// 归一化搬到了 tag-rules.ts（纯函数，发帖框也要用同一份）
export { slugify } from "./tag-rules";

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

/**
 * 某个标签下这个人看得到的帖子。
 *
 * ─────────────────────────────────────────
 * 可见性一定要过一遍
 * ─────────────────────────────────────────
 *
 * 标签是横穿版块的：一篇私密帖、一篇只给某个身份组的帖，
 * 都可能挂着同一个标签。按标签取完就渲染的话，
 * 标签页会变成一个**绕开所有版块权限的后门** ——
 * 而它看起来只是一个筛选。
 *
 * `postIdsWithTag` 只回 id，判定留给这里，走的是全站同一个 `canSeePost`。
 */
export function postsWithTag(viewer: ViewerContext, slug: string, limit = 40) {
  const ids = postIdsWithTag(slug);
  if (ids.length === 0) return [];

  const rows = db
    .select({ post: posts, boardName: boards.name })
    .from(posts)
    .innerJoin(boards, eq(boards.id, posts.boardId))
    .where(inArray(posts.id, ids))
    .orderBy(desc(posts.createdAt))
    .all();

  /*
   * 用 `toVisibilityInfo` 而不是自己再摊一遍字段。
   *
   * 那个映射里有一处反直觉的对应（`fromGroupChat` 落在
   * `visibility_locked` 上），自己抄一份必然抄错 ——
   * 而抄错的方向是「把群聊转帖当成普通帖」，也就是漏一层保护。
   */
  return rows
    .filter((r) => canSeePost(toVisibilityInfo(r.post), viewer).visible)
    .slice(0, limit)
    .map((r) => ({ id: r.post.id, title: r.post.title, boardName: r.boardName }));
}
