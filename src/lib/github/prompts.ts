import "server-only";

import { and, count, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { githubSharePrompts } from "@/lib/db/schema";

import {
  expiredPromptIds,
  prefillFor,
  type Prefill,
  type PromptKind,
  type SelectedPrompt,
} from "./prompt-rules";

/**
 * 「要不要发个帖」提示的存取。
 *
 * ─────────────────────────────────────────
 * 唯一索引就是「提示过了」这件事本身
 * ─────────────────────────────────────────
 *
 * 写入一律 `onConflictDoNothing()`。(user_id, subject_key) 撞上就丢弃，
 * 而撞上的含义是「这个仓库/这个 PR 我们提过了」——
 * 不管他当时是采纳、拒绝，还是压根没看见。
 *
 * 这样做的好处是**不需要任何一处代码记得去更新「已提示」标记**。
 * 需要记得的东西迟早会漏，而漏掉的表现正是这个功能最怕的那种：
 * 一条已经点过「不用了」的提示，第二天又回来了。
 */

export interface SharePrompt {
  id: string;
  kind: PromptKind;
  subjectKey: string;
  title: string;
  url: string;
  summary: string | null;
  repoFullName: string | null;
  subjectAt: number;
  createdAt: number;
}

/** 这个人已经见过的全部 subjectKey —— 检测时拿它当「跳过清单」 */
export function knownSubjectKeys(userId: string): Set<string> {
  const rows = db
    .select({ key: githubSharePrompts.subjectKey })
    .from(githubSharePrompts)
    .where(eq(githubSharePrompts.userId, userId))
    .all();
  return new Set(rows.map((r) => r.key));
}

export function pendingCount(userId: string): number {
  return (
    db
      .select({ n: count() })
      .from(githubSharePrompts)
      .where(
        and(eq(githubSharePrompts.userId, userId), eq(githubSharePrompts.status, "pending")),
      )
      .get()?.n ?? 0
  );
}

/** 落库。返回真正新写进去的条数（撞唯一索引的不算） */
export function recordPrompts(userId: string, selected: SelectedPrompt[]): number {
  if (selected.length === 0) return 0;

  let inserted = 0;
  db.transaction((tx) => {
    for (const p of selected) {
      const result = tx
        .insert(githubSharePrompts)
        .values({
          userId,
          kind: p.kind,
          subjectKey: p.subjectKey,
          title: p.title.slice(0, 200),
          url: p.url,
          summary: p.summary?.slice(0, 500) ?? null,
          repoFullName: p.repoFullName,
          status: p.status,
          subjectAt: p.subjectAt,
        })
        .onConflictDoNothing()
        .run();
      if (result.changes > 0) inserted++;
    }
  });
  return inserted;
}

/**
 * 到期的收起来。
 *
 * 这一步保证**任何一条提示都有确定的消失时间**。
 * 没有它的话，一条没人理的提示会一直挂着，而它挂着就占着
 * MAX_PENDING 三个名额里的一个 —— 于是新的东西再也进不来，
 * 最后页面上永远是那三条谁也不想看的旧提示。
 */
export function expireStalePrompts(userId: string, now = Date.now()): number {
  const pending = db
    .select({ id: githubSharePrompts.id, createdAt: githubSharePrompts.createdAt })
    .from(githubSharePrompts)
    .where(and(eq(githubSharePrompts.userId, userId), eq(githubSharePrompts.status, "pending")))
    .all();

  const ids = expiredPromptIds(pending, now);
  if (ids.length === 0) return 0;

  db.update(githubSharePrompts)
    .set({ status: "expired", resolvedAt: now })
    .where(inArray(githubSharePrompts.id, ids))
    .run();
  return ids.length;
}

/** 现在该摆出来的那几条。**只查这个人自己的** —— 提示是私事 */
export function listPendingPrompts(userId: string): SharePrompt[] {
  return db
    .select()
    .from(githubSharePrompts)
    .where(and(eq(githubSharePrompts.userId, userId), eq(githubSharePrompts.status, "pending")))
    .orderBy(desc(githubSharePrompts.subjectAt))
    .all()
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      subjectKey: r.subjectKey,
      title: r.title,
      url: r.url,
      summary: r.summary,
      repoFullName: r.repoFullName,
      subjectAt: r.subjectAt,
      createdAt: r.createdAt,
    }));
}

/**
 * 按 id 取一条，**必须同时匹配 userId**。
 *
 * 只按 id 查的话，任何人都能拿别人的提示 id 去发帖页把内容读出来 ——
 * 而提示里带着这个人还没公开的新仓库名。id 是 ULID、猜不到，
 * 但「猜不到」不是访问控制。
 */
export function promptFor(userId: string, id: string): SharePrompt | null {
  const row = db
    .select()
    .from(githubSharePrompts)
    .where(and(eq(githubSharePrompts.id, id), eq(githubSharePrompts.userId, userId)))
    .get();
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    subjectKey: row.subjectKey,
    title: row.title,
    url: row.url,
    summary: row.summary,
    repoFullName: row.repoFullName,
    subjectAt: row.subjectAt,
    createdAt: row.createdAt,
  };
}

export function prefillOf(prompt: SharePrompt): Prefill {
  return prefillFor(prompt);
}

/**
 * 「不用了」。
 *
 * 点完之后这一行留在库里、状态变成 dismissed ——
 * **不删**。删掉的话下一轮检测会发现这个仓库没见过，
 * 于是又提示一遍，而这正是用户刚刚明确说不要的东西。
 */
export function dismissPrompt(userId: string, id: string): boolean {
  const result = db
    .update(githubSharePrompts)
    .set({ status: "dismissed", resolvedAt: Date.now() })
    .where(
      and(
        eq(githubSharePrompts.id, id),
        eq(githubSharePrompts.userId, userId),
        eq(githubSharePrompts.status, "pending"),
      ),
    )
    .run();
  return result.changes > 0;
}

/** 真的发出去了 —— 记下发的哪一篇，以后这条提示不再出现 */
export function markPromptShared(userId: string, id: string, postId: string): boolean {
  const result = db
    .update(githubSharePrompts)
    .set({ status: "shared", postId, resolvedAt: Date.now() })
    .where(and(eq(githubSharePrompts.id, id), eq(githubSharePrompts.userId, userId)))
    .run();
  return result.changes > 0;
}
