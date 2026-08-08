"use server";

import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/admin/guard";
import {
  checkBoardConfig,
  checkBoardDelete,
  checkBoardKey,
  checkTagMerge,
  postsAboveCap,
  postsToRelink,
  wouldCreateCycle,
} from "@/lib/admin/board-rules";
import { boardParents, orphanTags, postIdsOfTag } from "@/lib/admin/boards";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { boards, postTags, posts, tags } from "@/lib/db/schema";
import type { Visibility } from "@/lib/db/schema/forum";
import { recountBoardPosts } from "@/lib/forum/board-stats";
import { slugify } from "@/lib/forum/tags-queries";

/**
 * 版块与标签的写操作。
 *
 * 判定全在 board-rules.ts 里（纯函数、可单测），这里只取数据、落库、留痕。
 *
 * 有一条贯穿始终：**改配置也是对别人内容的操作**。
 * 收紧可见性上限会让已经发出去的帖子从别人眼前消失，
 * 所以这类改动同样要理由、同样进审计日志。
 */

export interface BoardResult {
  ok: boolean;
  error?: string;
  id?: string;
}

const fail = (error: string): BoardResult => ({ ok: false, error });

export async function createBoard(input: {
  key: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  parentId?: string;
  visibleTo: Visibility;
  defaultVisibility: Visibility;
  maxVisibility: Visibility;
  postMinLevel: number;
  reason: string;
}): Promise<BoardResult> {
  const admin = await requireAdmin("forum.board.manage");

  const keyCheck = checkBoardKey(input.key);
  if (!keyCheck.ok) return fail(keyCheck.error!);

  const configCheck = checkBoardConfig(input);
  if (!configCheck.ok) return fail(configCheck.error!);

  const clash = db.select().from(boards).where(eq(boards.key, input.key)).get();
  if (clash) return fail("这个版块标识已经用过了");

  const row = db
    .insert(boards)
    .values({
      key: input.key,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      icon: input.icon || null,
      color: input.color || null,
      parentId: input.parentId || null,
      visibleTo: input.visibleTo,
      defaultVisibility: input.defaultVisibility,
      maxVisibility: input.maxVisibility,
      postMinLevel: input.postMinLevel,
      createdBy: admin.user.id,
    })
    .returning({ id: boards.id })
    .get();

  audit({ actorId: admin.user.id }, {
    action: "forum.board.manage",
    targetType: "board",
    targetId: row.id,
    targetLabel: input.name,
    after: { key: input.key, maxVisibility: input.maxVisibility },
    reason: input.reason,
  });

  revalidatePath("/admin/boards");
  revalidatePath("/forum");
  return { ok: true, id: row.id };
}

export async function updateBoard(input: {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  parentId?: string | null;
  visibleTo: Visibility;
  defaultVisibility: Visibility;
  maxVisibility: Visibility;
  postMinLevel: number;
  locked?: boolean;
  reason: string;
}): Promise<BoardResult> {
  const admin = await requireAdmin("forum.board.manage");

  const before = db.select().from(boards).where(eq(boards.id, input.id)).get();
  if (!before) return fail("版块不存在");

  // key 不给改：它在 URL 里，改了等于把所有旧链接作废
  const configCheck = checkBoardConfig({ ...input, key: before.key });
  if (!configCheck.ok) return fail(configCheck.error!);

  if (wouldCreateCycle(input.id, input.parentId ?? null, boardParents())) {
    return fail("这样会让版块层级成环");
  }

  if (!input.reason.trim()) return fail("必须填写理由");

  db.update(boards)
    .set({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      icon: input.icon || null,
      color: input.color || null,
      parentId: input.parentId ?? null,
      visibleTo: input.visibleTo,
      defaultVisibility: input.defaultVisibility,
      maxVisibility: input.maxVisibility,
      postMinLevel: input.postMinLevel,
      locked: input.locked ?? before.locked,
      updatedAt: Date.now(),
    })
    .where(eq(boards.id, input.id))
    .run();

  /*
   * 上限收紧后要把超出的帖子降下来。
   *
   * 只改版块配置而不动帖子的话，封顶就成了摆设 ——
   * 帖子表里存的还是 public，任何直接读 posts.visibility 的地方
   * （检索、RSS、外链预览）都会照旧放行。
   */
  let downgraded = 0;
  if (before.maxVisibility !== input.maxVisibility) {
    downgraded = applyCap(input.id, input.maxVisibility);
  }

  audit({ actorId: admin.user.id }, {
    action: "forum.board.manage",
    targetType: "board",
    targetId: input.id,
    targetLabel: input.name,
    before: {
      name: before.name,
      visibleTo: before.visibleTo,
      maxVisibility: before.maxVisibility,
      postMinLevel: before.postMinLevel,
    },
    after: {
      name: input.name,
      visibleTo: input.visibleTo,
      maxVisibility: input.maxVisibility,
      postMinLevel: input.postMinLevel,
      downgraded,
    },
    reason: input.reason,
  });

  revalidatePath("/admin/boards");
  revalidatePath("/forum");
  return { ok: true };
}

