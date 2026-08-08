import "server-only";

import { and, desc, eq, gte, inArray, like, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs, users } from "@/lib/db/schema";
import { dangerLevelOf, PERMISSIONS } from "@/lib/rbac/permissions";

/**
 * 审计日志查询。
 *
 * 这张表**只增不改不删，没有删除接口** —— 包括 owner。
 * 所以这里只有读，没有任何写操作。
 *
 * 「谁能封人」「谁改过积分」这类问题定期回顾是最基本的治理动作，
 * 所以按人、按动作、按危险等级都要能筛。
 */

export interface AuditFilter {
  actorId?: string;
  action?: string;
  targetType?: string;
  /** 只看危险等级 >= N 的 */
  minDanger?: number;
  days?: number;
  limit?: number;
  offset?: number;
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  actorName: string;
  action: string;
  actionLabel: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  dangerLevel: number;
  actorIp: string | null;
  createdAt: number;
}

const ACTION_LABELS = new Map(PERMISSIONS.map((p) => [p.key as string, p.label]));

/**
 * 有些动作比权限点更细 —— 一个 moderation.queue 权限点下面
 * 有认领和处置两种动作，审计日志里必须分得清是哪一种。
 */
const EXTRA_LABELS: Record<string, string> = {
  "moderation.report.assign": "认领举报",
  "moderation.report.handle": "处置举报",
};

/** 动作名与权限点同名时直接用权限点的中文名 */
export function labelForAction(action: string): string {
  return EXTRA_LABELS[action] ?? ACTION_LABELS.get(action) ?? action;
}

export function queryAuditLogs(filter: AuditFilter = {}): { entries: AuditEntry[]; total: number } {
  const conditions = [];
  if (filter.actorId) conditions.push(eq(auditLogs.actorId, filter.actorId));
  if (filter.action) conditions.push(like(auditLogs.action, `${filter.action}%`));
  if (filter.targetType) conditions.push(eq(auditLogs.targetType, filter.targetType));
  if (filter.minDanger) conditions.push(gte(auditLogs.dangerLevel, filter.minDanger));
  if (filter.days) conditions.push(gte(auditLogs.createdAt, Date.now() - filter.days * 86_400_000));

  const where = conditions.length ? and(...conditions) : undefined;

  const total =
    db.select({ n: sql<number>`count(*)` }).from(auditLogs).where(where).get()?.n ?? 0;

  const rows = db
    .select()
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.min(filter.limit ?? 50, 200))
    .offset(filter.offset ?? 0)
    .all();

  const actorIds = [...new Set(rows.map((r) => r.actorId).filter(Boolean))] as string[];
  const actors = new Map(
    actorIds.length
      ? db
          .select({ id: users.id, site: users.siteNickname, wx: users.wxNickname })
          .from(users)
          .where(inArray(users.id, actorIds))
          .all()
          .map((u) => [u.id, u.site ?? u.wx ?? u.id])
      : [],
  );

  return {
    total,
    entries: rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      // cli 是命令行操作，不是某个账号 —— 如实标出来而不是显示成未知
      actorName: row.actorId ? (actors.get(row.actorId) ?? row.actorId) : "系统",
      action: row.action,
      actionLabel: labelForAction(row.action),
      targetType: row.targetType,
      targetId: row.targetId,
      targetLabel: row.targetLabel,
      reason: row.reason,
      before: row.before,
      after: row.after,
      dangerLevel: row.dangerLevel || dangerLevelOf(row.action),
      actorIp: row.actorIp,
      createdAt: row.createdAt,
    })),
  };
}

/** 出现过的动作类型，用于筛选下拉 */
export function auditActionFacets() {
  return db
    .select({ action: auditLogs.action, n: sql<number>`count(*)` })
    .from(auditLogs)
    .groupBy(auditLogs.action)
    .orderBy(desc(sql`count(*)`))
    .limit(30)
    .all()
    .map((row) => ({ action: row.action, label: labelForAction(row.action), count: Number(row.n) }));
}
