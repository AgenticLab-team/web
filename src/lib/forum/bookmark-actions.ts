"use server";

import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { assertNotPreviewing, getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { bookmarkFolders, bookmarks } from "@/lib/db/schema";

import { checkFolderCount, checkFolderName, checkNote } from "./bookmark-rules";

/**
 * 收藏夹的写入层。
 *
 * ─────────────────────────────────────────
 * 每一个动作都要先确认这一行是自己的
 * ─────────────────────────────────────────
 *
 * 收藏夹 id 和收藏 id 都是 ULID，会出现在客户端。
 * 只按 id 更新的话，改一下请求里的 id 就能重命名别人的收藏夹、
 * 把别人的收藏挪走 —— 这类接口的水位线就是**每一条 where 都带 userId**。
 *
 * 所以下面所有 where 都是 `and(eq(id), eq(userId))`，
 * 一个都不能省，`tests/bookmarks.test.ts` 会逐个数。
 */

export interface Result {
  ok: boolean;
  error?: string;
  id?: string;
}

const fail = (error: string): Result => ({ ok: false, error });

export async function createFolder(name: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  const existing = db
    .select({ name: bookmarkFolders.name })
    .from(bookmarkFolders)
    .where(eq(bookmarkFolders.userId, user.id))
    .all();

  const room = checkFolderCount(existing.length);
  if (!room.ok) return fail(room.reason);

  const verdict = checkFolderName(name, existing.map((f) => f.name));
  if (!verdict.ok) return fail(verdict.reason);

  const sort = Number(
    db
      .select({ max: sql<number>`coalesce(max(${bookmarkFolders.sort}), -1)` })
      .from(bookmarkFolders)
      .where(eq(bookmarkFolders.userId, user.id))
      .get()?.max ?? -1,
  );

  const row = db
    .insert(bookmarkFolders)
    .values({ userId: user.id, name: verdict.name, sort: sort + 1 })
    .returning({ id: bookmarkFolders.id })
    .get();

  revalidatePath("/me/bookmarks");
  return { ok: true, id: row.id };
}

export async function renameFolder(folderId: string, name: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  const others = db
    .select({ id: bookmarkFolders.id, name: bookmarkFolders.name })
    .from(bookmarkFolders)
    .where(eq(bookmarkFolders.userId, user.id))
    .all();

  if (!others.some((f) => f.id === folderId)) return fail("收藏夹不存在");

  // 重名检查要排掉自己 —— 否则「改了个错别字又改回来」会被自己挡住
  const verdict = checkFolderName(name, others.filter((f) => f.id !== folderId).map((f) => f.name));
  if (!verdict.ok) return fail(verdict.reason);

  db.update(bookmarkFolders)
    .set({ name: verdict.name })
    .where(and(eq(bookmarkFolders.id, folderId), eq(bookmarkFolders.userId, user.id)))
    .run();

  revalidatePath("/me/bookmarks");
  return { ok: true };
}

/**
 * 删收藏夹 —— **里面的收藏挪回未分组，一条都不删**。
 *
 * 「连内容一起删」会让一次手滑毁掉攒了很久的东西，
 * 而收藏没有回收站。删除一个分类不该毁掉被分类的内容。
 */
export async function deleteFolder(folderId: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  const folder = db
    .select({ id: bookmarkFolders.id })
    .from(bookmarkFolders)
    .where(and(eq(bookmarkFolders.id, folderId), eq(bookmarkFolders.userId, user.id)))
    .get();
  if (!folder) return fail("收藏夹不存在");

  db.transaction((tx) => {
    tx.update(bookmarks)
      .set({ folderId: null })
      .where(and(eq(bookmarks.folderId, folderId), eq(bookmarks.userId, user.id)))
      .run();
    tx.delete(bookmarkFolders)
      .where(and(eq(bookmarkFolders.id, folderId), eq(bookmarkFolders.userId, user.id)))
      .run();
  });

  revalidatePath("/me/bookmarks");
  return { ok: true };
}

/** folderId 传 null = 挪回未分组 */
export async function moveBookmark(bookmarkId: string, folderId: string | null): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  if (folderId !== null) {
    const folder = db
      .select({ id: bookmarkFolders.id })
      .from(bookmarkFolders)
      .where(and(eq(bookmarkFolders.id, folderId), eq(bookmarkFolders.userId, user.id)))
      .get();
    // 目标夹子也要验归属，否则能把自己的收藏塞进别人的夹子里
    if (!folder) return fail("收藏夹不存在");
  }

  const changed = db
    .update(bookmarks)
    .set({ folderId })
    .where(and(eq(bookmarks.id, bookmarkId), eq(bookmarks.userId, user.id)))
    .run();
  if (changed.changes === 0) return fail("收藏不存在");

  revalidatePath("/me/bookmarks");
  return { ok: true };
}

