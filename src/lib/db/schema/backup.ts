import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 异地备份的每一次动作。
 *
 * 失败的也要留下 —— 备份最常见的失败方式是「一直在成功」，
 * 而分辨「没跑」和「跑了但失败」的唯一办法是两种都留痕。
 */
export const backupRuns = sqliteTable(
  "backup_runs",
  {
    id: ulidPk(),

    /**
     * upload = 传新文件
     * verify = **读回来对哈希**（上传返回 200 不等于对面有那个文件）
     * drill  = 恢复演练：真的下载、解压、打开、数行
     */
    kind: text("kind", { enum: ["upload", "verify", "drill"] }).notNull(),
    status: text("status", { enum: ["success", "failed", "skipped"] }).notNull(),

    /** 传了几个文件 / 验了几个对象 */
    files: integer("files").notNull().default(0),
    bytes: integer("bytes").notNull().default(0),

    /** 演练时读出来的关键表行数，用来和本地对照 */
    detail: text("detail", { mode: "json" }),
    error: text("error"),

    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    createdAt: now("created_at"),
  },
  (t) => [index("backup_runs_kind_idx").on(t.kind, t.status, t.createdAt)],
);
