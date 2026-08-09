"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin, requireWritableAdmin } from "@/lib/admin/guard";
import type { CurrentUser } from "@/lib/auth/session";

import { effectivePermissions } from "./can";
import {
  actorPriority,
  applyMatrixChange,
  currentCells,
  keystoneHoldersAfter,
  previewMatrixChange,
  rolePriorities,
} from "./matrix-apply";
import { diffCells, guardrailErrors, type MatrixDiff, type MatrixState } from "./matrix-edit";
import { roleNameMap } from "./matrix-queries";
import { changesToRestore, readSnapshot, takeSnapshot } from "./matrix-snapshots";

export interface MatrixEditInput {
  cells: { roleId: string; permissionKey: string; state: MatrixState }[];
  reason: string;
}

export type MatrixEditResult =
  | { ok: true; diff: MatrixDiff; applied: boolean }
  | { ok: false; errors: string[] };

/**
 * 预演一次矩阵改动 —— **不写库**。
 *
 * 单独一个 action 而不是「保存时顺便返回 diff」,
 * 是因为这两件事的失败方式不一样:预演失败最多是看不到后果,
 * 保存失败可能留下一半生效的矩阵。分开之后,人先看后果再决定。
 */
export async function previewMatrixEdit(input: MatrixEditInput): Promise<MatrixEditResult> {
  const admin = await requireAdmin("role.manage");
  return evaluate(input, admin.user, false);
}

/** 真的保存 */
export async function saveMatrixEdit(input: MatrixEditInput): Promise<MatrixEditResult> {
  const admin = await requireWritableAdmin("role.manage");
  const result = await evaluate(input, admin.user, true);
  if (result.ok) revalidatePath("/admin/roles");
  return result;
}

/**
 * 校验与预演走同一条路。
 *
 * **保存时要重跑一遍全部护栏**,不能因为「预览的时候已经查过了」就跳过 ——
 * 预览和保存之间隔着人的思考时间,期间权限可能被撤、身份组可能被删,
 * 而客户端传回来的东西谁都不该信。
 */
async function evaluate(
  input: MatrixEditInput,
  actor: CurrentUser,
  commit: boolean,
  isRollback = false,
): Promise<MatrixEditResult> {
  const names = roleNameMap();
  const changes = diffCells(currentCells(), input.cells, (id) => names.get(id) ?? id);

  const errors = guardrailErrors({
    changes,
    actorPermissions: new Set(effectivePermissions(actor).keys()),
    actorPriority: actorPriority(actor.id),
    rolePriority: rolePriorities(),
    keystoneHoldersAfter: changes.length > 0 ? keystoneHoldersAfter(changes) : 1,
    reason: input.reason,
  });

  if (errors.length > 0) return { ok: false, errors };

  const diff = previewMatrixChange(changes);
  if (!commit) return { ok: true, diff, applied: false };

  /*
   * **先拍快照再落库。**
   *
   * 反过来的话第一次编辑就没有原始状态可回,
   * 而「第一次编辑」恰恰是最可能出错的那一次。
   */
  takeSnapshot({
    changes,
    summary: diff.summary,
    reason: input.reason,
    actorId: actor.id,
    isRollback,
  });
  applyMatrixChange(changes, actor.id, input.reason, diff.impact);
  return { ok: true, diff, applied: true };
}

/**
 * 回到某一张快照。
 *
 * **它走的是和普通编辑完全一样的那条路** —— 同样的护栏、同样的 diff、
 * 同样再拍一张快照。
 *
 * 不能因为「这是恢复到曾经存在过的状态」就跳过护栏:
 * 那个状态里可能有一项我现在没有的权限,
 * 于是「回滚」会变成一条绕开提权检查的近路 ——
 * 而近路正是这类功能被利用的方式。
 */
export async function rollbackMatrix(input: {
  snapshotId: string;
  reason: string;
}): Promise<MatrixEditResult> {
  const admin = await requireWritableAdmin("role.manage");

  const snapshot = readSnapshot(input.snapshotId);
  if (!snapshot) return { ok: false, errors: ["找不到这张快照，它可能已经被清掉了"] };

  const names = roleNameMap();
  const changes = changesToRestore(snapshot, currentCells(), (id) => names.get(id) ?? id);

  const result = await evaluate(
    {
      cells: changes.map((c) => ({
        roleId: c.roleId,
        permissionKey: c.permissionKey,
        state: c.to,
      })),
      reason: `回滚：${input.reason}`,
    },
    admin.user,
    true,
    true,
  );

  if (result.ok) revalidatePath("/admin/roles");
  return result;
}

/** 只看「回到这张快照会怎样」，不真的回 */
export async function previewRollback(snapshotId: string): Promise<MatrixEditResult> {
  const admin = await requireAdmin("role.manage");

  const snapshot = readSnapshot(snapshotId);
  if (!snapshot) return { ok: false, errors: ["找不到这张快照，它可能已经被清掉了"] };

  const names = roleNameMap();
  const changes = changesToRestore(snapshot, currentCells(), (id) => names.get(id) ?? id);

  return evaluate(
    {
      cells: changes.map((c) => ({
        roleId: c.roleId,
        permissionKey: c.permissionKey,
        state: c.to,
      })),
      reason: "回滚预览：看看会变成什么样",
    },
    admin.user,
    false,
  );
}
