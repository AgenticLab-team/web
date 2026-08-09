import "server-only";

import { desc, eq, lt } from "drizzle-orm";

import { db } from "@/lib/db";
import { matrixSnapshots, users } from "@/lib/db/schema";
import { resolveDisplayName } from "@/lib/users/display-name";

import { currentCells } from "./matrix-apply";
import type { CellChange, MatrixState } from "./matrix-edit";

/**
 * 矩阵快照的读写。
 *
 * ─────────────────────────────────────────
 * 能改的东西就得能改回去
 * ─────────────────────────────────────────
 *
 * 矩阵原来是只读的,只读的东西不需要回滚。开放编辑的同一刻
 * 就欠下了这笔债:一次三十格的改动出了问题,
 * 靠审计日志里那三十行文本一格一格点回去,
 * 实际上等于**回不去**。
 *
 * 回滚本身也是一次矩阵改动 —— 走同样的护栏、同样的 diff 预览、
 * 同样再拍一张快照。设置那边就是这么做的（「回滚本身也是一次变更,
 * 同样进历史 —— 历史里不能出现空洞」），这里保持一致。
 */

export type CellMap = Record<string, Record<string, MatrixState>>;

/** 留多少张。矩阵不常改，超过这个数的多半已经没人记得了 */
export const SNAPSHOT_RETENTION = 50;

function serialize(cells: Map<string, Map<string, MatrixState>>): CellMap {
  const out: CellMap = {};
  for (const [roleId, perms] of cells) out[roleId] = Object.fromEntries(perms);
  return out;
}

/**
 * 在改动**之前**拍一张。
 *
 * 顺序很要紧:先拍再改。反过来的话第一次编辑就没有原始状态可回，
 * 而「第一次编辑」恰恰是最可能出错的那一次。
 */
export function takeSnapshot(input: {
  changes: CellChange[];
  summary: string;
  reason: string;
  actorId: string;
  isRollback?: boolean;
}): string {
  const row = db
    .insert(matrixSnapshots)
    .values({
      cells: JSON.stringify(serialize(currentCells())),
      changeCount: input.changes.length,
      changeSummary: input.summary,
      reason: input.reason,
      takenBy: input.actorId,
      isRollback: input.isRollback ?? false,
    })
    .returning({ id: matrixSnapshots.id })
    .get();

  prune();
  return row.id;
}

/**
 * 只留最近的若干张。
 *
 * **按时间删,不按张数偏移删** —— 偏移在并发写入时会漏掉或多删,
 * 而这张表虽然写得少,但漏删的表现是「快照悄悄堆到几千张」,
 * 多删的表现是「想回滚的那张不见了」,后者不可接受。
 */
function prune() {
  const cutoff = db
    .select({ createdAt: matrixSnapshots.createdAt })
    .from(matrixSnapshots)
    .orderBy(desc(matrixSnapshots.createdAt))
    .limit(SNAPSHOT_RETENTION)
    .all()
    .at(-1);

  if (!cutoff) return;
  db.delete(matrixSnapshots).where(lt(matrixSnapshots.createdAt, cutoff.createdAt)).run();
}

export interface SnapshotRow {
  id: string;
  createdAt: number;
  takenByName: string;
  changeCount: number;
  changeSummary: string;
  reason: string;
  isRollback: boolean;
}

export function listSnapshots(limit = 20): SnapshotRow[] {
  const rows = db
    .select()
    .from(matrixSnapshots)
    .orderBy(desc(matrixSnapshots.createdAt))
    .limit(limit)
    .all();

  return rows.map((r) => {
    const u = db.select().from(users).where(eq(users.id, r.takenBy)).get();
    return {
      id: r.id,
      createdAt: r.createdAt,
      takenByName: u
        ? resolveDisplayName([u.siteNickname, u.wxNickname], { wxId: u.wxId })
        : "（已删除）",
      changeCount: r.changeCount,
      changeSummary: r.changeSummary,
      reason: r.reason,
      isRollback: r.isRollback,
    };
  });
}

export function readSnapshot(id: string): CellMap | null {
  const row = db.select().from(matrixSnapshots).where(eq(matrixSnapshots.id, id)).get();
  return row ? (JSON.parse(row.cells) as CellMap) : null;
}

/**
 * 把「回到这张快照」翻译成一串格子改动。
 *
 * ─────────────────────────────────────────
 * 要遍历两边的并集
 * ─────────────────────────────────────────
 *
 * 只遍历快照里的格子,会漏掉**快照之后新增的那些** ——
 * 它们在快照里不存在,于是回滚不会碰它们,
 * 结果是「回滚完了,那条越权的授权还在」。
 *
 * 那是这个功能最坏的失败方式:它报告成功,而问题还在原地,
 * 于是没有人再去查第二遍。
 */
export function changesToRestore(
  snapshot: CellMap,
  current: Map<string, Map<string, MatrixState>>,
  roleName: (roleId: string) => string,
): CellChange[] {
  const changes: CellChange[] = [];
  const roleIds = new Set([...Object.keys(snapshot), ...current.keys()]);

  for (const roleId of roleIds) {
    const want = snapshot[roleId] ?? {};
    const have = current.get(roleId) ?? new Map<string, MatrixState>();
    const keys = new Set([...Object.keys(want), ...have.keys()]);

    for (const key of keys) {
      const to = want[key] ?? "none";
      const from = have.get(key) ?? "none";
      if (from === to) continue;
      changes.push({ roleId, roleName: roleName(roleId), permissionKey: key, from, to });
    }
  }

  return changes.sort(
    (a, b) =>
      a.roleName.localeCompare(b.roleName, "zh") || a.permissionKey.localeCompare(b.permissionKey),
  );
}
