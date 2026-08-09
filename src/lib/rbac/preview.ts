import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { previewSessions, users } from "@/lib/db/schema";

import { effectivePermissions } from "./can";
import {
  PREVIEW_PERMISSION,
  PREVIEW_TTL_MS,
  minutesLeft,
  planPreview,
  previewActive,
  type PreviewPlan,
} from "./preview-rules";

/**
 * 「以某身份预览」的服务端部分。
 *
 * 规则本身在 preview-rules.ts 里，那边是纯函数、有完整测试。
 * 这里只负责落库、发令牌、还原。
 */

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface ActivePreview {
  id: string;
  viewer: typeof users.$inferSelect;
  subject: typeof users.$inferSelect;
  expiresAt: number;
  /**
   * 还剩几分钟。在这里算好而不是交给组件 ——
   * 组件里读时钟属于渲染期副作用，lint 会拦，而且拦得对。
   */
  minutesLeft: number;
  /** 他有、viewer 没有、预览里没给的那些权限点 */
  withheld: string[];
}

/**
 * 开一次预览。返回要写进 cookie 的令牌。
 *
 * 失败时返回 reason —— 调用方要把它原样显示给人看，
 * 不要吞掉换成一句「操作失败」。
 */
export function startPreview(
  viewerId: string,
  subjectId: string,
  ctx: { ip?: string; userAgent?: string } = {},
): { ok: true; token: string; plan: PreviewPlan } | { ok: false; reason: string } {
  const viewer = db.select().from(users).where(eq(users.id, viewerId)).get();
  const subject = db.select().from(users).where(eq(users.id, subjectId)).get();

  if (!viewer) return { ok: false, reason: "登录状态已失效" };
  if (!subject) return { ok: false, reason: "找不到这个人" };

  const viewerPerms = effectivePermissions(viewer);
  const plan = planPreview(
    {
      id: viewer.id,
      permissions: viewerPerms.keys(),
      canImpersonate: viewerPerms.has(PREVIEW_PERMISSION),
    },
    {
      id: subject.id,
      status: subject.status,
      permissions: effectivePermissions(subject).keys(),
    },
  );

  if (!plan.ok) return { ok: false, reason: plan.reason };

  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + PREVIEW_TTL_MS;

  db.insert(previewSessions)
    .values({
      tokenHash: hashToken(token),
      viewerId: viewer.id,
      subjectId: subject.id,
      withheld: JSON.stringify(plan.withheld),
      expiresAt,
    })
    .run();

  /*
   * 审计记在 viewer 头上，而且**进入就记**，不等他做了什么才记。
   *
   * 「看过」本身就是这件事里要留痕的部分 —— 预览是只读的，
   * 如果只在写操作时记账，那这个功能永远不会产生任何一条日志。
   */
  audit(
    { actorId: viewer.id, actorIp: ctx.ip, actorUa: ctx.userAgent },
    {
      action: "rbac.preview.start",
      targetType: "user",
      targetId: subject.id,
      targetLabel: subject.wxId ?? undefined,
      after: { withheld: plan.withheld, expiresAt },
      reason: plan.reason,
    },
  );

  return { ok: true, token, plan };
}

/**
 * 把 cookie 里的令牌还原成一次有效的预览。
 *
 * 任何一个条件不满足都返回 null —— **不要「尽量还原」**：
 * 一个半还原的预览态意味着「我现在是谁」说不清楚，
 * 而说不清的时候代码会默认按真实身份走，那正是最危险的方向。
 */
export function resolvePreview(token: string | undefined): ActivePreview | null {
  if (!token) return null;

  const row = db
    .select()
    .from(previewSessions)
    .where(and(eq(previewSessions.tokenHash, hashToken(token)), isNull(previewSessions.endedAt)))
    .get();

  if (!row) return null;
  const nowMs = Date.now();
  if (!previewActive(row.expiresAt, nowMs)) return null;

  const viewer = db.select().from(users).where(eq(users.id, row.viewerId)).get();
  const subject = db.select().from(users).where(eq(users.id, row.subjectId)).get();
  if (!viewer || !subject) return null;

  /*
   * 每次都重新校验 viewer 现在还有没有这个权限。
   *
   * 令牌是 30 分钟有效的，而权限可能在这 30 分钟里被撤掉 ——
   * 撤权之后还能继续预览，等于撤权没生效。
   */
  if (!effectivePermissions(viewer).has(PREVIEW_PERMISSION)) return null;
  if (subject.status === "banned" || subject.status === "deleted") return null;

  return {
    id: row.id,
    viewer,
    subject,
    expiresAt: row.expiresAt,
    minutesLeft: minutesLeft(row.expiresAt, nowMs),
    withheld: JSON.parse(row.withheld) as string[],
  };
}

/** 退出预览 */
export function endPreview(
  token: string | undefined,
  reason: "exit" | "expired" | "revoked" = "exit",
): void {
  if (!token) return;
  const row = db
    .select()
    .from(previewSessions)
    .where(and(eq(previewSessions.tokenHash, hashToken(token)), isNull(previewSessions.endedAt)))
    .get();
  if (!row) return;

  db.update(previewSessions)
    .set({ endedAt: Date.now(), endReason: reason })
    .where(eq(previewSessions.id, row.id))
    .run();

  audit(
    { actorId: row.viewerId },
    {
      action: "rbac.preview.end",
      targetType: "user",
      targetId: row.subjectId,
      after: { lastedMs: Date.now() - row.createdAt },
      reason,
    },
  );
}

/** 掐断某人的所有预览 —— 撤权、封号时用 */
export function revokePreviewsOf(viewerId: string): number {
  const live = db
    .select()
    .from(previewSessions)
    .where(and(eq(previewSessions.viewerId, viewerId), isNull(previewSessions.endedAt)))
    .all();

  for (const row of live) {
    db.update(previewSessions)
      .set({ endedAt: Date.now(), endReason: "revoked" })
      .where(eq(previewSessions.id, row.id))
      .run();

    /*
     * 掐断也要记。
     *
     * 生产演练里就是在这儿看出来的：开一次预览再掐掉，审计只有 1 条 ——
     * 「进去过」有记录，「被人掐掉」没有。而掐断恰恰是出事时才会发生的动作，
     * 那条记录比正常进出更该留着。
     */
    audit(
      { actorId: row.viewerId },
      {
        action: "rbac.preview.end",
        targetType: "user",
        targetId: row.subjectId,
        after: { lastedMs: Date.now() - row.createdAt },
        reason: "revoked",
      },
    );
  }
  return live.length;
}
