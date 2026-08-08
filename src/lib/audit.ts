import "server-only";

import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { dangerLevelOf } from "@/lib/rbac/permissions";

/**
 * 审计日志。**每一个后台写操作都要经过这里，没有例外。**
 *
 * 表本身只增不改不删，也不提供删除接口 —— 包括 owner。
 * 参见 SCHEMA.md 第十节。
 */

export interface AuditContext {
  actorId: string | null;
  actorRole?: string;
  actorIp?: string;
  actorUa?: string;
  requestId?: string;
}

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  approvalId?: string;
}

export function audit(ctx: AuditContext, entry: AuditEntry) {
  db.insert(auditLogs)
    .values({
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      actorIp: ctx.actorIp,
      actorUa: ctx.actorUa,
      requestId: ctx.requestId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      targetLabel: entry.targetLabel,
      before: entry.before ?? null,
      after: entry.after ?? null,
      reason: entry.reason,
      // action 通常与权限点同名，据此推断危险等级
      dangerLevel: dangerLevelOf(entry.action),
      approvalId: entry.approvalId,
    })
    .run();
}

/**
 * 包住一次带副作用的后台操作：先跑，成功了记日志。
 * 失败不记 —— 审计日志记的是「发生过什么」，不是「尝试过什么」，
 * 后者属于登录/操作尝试日志，不要混在一起。
 */
export function audited<T>(ctx: AuditContext, entry: AuditEntry, fn: () => T): T {
  const result = fn();
  audit(ctx, entry);
  return result;
}

/** 从请求里提取审计上下文 */
export function auditContextFrom(request: Request, actorId: string | null): AuditContext {
  return {
    actorId,
    actorIp:
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      undefined,
    actorUa: request.headers.get("user-agent") ?? undefined,
  };
}
