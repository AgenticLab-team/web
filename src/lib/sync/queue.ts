import "server-only";

import { and, asc, eq, inArray, lt } from "drizzle-orm";

import { db } from "@/lib/db";
import { syncJobs } from "@/lib/db/schema";

/**
 * 手动触发的同步队列。
 *
 * 后台的「立即同步」只往 sync_jobs 里排一条 pending，
 * 真正执行由同步进程在下一轮开始时取走 ——
 * 在 web 请求里直接跑同步的话，请求超时会把跑到一半的任务丢下，
 * 而游标已经动过了，那一段消息就永远补不回来。
 *
 * ⚠️ **没有这个消费者的话，「立即同步」按钮是个谎**：
 * 排进去的 pending 永远不会被执行，而且因为「有任务在跑就不能再触发」
 * 的判定会把 pending 也算进去，**点一次之后所有触发都会被永久挡住**。
 * 这个文件就是那个消费者。
 */

/**
 * 跑了这么久还没结束的，认为是上一次进程崩溃留下的尸体。
 *
 * 这不是假设 —— 实测就会发生：同步进程被 SIGPIPE 之类杀掉时
 * （比如 `npm run sync | head` 里 head 先退出），
 * runSyncJob 已经插了 running 那一行，但永远等不到收尾。
 *
 * 导出这个判定是为了让**「有没有任务在跑」和「清理尸体」用同一把尺** ——
 * 两处各写一个阈值的话，界面会因为一具尸体把触发按钮锁死，
 * 而清理逻辑却认为它还活着。
 */
export const STALE_RUNNING_MS = 30 * 60_000;

export function isStaleRunning(
  job: { status: string; startedAt: number | null },
  now: number,
): boolean {
  if (job.status !== "running") return false;
  // 没有 startedAt 的 running 是坏数据，当作尸体处理
  if (job.startedAt === null) return true;
  return now - job.startedAt > STALE_RUNNING_MS;
}

export interface QueuedJob {
  id: string;
  kind: string;
  scope: string | null;
  retryCount: number;
  triggeredByUser: string | null;
}

/**
 * 取走所有待执行的任务。
 *
 * 取的同时就标成 running —— 中间不留窗口，
 * 否则两个进程会同时取到同一批。
 */
export function claimPending(now = Date.now()): QueuedJob[] {
  // 先清掉僵死的 running：进程崩溃时它们会一直挂着，把队列堵死
  db.update(syncJobs)
    .set({
      status: "failed",
      error: "进程中断，任务未完成",
      finishedAt: now,
    })
    .where(and(eq(syncJobs.status, "running"), lt(syncJobs.startedAt, now - STALE_RUNNING_MS)))
    .run();

  const pending = db
    .select()
    .from(syncJobs)
    .where(eq(syncJobs.status, "pending"))
    .orderBy(asc(syncJobs.createdAt))
    .all();

  if (pending.length === 0) return [];

  db.update(syncJobs)
    .set({ status: "running", startedAt: now })
    .where(
      inArray(
        syncJobs.id,
        pending.map((j) => j.id),
      ),
    )
    .run();

  return pending.map((j) => ({
    id: j.id,
    kind: j.kind,
    scope: j.scope,
    retryCount: j.retryCount,
    triggeredByUser: j.triggeredByUser,
  }));
}

export function completeJob(
  id: string,
  result: { fetched: number; written: number; error?: string },
  now = Date.now(),
) {
  const job = db.select().from(syncJobs).where(eq(syncJobs.id, id)).get();

  db.update(syncJobs)
    .set({
      status: result.error ? "failed" : "success",
      finishedAt: now,
      durationMs: job?.startedAt ? now - job.startedAt : null,
      itemsFetched: result.fetched,
      itemsWritten: result.written,
      error: result.error ?? null,
    })
    .where(eq(syncJobs.id, id))
    .run();
}

/**
 * 把队列里的任务折叠成「要跑哪些活」。
 *
 * 同一个 kind+scope 排了五次只需要跑一次 ——
 * 管理员连点五下「立即同步」是很常见的，
 * 老老实实跑五遍只会让上游多挨五次请求。
 */
export function collapseJobs(jobs: readonly QueuedJob[]): Map<string, QueuedJob[]> {
  const byTarget = new Map<string, QueuedJob[]>();
  for (const job of jobs) {
    const key = `${job.kind}:${job.scope ?? ""}`;
    const list = byTarget.get(key) ?? [];
    list.push(job);
    byTarget.set(key, list);
  }
  return byTarget;
}
