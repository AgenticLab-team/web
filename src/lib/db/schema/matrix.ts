import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 权限矩阵的快照。
 *
 * ─────────────────────────────────────────
 * 存的是「改动之前」的样子
 * ─────────────────────────────────────────
 *
 * 每次保存矩阵之前先拍一张。所以第一次编辑会顺手留下一张
 * **原始状态**的快照 —— 不需要另外去种一个基线，
 * 而基线这种东西一旦要靠迁移脚本去种，就一定会有环境漏掉。
 *
 * 「回到某张快照」的语义因此很直白：回到那次改动发生之前。
 *
 * ─────────────────────────────────────────
 * 为什么不能靠审计日志回滚
 * ─────────────────────────────────────────
 *
 * 审计日志里存的是 `版主/forum.view=granted` 这样的字符串，
 * 给人读的。要靠它还原，得把字符串解析回三态、还得假设中间
 * 没有别的改动插进来 —— 而一次三十格的改动出了问题时，
 * 没有人有耐心去核对三十行文本。
 *
 * 快照存的是**整张表**，所以恢复不依赖中间发生过什么。
 */
export const matrixSnapshots = sqliteTable(
  "matrix_snapshots",
  {
    id: ulidPk(),
    /** JSON：roleId -> permissionKey -> "granted" | "denied" */
    cells: text("cells").notNull(),
    /** 拍这张快照时，紧接着要做的那次改动是什么 */
    changeCount: integer("change_count").notNull(),
    changeSummary: text("change_summary").notNull(),
    reason: text("reason").notNull(),
    takenBy: text("taken_by").notNull(),
    /** 这次改动是不是一次回滚 —— 回滚本身也是一次变更，同样留痕 */
    isRollback: integer("is_rollback", { mode: "boolean" }).notNull().default(false),
    createdAt: now("created_at"),
  },
  (t) => [index("matrix_snapshots_time_idx").on(t.createdAt)],
);
