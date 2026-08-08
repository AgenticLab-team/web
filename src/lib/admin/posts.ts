import "server-only";

import { and, desc, eq, gte, inArray, isNull, like, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { boards, posts, replies, users } from "@/lib/db/schema";
import type { Visibility } from "@/lib/db/schema/forum";
import { visibilityLabel } from "@/lib/admin/board-rules";
import { resolveDisplayName } from "@/lib/users/display-name";

/**
 * 帖子与回复的管理视图。
 *
 * 与前台的 listPosts 不同：这里**不做可见性收口**，
 * 因为管理员本来就要能看到被隐藏和删除的东西 ——
 * 看不到就没法恢复，也没法判断当初删得对不对。
 *
 * 但正因如此，进入这一层之前的权限判定不能有任何含糊：
 * 页面上是 requireAdmin("forum.post.delete.any")。
 */

export interface AdminPostRow {
  id: string;
  title: string;
  excerpt: string | null;
  authorId: string;
  authorName: string;
  boardId: string;
  boardName: string;
  status: string;
  visibility: Visibility;
  visibilityLabel: string;
  /** 群聊转帖 */
  fromGroupChat: boolean;
  pinned: boolean;
  featured: boolean;
  replyCount: number;
  createdAt: number;
  deletedAt: number | null;
  deleteReason: string | null;
}

export interface PostQuery {
  keyword?: string;
  boardId?: string;
  status?: string;
  authorId?: string;
  /** 只看群聊转帖 */
  fromGroupChat?: boolean;
  days?: number;
  limit?: number;
  offset?: number;
}

export function listPostsForAdmin(query: PostQuery = {}): {
  rows: AdminPostRow[];
  total: number;
} {
  const conditions = [];

  if (query.keyword) {
    const kw = `%${query.keyword.trim()}%`;
    conditions.push(or(like(posts.title, kw), like(posts.content, kw))!);
  }
  if (query.boardId) conditions.push(eq(posts.boardId, query.boardId));
  if (query.authorId) conditions.push(eq(posts.authorId, query.authorId));
  if (query.fromGroupChat) conditions.push(eq(posts.visibilityLocked, true));
  if (query.days) conditions.push(gte(posts.createdAt, Date.now() - query.days * 86_400_000));

  if (query.status === "deleted") {
    // 「已删除」是一个刻意保留的筛选项：管理员要能回看自己删过什么
    conditions.push(eq(posts.status, "deleted"));
  } else if (query.status) {
    conditions.push(eq(posts.status, query.status as "published"));
  }

  const where = conditions.length ? and(...conditions) : undefined;
  const total = Number(
    db.select({ n: sql<number>`count(*)` }).from(posts).where(where).get()?.n ?? 0,
  );

  const rows = db
    .select({
      post: posts,
      boardName: boards.name,
      site: users.siteNickname,
      wx: users.wxNickname,
      wxId: users.wxId,
    })
    .from(posts)
    .innerJoin(boards, eq(boards.id, posts.boardId))
    .leftJoin(users, eq(users.id, posts.authorId))
    .where(where)
    .orderBy(desc(posts.createdAt))
    .limit(Math.min(query.limit ?? 40, 200))
    .offset(query.offset ?? 0)
    .all();

  return {
    total,
    rows: rows.map(({ post, boardName, site, wx, wxId }) => ({
      id: post.id,
      title: post.title,
      excerpt: post.excerpt,
      authorId: post.authorId,
      // 匿名帖在后台仍然显示作者 —— 匿名是对其他用户的，不是对管理员的，
      // 否则处理纠纷时连是谁发的都查不到
      authorName: post.anonymous
        ? `${resolveDisplayName([site, wx], { wxId, fallback: "社区成员" })}（匿名发布）`
        : resolveDisplayName([site, wx], { wxId, fallback: "社区成员" }),
      boardId: post.boardId,
      boardName,
      status: post.status,
      visibility: post.visibility,
      visibilityLabel: visibilityLabel(post.visibility),
      fromGroupChat: post.visibilityLocked,
      pinned: post.pinned,
      featured: post.featured,
      replyCount: post.replyCount,
      createdAt: post.createdAt,
      deletedAt: post.deletedAt,
      deleteReason: post.deleteReason,
    })),
  };
}

export function postFacets() {
  const byStatus = db
    .select({ status: posts.status, n: sql<number>`count(*)` })
    .from(posts)
    .groupBy(posts.status)
    .all();

  const byBoard = db
    .select({ id: boards.id, name: boards.name, n: sql<number>`count(*)` })
    .from(posts)
    .innerJoin(boards, eq(boards.id, posts.boardId))
    .groupBy(boards.id, boards.name)
    .orderBy(desc(sql`3`))
    .all();

  const groupDerived = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(posts)
      .where(eq(posts.visibilityLocked, true))
      .get()?.n ?? 0,
  );

  return {
    status: byStatus.map((r) => ({ value: r.status, count: Number(r.n) })),
    boards: byBoard.map((r) => ({ id: r.id, name: r.name, count: Number(r.n) })),
    groupDerived,
  };
}

/** 选中的这批帖子的概况，用于操作前的确认文案 */
export function summarizeSelection(ids: string[]) {
  if (ids.length === 0) return { count: 0, authors: 0, groupDerived: 0, titles: [] as string[] };

  const rows = db
    .select({
      id: posts.id,
      title: posts.title,
      authorId: posts.authorId,
      locked: posts.visibilityLocked,
    })
    .from(posts)
    .where(inArray(posts.id, ids))
    .all();

  return {
    count: rows.length,
    authors: new Set(rows.map((r) => r.authorId)).size,
    groupDerived: rows.filter((r) => r.locked).length,
    titles: rows.slice(0, 5).map((r) => r.title),
  };
}

export interface AdminReplyRow {
  id: string;
  postId: string;
  postTitle: string;
  floor: number;
  content: string;
  authorId: string;
  authorName: string;
  status: string;
  collapsed: boolean;
  createdAt: number;
}

export function listRepliesForAdmin(
  query: { keyword?: string; postId?: string; status?: string; limit?: number } = {},
): AdminReplyRow[] {
  const conditions = [];
  if (query.keyword) conditions.push(like(replies.content, `%${query.keyword.trim()}%`));
  if (query.postId) conditions.push(eq(replies.postId, query.postId));
  if (query.status) conditions.push(eq(replies.status, query.status as "published"));

  return db
    .select({
      reply: replies,
      postTitle: posts.title,
      site: users.siteNickname,
      wx: users.wxNickname,
      wxId: users.wxId,
    })
    .from(replies)
    .innerJoin(posts, eq(posts.id, replies.postId))
    .leftJoin(users, eq(users.id, replies.authorId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(replies.createdAt))
    .limit(Math.min(query.limit ?? 40, 200))
    .all()
    .map(({ reply, postTitle, site, wx, wxId }) => ({
      id: reply.id,
      postId: reply.postId,
      postTitle,
      floor: reply.floor,
      content: reply.content,
      authorId: reply.authorId,
      authorName: resolveDisplayName([site, wx], { wxId, fallback: "社区成员" }),
      status: reply.status,
      collapsed: reply.collapsed,
      createdAt: reply.createdAt,
    }));
}

/** 孤儿检测：帖子所在版块已被软删 —— 这类帖子查得到、打不开 */
export function orphanPosts() {
  return db
    .select({ id: posts.id, title: posts.title, boardId: posts.boardId })
    .from(posts)
    .innerJoin(boards, eq(boards.id, posts.boardId))
    .where(and(isNull(posts.deletedAt), sql`${boards.deletedAt} is not null`))
    .all();
}
