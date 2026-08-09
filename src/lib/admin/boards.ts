import "server-only";

import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { boards, postTags, posts, tags } from "@/lib/db/schema";
import type { Visibility } from "@/lib/db/schema/forum";
import { postsAboveCap } from "@/lib/admin/board-rules";

/**
 * 版块与标签管理的读取层。
 *
 * 这里最重要的不是列出有什么，而是**改之前算得出影响面**。
 * 版块的可见性上限一收紧，已经发出去的帖子会当场从别人眼前消失，
 * 作者不知道为什么 —— 所以保存前必须能回答「这一改，影响几篇」。
 */

export interface BoardRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  sort: number;
  parentId: string | null;
  visibleTo: Visibility;
  defaultVisibility: Visibility;
  maxVisibility: Visibility;
  postMinLevel: number;
  locked: boolean;
  allowAnonymous: boolean;
  requireTags: boolean;
  /** 真实帖子数，不读冗余列 —— 那个列漂移过一次（群聊沉淀显示 0） */
  livePosts: number;
  /** 冗余列的值，两者不一致说明又漂了 */
  cachedCount: number;
  lastPostAt: number | null;
  childCount: number;
}

export function listBoardsForAdmin(): BoardRow[] {
  const rows = db
    .select()
    .from(boards)
    .where(isNull(boards.deletedAt))
    .orderBy(desc(boards.sort), asc(boards.key))
    .all();

  const live = new Map(
    db
      .select({ boardId: posts.boardId, n: sql<number>`count(*)` })
      .from(posts)
      .where(and(isNull(posts.deletedAt), ne(posts.status, "deleted"), ne(posts.status, "draft")))
      .groupBy(posts.boardId)
      .all()
      .map((r) => [r.boardId, Number(r.n)]),
  );

  const children = new Map<string, number>();
  for (const row of rows) {
    if (!row.parentId) continue;
    children.set(row.parentId, (children.get(row.parentId) ?? 0) + 1);
  }

  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    icon: row.icon,
    color: row.color,
    sort: row.sort,
    parentId: row.parentId,
    visibleTo: row.visibleTo,
    defaultVisibility: row.defaultVisibility,
    maxVisibility: row.maxVisibility,
    postMinLevel: row.postMinLevel,
    locked: row.locked,
    allowAnonymous: row.allowAnonymous,
    requireTags: row.requireTags,
    livePosts: live.get(row.id) ?? 0,
    cachedCount: row.postCount,
    lastPostAt: row.lastPostAt,
    childCount: children.get(row.id) ?? 0,
  }));
}

/** 父子关系表，环检测要用 */
export function boardParents(): Map<string, string | null> {
  return new Map(
    db
      .select({ id: boards.id, parentId: boards.parentId })
      .from(boards)
      .where(isNull(boards.deletedAt))
      .all()
      .map((r) => [r.id, r.parentId]),
  );
}

export interface CapImpact {
  affected: number;
  samples: { id: string; title: string; visibility: Visibility }[];
}

/**
 * 收紧可见性上限会影响哪些帖子。
 *
 * 返回**具体的几篇**而不只是数字：管理员看到「12 篇受影响」
 * 只能凭想象，看到「其中包括《XXX》」才知道自己在动什么。
 */
export function capImpact(boardId: string, newMax: Visibility): CapImpact {
  const rows = db
    .select({ id: posts.id, title: posts.title, visibility: posts.visibility })
    .from(posts)
    .where(and(eq(posts.boardId, boardId), isNull(posts.deletedAt), ne(posts.status, "deleted")))
    .all();

  const affected = postsAboveCap(rows, newMax);
  return { affected: affected.length, samples: affected.slice(0, 5) };
}

export interface TagRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  color: string | null;
  locked: boolean;
  /** 真实关联数 */
  liveCount: number;
  cachedCount: number;
  createdAt: number;
}

export function listTagsForAdmin(): TagRow[] {
  const rows = db.select().from(tags).orderBy(desc(tags.postCount), asc(tags.slug)).all();

  const live = new Map(
    db
      .select({ tagId: postTags.tagId, n: sql<number>`count(*)` })
      .from(postTags)
      .innerJoin(posts, eq(posts.id, postTags.postId))
      .where(and(isNull(posts.deletedAt), ne(posts.status, "deleted")))
      .groupBy(postTags.tagId)
      .all()
      .map((r) => [r.tagId, Number(r.n)]),
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    color: row.color,
    locked: row.locked,
    liveCount: live.get(row.id) ?? 0,
    cachedCount: row.postCount,
    createdAt: row.createdAt,
  }));
}

/** 某个标签下的帖子 id，合并时要用 */
export function postIdsOfTag(tagId: string): string[] {
  return db
    .select({ postId: postTags.postId })
    .from(postTags)
    .where(eq(postTags.tagId, tagId))
    .all()
    .map((r) => r.postId);
}

/**
 * 没有任何帖子在用的标签。
 *
 * 清理它们是安全的：标签本身不承载内容。
 * 但**不能顺手把锁定的一起清掉** —— 锁定往往正是为了预留一个
 * 还没开始用的官方标签。
 */
export function orphanTags(): TagRow[] {
  return listTagsForAdmin().filter((t) => t.liveCount === 0 && !t.locked);
}
