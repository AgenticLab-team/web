import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { syncJobs } from "@/lib/db/schema";

export type SyncKind =
  | "conversations"
  | "messages"
  | "members"
  | "avatars"
  | "friend_requests"
  | "leaderboard";

export interface SyncResult {
  fetched: number;
  written: number;
  note?: string;
}

export interface SyncOptions {
  triggeredBy?: "cron" | "admin" | "api" | "boot";
  triggeredByUser?: string;
  scope?: string;
}

/**
 * 包一层，保证每一次同步都在 sync_jobs 留下记录 ——
 * 拉了多少、写了多少、失败原因是什么。数据不对时看这张表，而不是猜。
 */
export async function runSyncJob(
  kind: SyncKind,
  options: SyncOptions,
  fn: () => Promise<SyncResult>,
): Promise<SyncResult> {
  const startedAt = Date.now();
  const job = db
    .insert(syncJobs)
    .values({
      kind,
      scope: options.scope,
      status: "running",
      startedAt,
      triggeredBy: options.triggeredBy ?? "cron",
      triggeredByUser: options.triggeredByUser,
    })
    .returning({ id: syncJobs.id })
    .get();

  try {
    const result = await fn();
    const finishedAt = Date.now();
    db.update(syncJobs)
      .set({
        status: "success",
        finishedAt,
        durationMs: finishedAt - startedAt,
        itemsFetched: result.fetched,
        itemsWritten: result.written,
        error: result.note,
      })
      .where(eq(syncJobs.id, job.id))
      .run();
    return result;
  } catch (err) {
    const finishedAt = Date.now();
    db.update(syncJobs)
      .set({
        status: "failed",
        finishedAt,
        durationMs: finishedAt - startedAt,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      })
      .where(eq(syncJobs.id, job.id))
      .run();
    throw err;
  }
}
