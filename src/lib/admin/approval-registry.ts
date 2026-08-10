import "server-only";

import type { PermissionKey } from "@/lib/rbac/permissions";

/**
 * 可复核动作的注册表。
 *
 * ─────────────────────────────────────────
 * 为什么必须是注册表，不能是通用的「存下来待会执行」
 * ─────────────────────────────────────────
 *
 * 双人复核的朴素实现是：把要执行的操作序列化存起来，批准后回放。
 * 那等于在数据库里开了一个**延迟执行的远程调用**入口 ——
 * 谁能往 approvals 表里写一行，谁就能让系统执行任意操作，
 * 而且是以「已被批准」的身份执行的。
 *
 * 所以这里反过来：只有**代码里登记过**的动作能被提出。
 * payload 由每个动作自己校验，执行函数也由它自己提供。
 * 表里存的只是「哪个动作 + 什么参数」，不是「执行什么代码」。
 *
 * 另外两条：
 *   - 每个动作自己说明 `describe(payload)`，让复核的人看得懂在批什么。
 *     复核一段看不懂的 JSON 等于没复核。
 *   - 待批记录**会过期**。一周后才执行的批准，
 *     当时的判断依据早就变了。
 */

export interface ApprovalContext {
  actorId: string;
}

export interface ApprovalHandler<P = unknown> {
  key: string;
  label: string;
  /** 提出这个动作本身需要的权限 */
  permission: PermissionKey;
  /** 批准需要的权限 */
  approvePermission: PermissionKey;
  /** 校验 payload。**不能信任表里的内容** —— 它可能是很久以前写进去的 */
  validate: (payload: unknown) => { ok: boolean; error?: string };
  /** 给复核的人看的一句话。看不懂就等于没复核 */
  describe: (payload: P) => string;
  /** 真正执行 */
  execute: (payload: P, ctx: ApprovalContext) => Promise<{ ok: boolean; error?: string }>;
}

const registry = new Map<string, ApprovalHandler<never>>();

export function registerApproval<P>(handler: ApprovalHandler<P>) {
  registry.set(handler.key, handler as unknown as ApprovalHandler<never>);
}

export function getApprovalHandler(key: string): ApprovalHandler<never> | undefined {
  return registry.get(key);
}

/** 待批记录的有效期。过期的不能再执行 —— 当时的判断依据早就变了 */
export const APPROVAL_TTL_MS = 24 * 3600_000;
