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

  applyMatrixChange(changes, actor.id, input.reason, diff.impact);
  return { ok: true, diff, applied: true };
}
