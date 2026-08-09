import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { drafts } from "@/lib/db/schema";

import { checkConflict, checkDraft, draftKey, type DraftTarget } from "./draft-rules";

/**
 * 服务端草稿的读写。
 *
 * ─────────────────────────────────────────
 * 草稿只有本人碰得到
 * ─────────────────────────────────────────
 *
 * 它是**还没发表的东西**。已发表的内容有可见性规则、有版主、有审计；
 * 草稿一样都没有 —— 它甚至可能是一句写到一半就决定不发的话。
 *
 * 所以这一层没有任何「按 id 取草稿」的签名，
 * 每个函数的第一个参数都是 userId，where 里也都带着它。
 * 没有那种签名，后台就没有地方能把它渲染出来。
 */

export interface DraftRow {
  content: string;
  title: string | null;
  updatedAt: number;
}

export function getDraft(
  userId: string,
  target: DraftTarget,
  scope: string,
): DraftRow | null {
  const row = db
    .select({ content: drafts.content, title: drafts.title, updatedAt: drafts.updatedAt })
    .from(drafts)
    .where(
      and(
        eq(drafts.userId, userId),
        eq(drafts.targetType, target),
        eq(drafts.targetId, draftKey({ target, scope })),
      ),
    )
    .get();

  return row ?? null;
}

export type SaveResult =
  | { ok: true; updatedAt: number }
  | { ok: true; discarded: true }
  | { ok: false; reason: string; server?: DraftRow };

/**
 * 存一次。
 *
 * `base` 是客户端手上那份的 updatedAt —— 服务器上更新就拒绝，
 * 并把服务器那份原样退回去。**不合并**：两段自由文本没有正确的
 * 自动合并方式，机器一合就是把两句话搅在一起，比丢掉一份更糟。
 */
export function saveDraft(input: {
  userId: string;
  target: DraftTarget;
  scope: string;
  boardId?: string | null;
  title?: string | null;
  content: string;
  base: number;
  now?: number;
}): SaveResult {
  const shape = checkDraft({ title: input.title, content: input.content });
  if (!shape.ok) return { ok: false, reason: shape.reason };

  const targetId = draftKey({ target: input.target, scope: input.scope });
  const existing = db
    .select({ id: drafts.id, content: drafts.content, title: drafts.title, updatedAt: drafts.updatedAt })
    .from(drafts)
    .where(
      and(
        eq(drafts.userId, input.userId),
        eq(drafts.targetType, input.target),
        eq(drafts.targetId, targetId),
      ),
    )
    .get();

  if ("discard" in shape) {
    /*
     * 清空 = 删掉这份草稿。
     *
     * 但**清空也要过冲突判定** —— 否则「在手机上把内容全选删掉」
     * 会直接抹掉电脑上刚写的那份，而这是最不该被静默执行的一种操作。
     */
    const verdict = checkConflict({ serverUpdatedAt: existing?.updatedAt ?? null, base: input.base });
    if (!verdict.ok) {
      return { ok: false, reason: verdict.reason, server: existing ?? undefined };
    }
    if (existing) db.delete(drafts).where(eq(drafts.id, existing.id)).run();
    return { ok: true, discarded: true };
  }

  const verdict = checkConflict({ serverUpdatedAt: existing?.updatedAt ?? null, base: input.base });
  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason, server: existing ?? undefined };
  }

  const now = input.now ?? Date.now();

  if (existing) {
    db.update(drafts)
      .set({ content: shape.content, title: shape.title, boardId: input.boardId ?? null, updatedAt: now })
      .where(eq(drafts.id, existing.id))
      .run();
  } else {
    db.insert(drafts)
      .values({
        userId: input.userId,
        targetType: input.target,
        targetId,
        boardId: input.boardId ?? null,
        title: shape.title,
        content: shape.content,
        updatedAt: now,
      })
      .run();
  }

  return { ok: true, updatedAt: now };
}

/**
 * 发出去之后把草稿删掉。
 *
 * 不删的话，下次点「发帖」会把**已经发表过的内容**当草稿恢复出来 ——
 * 而人多半会以为上次没发成功，于是再发一遍。
 */
export function dropDraft(userId: string, target: DraftTarget, scope: string): void {
  db.delete(drafts)
    .where(
      and(
        eq(drafts.userId, userId),
        eq(drafts.targetType, target),
        eq(drafts.targetId, draftKey({ target, scope })),
      ),
    )
    .run();
}

export interface DraftListItem {
  target: DraftTarget;
  targetId: string;
  title: string | null;
  /** 正文头一段，用来认出这是哪一篇 */
  excerpt: string;
  boardId: string | null;
  updatedAt: number;
}

/** 我所有没写完的东西 */
export function listDrafts(userId: string): DraftListItem[] {
  return db
    .select({
      target: drafts.targetType,
      targetId: drafts.targetId,
      title: drafts.title,
      content: drafts.content,
      boardId: drafts.boardId,
      updatedAt: drafts.updatedAt,
    })
    .from(drafts)
    .where(eq(drafts.userId, userId))
    .orderBy(desc(drafts.updatedAt))
    .all()
    .map((row) => ({
      target: row.target,
      targetId: row.targetId ?? "",
      title: row.title,
      // 只截一小段：这一页是用来「认出是哪篇」的，不是用来读的
      excerpt: row.content.replace(/\s+/g, " ").slice(0, 80),
      boardId: row.boardId,
      updatedAt: row.updatedAt,
    }));
}

export function draftCount(userId: string): number {
  return db.select({ id: drafts.id }).from(drafts).where(eq(drafts.userId, userId)).all().length;
}