/** 把超出上限的帖子降到上限。返回改了几篇 */
function applyCap(boardId: string, max: Visibility): number {
  const rows = db
    .select({ id: posts.id, visibility: posts.visibility })
    .from(posts)
    .where(and(eq(posts.boardId, boardId), isNull(posts.deletedAt)))
    .all();

  const over = postsAboveCap(rows, max);
  for (const post of over) {
    db.update(posts).set({ visibility: max, updatedAt: Date.now() }).where(eq(posts.id, post.id)).run();
  }
  return over.length;
}

export async function deleteBoard(input: {
  id: string;
  moveTo?: string;
  reason: string;
}): Promise<BoardResult> {
  const admin = await requireAdmin("forum.board.manage");

  if (!input.reason.trim()) return fail("必须填写理由");

  const board = db.select().from(boards).where(eq(boards.id, input.id)).get();
  if (!board) return fail("版块不存在");

  const postCount = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(posts)
      .where(and(eq(posts.boardId, input.id), isNull(posts.deletedAt), ne(posts.status, "deleted")))
      .get()?.n ?? 0,
  );

  const childCount = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(boards)
      .where(and(eq(boards.parentId, input.id), isNull(boards.deletedAt)))
      .get()?.n ?? 0,
  );

  const check = checkBoardDelete({
    postCount,
    childCount,
    moveTo: input.moveTo ?? null,
    boardId: input.id,
  });
  if (!check.ok) return fail(check.error!);

  if (input.moveTo) {
    const target = db.select().from(boards).where(eq(boards.id, input.moveTo)).get();
    if (!target) return fail("目标版块不存在");
  }

  db.transaction((tx) => {
    if (input.moveTo) {
      tx.update(posts).set({ boardId: input.moveTo }).where(eq(posts.boardId, input.id)).run();
    }
    // 软删除：真删的话，历史审计日志和通知里的链接会指向不存在的东西
    tx.update(boards).set({ deletedAt: Date.now() }).where(eq(boards.id, input.id)).run();
  });

  if (input.moveTo) {
    recountBoardPosts(input.moveTo);
    recountBoardPosts(input.id);
  }

  audit({ actorId: admin.user.id }, {
    action: "forum.board.manage",
    targetType: "board",
    targetId: input.id,
    targetLabel: board.name,
    before: { key: board.key, posts: postCount },
    after: { deleted: true, movedTo: input.moveTo ?? null },
    reason: input.reason,
  });

  revalidatePath("/admin/boards");
  revalidatePath("/forum");
  return { ok: true };
}

export async function reorderBoard(input: { id: string; sort: number }): Promise<BoardResult> {
  const admin = await requireAdmin("forum.board.manage");
  db.update(boards).set({ sort: input.sort, updatedAt: Date.now() }).where(eq(boards.id, input.id)).run();

  audit({ actorId: admin.user.id }, {
    action: "forum.board.manage",
    targetType: "board",
    targetId: input.id,
    after: { sort: input.sort },
  });

  revalidatePath("/admin/boards");
  revalidatePath("/forum");
  return { ok: true };
}

// ── 标签 ──────────────────────────────────────────────────────

