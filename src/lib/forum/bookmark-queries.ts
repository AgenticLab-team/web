import "server-only";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { bookmarkFolders, bookmarks, boards, people, posts, users } from "@/lib/db/schema";
import { resolveDisplayName } from "@/lib/users/display-name";

import { canSeePost } from "./visibility";
import type { ViewerContext } from "./visibility";
import { toVisibilityInfo } from "./queries";
import { folderTabs, tombstone } from "./bookmark-rules";
import type { FolderTab, Tombstone } from "./bookmark-rules";

/**
 * 收藏夹的读取层。
 *
 * ─────────────────────────────────────────
 * 收藏必须重新过一遍可见性
 * ─────────────────────────────────────────
 *
 * 收藏是一条 (user, post) 记录，**它不会因为帖子改了可见范围而失效**。
 * 直接 join 出来渲染的话，收藏夹就成了一条绕过可见性的旁路：
 * 收藏一个公开帖，等作者改成「仅自己可见」，收藏夹里照样看得见。
 *
 * 所以这里和列表页走的是同一个 `canSeePost`，
 * 看不到的换成墓碑（见 bookmark-rules 里的 `tombstone`）。
 */

export interface BookmarkFolderRow {
  id: string;
  name: string;
  sort: number;
  count: number;
}

/** 用户自己建的收藏夹，带条数。未分组不在这里 —— 它不是一行记录 */
export function listFolders(userId: string): BookmarkFolderRow[] {
  const counts = new Map(
    db
      .select({ folderId: bookmarks.folderId, n: sql<number>`count(*)` })
      .from(bookmarks)
      .where(eq(bookmarks.userId, userId))
      .groupBy(bookmarks.folderId)
      .all()
      .map((r) => [r.folderId, Number(r.n)]),
  );

  return db
    .select({ id: bookmarkFolders.id, name: bookmarkFolders.name, sort: bookmarkFolders.sort })
    .from(bookmarkFolders)
    .where(eq(bookmarkFolders.userId, userId))
    .orderBy(asc(bookmarkFolders.sort), asc(bookmarkFolders.createdAt))
    .all()
    .map((f) => ({ ...f, count: counts.get(f.id) ?? 0 }));
}

export function unsortedCount(userId: string): number {
  return Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(bookmarks)
      .where(and(eq(bookmarks.userId, userId), isNull(bookmarks.folderId)))
      .get()?.n ?? 0,
  );
}

/** 侧栏那一列，含「全部」的总数 */
export function bookmarkTabs(userId: string): { all: number; tabs: FolderTab[] } {
  return folderTabs({ folders: listFolders(userId), unsortedCount: unsortedCount(userId) });
}

export interface BookmarkItem {
  id: string;
  postId: string;
  folderId: string | null;
  note: string | null;
  createdAt: number;
  /** 看不到的那些只有墓碑，没有标题也没有作者 */
  gone: Tombstone | null;
  title: string | null;
  excerpt: string | null;
  boardName: string | null;
  authorName: string | null;
  replyCount: number;
}

export interface ListBookmarksOptions {
  /** undefined = 全部；null = 未分组；string = 某个收藏夹 */
  folderId?: string | null;
  limit?: number;
  offset?: number;
}

export function listBookmarkItems(
  viewer: ViewerContext,
  options: ListBookmarksOptions = {},
): BookmarkItem[] {
  if (!viewer.userId) return [];

  const where = [eq(bookmarks.userId, viewer.userId)];
  if (options.folderId === null) where.push(isNull(bookmarks.folderId));
  else if (typeof options.folderId === "string") where.push(eq(bookmarks.folderId, options.folderId));

  const rows = db
    .select({ mark: bookmarks, post: posts, board: boards })
    .from(bookmarks)
    /*
     * leftJoin，不是 innerJoin。
     *
     * innerJoin 会让「帖子行被硬删了」的收藏整条不见 ——
     * 而那正是最需要说明一句的情况。
     */
    .leftJoin(posts, eq(posts.id, bookmarks.postId))
    .leftJoin(boards, eq(boards.id, posts.boardId))
    .where(and(...where))
    .orderBy(desc(bookmarks.createdAt))
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0)
    .all();

  const authorIds = [
    ...new Set(rows.map((r) => r.post?.authorId).filter((v): v is string => Boolean(v))),
  ];
  const names = authorIds.length ? displayNames(authorIds) : new Map<string, string>();

  return rows.map(({ mark, post, board }) => {
    const base = {
      id: mark.id,
      postId: mark.postId,
      folderId: mark.folderId,
      note: mark.note,
      createdAt: mark.createdAt,
    };

    const visible = post ? canSeePost(toVisibilityInfo(post), viewer).visible : false;
    if (!post || !visible) {
      return {
        ...base,
        gone: tombstone(),
        title: null,
        excerpt: null,
        boardName: null,
        authorName: null,
        replyCount: 0,
      };
    }

    return {
      ...base,
      gone: null,
      title: post.title,
      excerpt: post.excerpt,
      boardName: board?.name ?? null,
      // 匿名帖在收藏夹里也得匿名 —— 收藏不是查作者的旁路
      authorName: post.anonymous ? "匿名" : (names.get(post.authorId) ?? "已注销"),
      replyCount: post.replyCount,
    };
  });
}

function displayNames(ids: string[]): Map<string, string> {
  const rows = db
    .select({
      id: users.id,
      wxId: users.wxId,
      siteNickname: users.siteNickname,
      wxNickname: users.wxNickname,
    })
    .from(users)
    .where(inArray(users.id, ids))
    .all();

  const wxIds = rows.map((r) => r.wxId).filter((v): v is string => Boolean(v));
  const profiles = new Map(
    wxIds.length
      ? db
          .select({ wxId: people.wxId, name: people.displayName })
          .from(people)
          .where(inArray(people.wxId, wxIds))
          .all()
          .map((p) => [p.wxId, p.name])
      : [],
  );

  return new Map(
    rows.map((r) => [
      r.id,
      resolveDisplayName([r.siteNickname, r.wxNickname, r.wxId ? profiles.get(r.wxId) : null], {
        wxId: r.wxId,
        fallback: "成员",
      }),
    ]),
  );
}

/** 帖子页那个收藏按钮要知道这条收在哪个夹子里 */
export function bookmarkOf(userId: string, postId: string): { folderId: string | null; note: string | null } | null {
  return (
    db
      .select({ folderId: bookmarks.folderId, note: bookmarks.note })
      .from(bookmarks)
      .where(and(eq(bookmarks.userId, userId), eq(bookmarks.postId, postId)))
      .get() ?? null
  );
}
