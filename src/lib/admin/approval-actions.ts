"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { APPROVAL_HANDLERS_LOADED } from "@/lib/admin/approval-handlers";
import {
  APPROVAL_TTL_MS,
  getApprovalHandler,
} from "@/lib/admin/approval-registry";
import { checkApprove, checkReject, checkRequest, checkWithdraw } from "@/lib/admin/approval-rules";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { approvals } from "@/lib/db/schema";
import { dangerLevelOf } from "@/lib/rbac/permissions";

/**
 * 双人复核的写操作。
 *
 * 只有登记过的动作能被提出（见 approval-registry）。
 * 表里存的是「哪个动作 + 什么参数」，不是「执行什么代码」——
 * 后者等于在数据库里开一个延迟执行的远程调用入口。
 */

// 引用一下，确保 handler 注册表在这个模块被加载时已经填好
void APPROVAL_HANDLERS_LOADED;

export interface ApprovalResult {
  ok: boolean;
  error?: string;
  id?: string;
  note?: string;
}

const fail = (error: string): ApprovalResult => ({ ok: false, error });

export async function requestApproval(input: {
  action: string;
  payload: unknown;
  reason: string;
}): Promise<ApprovalResult> {
  const handler = getApprovalHandler(input.action);

  // 先按动作声明的权限判定 —— 没登记的动作连权限都无从谈起
  if (!handler) {
    return fail("这个动作没有登记，拒绝受理");
  }
  const admin = await requireWritableAdmin(handler.permission);

  const validation = handler.validate(input.payload);
  const check = checkRequest({
    reason: input.reason,
    known: true,
    payloadValid: validation.ok,
    payloadError: validation.error,
  });
  if (!check.ok) return fail(check.error!);

  const row = db
    .insert(approvals)
    .values({
      action: input.action,
      payload: input.payload,
      dangerLevel: dangerLevelOf(handler.permission) || 3,
      requestedBy: admin.user.id,
      reason: input.reason.trim(),
      expiresAt: Date.now() + APPROVAL_TTL_MS,
    })
    .returning({ id: approvals.id })
    .get();

  audit({ actorId: admin.user.id }, {
    action: handler.permission,
    targetType: "approval",
    targetId: row.id,
    targetLabel: handler.label,
    after: { requested: true, action: input.action },
    reason: input.reason,
  });

  revalidatePath("/admin/approvals");
  return {
    ok: true,
    id: row.id,
    note: `已提交，需要另一个人复核。${Math.round(APPROVAL_TTL_MS / 3600_000)} 小时内有效。`,
  };
}

export async function approveAndExecute(input: {
  id: string;
  note: string;
}): Promise<ApprovalResult> {
  const row = db.select().from(approvals).where(eq(approvals.id, input.id)).get();
  if (!row) return fail("找不到这条待复核记录");

  const handler = getApprovalHandler(row.action);
  if (!handler) return fail("这个动作已经不再登记，拒绝执行");

  const admin = await requireWritableAdmin(handler.approvePermission);

  const check = checkApprove({
    actorId: admin.user.id,
    requestedBy: row.requestedBy,
    status: row.status,
    expiresAt: row.expiresAt,
    now: Date.now(),
    note: input.note,
  });
  if (!check.ok) return fail(check.error!);

  /*
   * **执行前重新校验 payload。**
   * 它是很久以前写进表里的，期间外部世界变了 ——
   * 那个用户可能已经被删了，那个配置项可能已经不存在了。
   */
  const validation = handler.validate(row.payload);
  if (!validation.ok) {
    db.update(approvals)
      .set({
        status: "failed",
        approvedBy: admin.user.id,
        approvedAt: Date.now(),
        approveNote: input.note.trim(),
        executeResult: { error: validation.error },
      })
      .where(eq(approvals.id, input.id))
      .run();
    return fail(`参数已经不再有效：${validation.error}`);
  }

  db.update(approvals)
    .set({
      status: "approved",
      approvedBy: admin.user.id,
      approvedAt: Date.now(),
      approveNote: input.note.trim(),
    })
    .where(eq(approvals.id, input.id))
    .run();

  const result = await handler.execute(row.payload as never, { actorId: admin.user.id });

  db.update(approvals)
    .set({
      status: result.ok ? "executed" : "failed",
      executedAt: Date.now(),
      executeResult: result,
    })
    .where(eq(approvals.id, input.id))
    .run();

  audit({ actorId: admin.user.id }, {
    action: handler.approvePermission,
    targetType: "approval",
    targetId: input.id,
    targetLabel: handler.label,
    before: { requestedBy: row.requestedBy },
    after: { executed: result.ok, error: result.error },
    reason: input.note,
  });

  revalidatePath("/admin/approvals");

  if (!result.ok) return fail(`已批准但执行失败：${result.error}`);
  return { ok: true, note: "已批准并执行" };
}