/** 按帖子 id 归类 —— 帖子页那个收藏按钮用得上，它手里没有收藏行的 id */
export async function moveBookmarkByPost(postId: string, folderId: string | null): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const mark = db
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, user.id), eq(bookmarks.postId, postId)))
    .get();
  if (!mark) return fail("还没有收藏这个帖子");

  const result = await moveBookmark(mark.id, folderId);
  if (result.ok) revalidatePath(`/forum/p/${postId}`);
  return result;
}

export async function setBookmarkNote(bookmarkId: string, note: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  const verdict = checkNote(note);
  if (!verdict.ok) return fail(verdict.reason);

  const changed = db
    .update(bookmarks)
    .set({ note: verdict.note })
    .where(and(eq(bookmarks.id, bookmarkId), eq(bookmarks.userId, user.id)))
    .run();
  if (changed.changes === 0) return fail("收藏不存在");

  revalidatePath("/me/bookmarks");
  return { ok: true };
}

/**
 * 从收藏夹里移除。
 *
 * 帖子页那个按钮是切换语义，而这一页要的是明确的「移除」——
 * 在列表里用切换语义，误点一下就变成又收藏了一次，
 * 而那一条会跳回列表最前面（按收藏时间倒序），看起来像它自己动了。
 */
export async function removeBookmark(bookmarkId: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  const changed = db
    .delete(bookmarks)
    .where(and(eq(bookmarks.id, bookmarkId), eq(bookmarks.userId, user.id)))
    .run();
  if (changed.changes === 0) return fail("收藏不存在");

  revalidatePath("/me/bookmarks");
  return { ok: true };
}

/** 收藏夹排序：整批提交，避免一次拖动发好几个请求还得考虑先后 */
export async function reorderFolders(ids: string[]): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  const mine = new Set(
    db
      .select({ id: bookmarkFolders.id })
      .from(bookmarkFolders)
      .where(eq(bookmarkFolders.userId, user.id))
      .all()
      .map((f) => f.id),
  );
  if (ids.some((id) => !mine.has(id))) return fail("收藏夹不存在");

  db.transaction((tx) => {
    ids.forEach((id, i) => {
      tx.update(bookmarkFolders)
        .set({ sort: i })
        .where(and(eq(bookmarkFolders.id, id), eq(bookmarkFolders.userId, user.id)))
        .run();
    });
  });

  revalidatePath("/me/bookmarks");
  return { ok: true };
}

/** 清掉所有已经看不到的那些 —— 一条条点太累 */
export async function clearGoneBookmarks(goneIds: string[]): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();
  if (goneIds.length === 0) return { ok: true };

  db.transaction((tx) => {
    for (const id of goneIds) {
      tx.delete(bookmarks)
        .where(and(eq(bookmarks.id, id), eq(bookmarks.userId, user.id)))
        .run();
    }
  });

  revalidatePath("/me/bookmarks");
  return { ok: true };
}

/** 未分组还剩多少 —— 归类之后要更新那一格的数字 */
export async function unsortedRemaining(): Promise<number> {
  const user = await getCurrentUser();
  if (!user) return 0;
  return Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(bookmarks)
      .where(and(eq(bookmarks.userId, user.id), isNull(bookmarks.folderId)))
      .get()?.n ?? 0,
  );
}
