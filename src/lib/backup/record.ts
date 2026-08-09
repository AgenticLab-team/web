import "server-only";

import { db } from "@/lib/db";
import { backupRuns } from "@/lib/db/schema";
import type { DrillOutcome } from "@/lib/backup/drill";

/**
 * 把一次本机恢复演练记进 `backup_runs`。
 *
 * 和异地那条走同一张表、同一个 `kind`：后台那一页问的是
 * **「上一次证明备份能用是什么时候」**，而这个问题不该因为
 * 「是本机还是异地」分成两个答案 —— 分开的话，
 * 异地配好之前那一栏永远是空的，看的人会以为从来没演练过。
 *
 * 细节里区分得开：`detail.scope` 写明是哪一种。
 */
export function recordDrill(outcome: DrillOutcome, startedAt: number): void {
  db.insert(backupRuns)
    .values({
      kind: "drill",
      status: outcome.ok ? "success" : "failed",
      files: outcome.file ? 1 : 0,
      bytes: outcome.bytes,
      detail: { scope: "local", file: outcome.file, counts: outcome.counts, note: outcome.note },
      error: outcome.ok ? null : outcome.note,
      startedAt,
      finishedAt: Date.now(),
    })
    .run();
}