export async function rejectApproval(input: {
  id: string;
  note: string;
}): Promise<ApprovalResult> {
  const row = db.select().from(approvals).where(eq(approvals.id, input.id)).get();
  if (!row) return fail("找不到这条待复核记录");

  const handler = getApprovalHandler(row.action);
  const admin = await requireWritableAdmin(handler?.approvePermission ?? "system.approval");

  const check = checkReject({
    actorId: admin.user.id,
    requestedBy: row.requestedBy,
    status: row.status,
    expiresAt: row.expiresAt,
    now: Date.now(),
    note: input.note,
  });
  if (!check.ok) return fail(check.error!);

  db.update(approvals)
    .set({
      status: "rejected",
      approvedBy: admin.user.id,
      approvedAt: Date.now(),
      approveNote: input.note.trim(),
    })
    .where(eq(approvals.id, input.id))
    .run();

  audit({ actorId: admin.user.id }, {
    action: "system.approval",
    targetType: "approval",
    targetId: input.id,
    after: { rejected: true },
    reason: input.note,
  });

  revalidatePath("/admin/approvals");
  return { ok: true };
}

export async function withdrawApproval(input: { id: string }): Promise<ApprovalResult> {
  const admin = await requireWritableAdmin("system.dashboard");

  const row = db.select().from(approvals).where(eq(approvals.id, input.id)).get();
  if (!row) return fail("找不到这条待复核记录");

  const check = checkWithdraw({
    actorId: admin.user.id,
    requestedBy: row.requestedBy,
    status: row.status,
  });
  if (!check.ok) return fail(check.error!);

  db.update(approvals).set({ status: "rejected", approveNote: "发起人撤回" }).where(eq(approvals.id, input.id)).run();

  // 撤回和被驳回在表里都是 rejected —— 不记的话事后分不清是谁的决定
  audit(
    { actorId: admin.user.id },
    {
      action: "system.approval",
      targetType: "approval",
      targetId: input.id,
      targetLabel: row.action,
      before: { status: row.status },
      after: { status: "rejected" },
      reason: "发起人撤回",
    },
  );

  revalidatePath("/admin/approvals");
  return { ok: true };
}

/** 把过期的标出来。不标的话它们会一直挂在待办里，看起来永远有活没干完 */
export async function sweepExpired(): Promise<ApprovalResult> {
  const admin = await requireWritableAdmin("system.approval");

  const now = Date.now();
  const expired = db
    .select()
    .from(approvals)
    .where(eq(approvals.status, "pending"))
    .orderBy(desc(approvals.requestedAt))
    .all()
    .filter((r) => r.expiresAt !== null && r.expiresAt <= now);

  for (const row of expired) {
    db.update(approvals).set({ status: "expired" }).where(eq(approvals.id, row.id)).run();
  }

  /*
   * 记一条汇总，不是每行一条。
   *
   * 一次清扫可能刷掉几十条，逐行记会把审计日志淹掉，
   * 而被淹掉的日志和没有日志是一回事。但**完全不记也不行**：
   * 一个待复核的危险操作被判过期，意味着它最终没有发生 ——
   * 事后追问「那件事为什么没做成」时，这条是唯一的答案。
   */
  if (expired.length > 0) {
    audit(
      { actorId: admin.user.id },
      {
        action: "system.approval",
        targetType: "approval",
        targetLabel: `清扫过期复核 ${expired.length} 条`,
        after: { expired: expired.map((r) => r.id) },
      },
    );
  }

  revalidatePath("/admin/approvals");
  return { ok: true, note: `${expired.length} 条已过期` };
}