export async function mergeTags(input: {
  fromId: string;
  toId: string;
  reason: string;
}): Promise<BoardResult> {
  const admin = await requireAdmin("forum.tag.manage");

  if (!input.reason.trim()) return fail("必须填写理由");

  const from = db.select().from(tags).where(eq(tags.id, input.fromId)).get();
  const to = db.select().from(tags).where(eq(tags.id, input.toId)).get();
  if (!from || !to) return fail("标签不存在");

  const check = checkTagMerge({
    fromId: input.fromId,
    toId: input.toId,
    fromLocked: from.locked,
  });
  if (!check.ok) return fail(check.error!);

  /*
   * 两个标签都有的帖子只保留一条关联。
   * 不去重的话唯一索引会直接报错、整次合并回滚 ——
   * 而「有帖子同时打了这两个标签」恰恰是最该合并的信号。
   */
  const { relink, dropDuplicate } = postsToRelink(
    postIdsOfTag(input.fromId),
    postIdsOfTag(input.toId),
  );

  db.transaction((tx) => {
    for (const postId of relink) {
      tx.update(postTags)
        .set({ tagId: input.toId })
        .where(and(eq(postTags.postId, postId), eq(postTags.tagId, input.fromId)))
        .run();
    }
    for (const postId of dropDuplicate) {
      tx.delete(postTags)
        .where(and(eq(postTags.postId, postId), eq(postTags.tagId, input.fromId)))
        .run();
    }
    tx.delete(tags).where(eq(tags.id, input.fromId)).run();
  });

  recountTag(input.toId);

  audit({ actorId: admin.user.id }, {
    action: "forum.tag.manage",
    targetType: "tag",
    targetId: input.toId,
    targetLabel: to.name,
    before: { merged: from.name },
    after: { relinked: relink.length, deduped: dropDuplicate.length },
    reason: input.reason,
  });

  revalidatePath("/admin/boards");
  return { ok: true };
}

export async function renameTag(input: {
  id: string;
  name: string;
  reason: string;
}): Promise<BoardResult> {
  const admin = await requireAdmin("forum.tag.manage");

  const name = input.name.trim();
  if (!name) return fail("标签名不能为空");
  if (!input.reason.trim()) return fail("必须填写理由");

  const tag = db.select().from(tags).where(eq(tags.id, input.id)).get();
  if (!tag) return fail("标签不存在");

  const slug = slugify(name);
  if (!slug) return fail("这个名字归一化之后是空的，换一个");

  const clash = db.select().from(tags).where(eq(tags.slug, slug)).get();
  if (clash && clash.id !== input.id) {
    return fail(`已经有一个标签归一化后也是「${slug}」，请改用合并`);
  }

  db.update(tags).set({ name, slug }).where(eq(tags.id, input.id)).run();

  audit({ actorId: admin.user.id }, {
    action: "forum.tag.manage",
    targetType: "tag",
    targetId: input.id,
    before: { name: tag.name, slug: tag.slug },
    after: { name, slug },
    reason: input.reason,
  });

  revalidatePath("/admin/boards");
  return { ok: true };
}

export async function setTagLocked(input: { id: string; locked: boolean }): Promise<BoardResult> {
  const admin = await requireAdmin("forum.tag.manage");
  db.update(tags).set({ locked: input.locked }).where(eq(tags.id, input.id)).run();

  audit({ actorId: admin.user.id }, {
    action: "forum.tag.manage",
    targetType: "tag",
    targetId: input.id,
    after: { locked: input.locked },
  });

  revalidatePath("/admin/boards");
  return { ok: true };
}

/** 清理没有任何帖子在用的标签。锁定的不动 —— 那往往是预留的官方标签 */
export async function cleanupTags(input: { reason: string }): Promise<BoardResult> {
  const admin = await requireAdmin("forum.tag.manage");
  if (!input.reason.trim()) return fail("必须填写理由");

  const orphans = orphanTags();
  if (orphans.length === 0) return fail("没有需要清理的标签");

  db.transaction((tx) => {
    for (const tag of orphans) {
      tx.delete(tags).where(eq(tags.id, tag.id)).run();
    }
  });

  audit({ actorId: admin.user.id }, {
    action: "forum.tag.manage",
    targetType: "tag",
    targetId: "*",
    after: { removed: orphans.map((t) => t.name).slice(0, 20), count: orphans.length },
    reason: input.reason,
  });

  revalidatePath("/admin/boards");
  return { ok: true };
}

function recountTag(tagId: string) {
  const n = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(postTags)
      .innerJoin(posts, eq(posts.id, postTags.postId))
      .where(and(eq(postTags.tagId, tagId), isNull(posts.deletedAt), ne(posts.status, "deleted")))
      .get()?.n ?? 0,
  );
  db.update(tags).set({ postCount: n }).where(eq(tags.id, tagId)).run();
}
