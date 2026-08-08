import "server-only";

import { desc, sql } from "drizzle-orm";

import { getApprovalHandler } from "@/lib/admin/approval-registry";
import { isExpired, statusLabel } from "@/lib/admin/approval-rules";
import { db } from "@/lib/db";
import { approvals, settings, users } from "@/lib/db/schema";
import { DANGEROUS_SETTING_KEYS } from "@/lib/settings/validate";
import { resolveDisplayName } from "@/lib/users/display-name";

/**
 * 复核队列的读取层。
 *
 * 与 approval-actions 分开：那边是 "use server"，只能导出 async 函数。
 * `now` 作为参数默认在这里取，而不是在页面组件里调 Date.now() ——
 * 渲染期间调不纯的函数会让同一次渲染重跑时得到不同结果。
 */

export interface ApprovalRow {
  id: string;
  action: string;
  actionLabel: string;
  /** 给复核的人看的一句人话。看不懂就等于没复核 */
  describe: string;
  reason: string;
  status: string;
  statusLabel: string;
  expired: boolean;

  requestedBy: string;
  requestedByName: string;
  approvedBy: string | null;
  approvedByName: string | null;
  approveNote: string | null;
  executeError: string | null;

  requestedAt: number;
  expiresAt: number | null;
}

export function listApprovals(limit = 40, now = Date.now()): ApprovalRow[] {
  const rows = db.select().from(approvals).orderBy(desc(approvals.requestedAt)).limit(limit).all();
  if (rows.length === 0) return [];

  const ids = [
    ...new Set(
      [...rows.map((r) => r.requestedBy), ...rows.map((r) => r.approvedBy)].filter(Boolean),
    ),
  ] as string[];

  const names = new Map(
    ids.length
      ? db
          .select({ id: users.id, site: users.siteNickname, wx: users.wxNickname, wxId: users.wxId })
          .from(users)
          .where(sql`${users.id} in ${ids}`)
          .all()
          .map((u) => [
            u.id,
            resolveDisplayName([u.site, u.wx], { wxId: u.wxId, fallback: "管理员" }),
          ])
      : [],
  );

  return rows.map((row) => {
    const handler = getApprovalHandler(row.action);

    let describe: string;
    try {
      describe = handler ? handler.describe(row.payload as never) : row.action;
    } catch {
      /*
       * describe 会查库，而被引用的对象可能已经被删了。
       * 让它抛出去会把整页打崩 —— 而这一页恰恰是出事时要看的那一页。
       */
      describe = `${row.action}（详情已无法解析，相关对象可能已删除）`;
    }

    const result = row.executeResult as { error?: string } | null;

    return {
      id: row.id,
      action: row.action,
      actionLabel: handler?.label ?? row.action,
      describe,
      reason: row.reason,
      status: row.status,
      statusLabel: statusLabel(row.status),
      expired: row.status === "pending" && isExpired(row.expiresAt, now),

      requestedBy: row.requestedBy,
      requestedByName: names.get(row.requestedBy) ?? "管理员",
      approvedBy: row.approvedBy,
      approvedByName: row.approvedBy ? (names.get(row.approvedBy) ?? "管理员") : null,
      approveNote: row.approveNote,
      executeError: result?.error ?? null,

      requestedAt: row.requestedAt,
      expiresAt: row.expiresAt,
    };
  });
}

export function pendingApprovalCount(now = Date.now()): number {
  return db
    .select()
    .from(approvals)
    .all()
    .filter((r) => r.status === "pending" && !isExpired(r.expiresAt, now)).length;
}

/** 可以发起复核的危险配置项 */
export function dangerousSettingOptions() {
  return db
    .select()
    .from(settings)
    .all()
    .filter((s) => DANGEROUS_SETTING_KEYS.includes(s.key))
    .map((s) => ({ key: s.key, label: s.label ?? s.key, value: s.value }));
}
