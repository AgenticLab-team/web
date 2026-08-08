/**
 * 用户管理写操作的判定规则。
 *
 * 这些规则本来写在 user-actions.ts 的 server action 里，
 * 但那些函数要先过 requireAdmin（读 cookie、查会话），测试碰不到 ——
 * 于是「不能移除最后一个站长」这种最该被测的约束反而只能靠肉眼看。
 *
 * 抽成纯函数放这里：action 调它，测试也调它，两边是同一份判断。
 * 抄一份到测试里看起来也能跑，但那测的是抄件，不是线上跑的东西。
 */

export interface RuleResult {
  ok: boolean;
  error?: string;
}

const OK: RuleResult = { ok: true };
const no = (error: string): RuleResult => ({ ok: false, error });

/** 每一条写操作都要理由 —— 事后翻审计日志时，没有理由的记录等于没有记录 */
export function checkReason(reason: string): RuleResult {
  return reason.trim() ? OK : no("必须填写理由");
}

export interface PointsAdjustInput {
  delta: number;
  reason: string;
  /** 超过这个绝对值就算大额调整 */
  threshold: number;
  hasLargePermission: boolean;
}

export function checkPointsAdjust(input: PointsAdjustInput): RuleResult {
  const reason = checkReason(input.reason);
  if (!reason.ok) return reason;

  if (!Number.isInteger(input.delta) || input.delta === 0) {
    return no("变动值必须是非零整数");
  }

  // 一次手滑发出成千上万分，事后只能靠冲正，且榜单已经被看见了
  if (Math.abs(input.delta) >= input.threshold && !input.hasLargePermission) {
    return no(`超过 ${input.threshold} 分的调整需要更高权限`);
  }

  return OK;
}

export interface StatusChangeInput {
  actorId: string;
  targetId: string;
  reason: string;
}

export function checkStatusChange(input: StatusChangeInput): RuleResult {
  const reason = checkReason(input.reason);
  if (!reason.ok) return reason;

  // 把自己锁在门外之后没人能救，只能改数据库
  if (input.actorId === input.targetId) return no("不能改自己的状态");

  return OK;
}

/** 状态没变就什么都不做 —— 不写库、不撤会话、不发通知，也不留一条噪音审计 */
export function isNoopStatusChange(currentStatus: string, nextStatus: string): boolean {
  return currentStatus === nextStatus;
}

/** 封禁/停用要立即踢下线，不能等会话自然过期 */
export function shouldRevokeSessions(nextStatus: string): boolean {
  return nextStatus !== "active";
}

export const ELEVATED_ROLE_KEYS: ReadonlySet<string> = new Set(["owner", "admin"]);

export function isElevatedRole(roleKey: string): boolean {
  return ELEVATED_ROLE_KEYS.has(roleKey);
}

export interface RoleGrantInput {
  roleKey: string;
  reason: string;
  hasAdminGrantPermission: boolean;
  /** 这个人是否已经持有该身份组 */
  alreadyHeld: boolean;
}

export function checkRoleGrant(input: RoleGrantInput): RuleResult {
  const reason = checkReason(input.reason);
  if (!reason.ok) return reason;

  // 否则版主可以把自己提成站长
  if (isElevatedRole(input.roleKey) && !input.hasAdminGrantPermission) {
    return no("你没有授予管理员的权限");
  }
  if (input.alreadyHeld) return no("这个人已经有这个身份组了");

  return OK;
}

export interface RoleRevokeInput {
  roleKey: string;
  reason: string;
  hasAdminGrantPermission: boolean;
  /** 撤销**之前**该身份组的在册持有人数 */
  currentHolders: number;
}

export function checkRoleRevoke(input: RoleRevokeInput): RuleResult {
  const reason = checkReason(input.reason);
  if (!reason.ok) return reason;

  if (isElevatedRole(input.roleKey) && !input.hasAdminGrantPermission) {
    return no("你没有撤销管理员的权限");
  }

  /*
   * 不能移除最后一个站长。
   * 移除之后系统里再没有人能授予管理员，只能改数据库救 ——
   * 这种「把自己锁在门外」的操作必须在代码层挡住，不能靠配置。
   */
  if (input.roleKey === "owner" && input.currentHolders <= 1) {
    return no("不能移除最后一个站长");
  }

  return OK;
}

/** 备注可以没有「理由」，但不能是空的 */
export function checkNote(content: string): RuleResult {
  return content.trim() ? OK : no("备注不能为空");
}
