/**
 * 双人复核的判定。纯函数。
 *
 * 这套机制的全部价值就在「**第二个人**」这四个字上。
 * 一旦允许自己批自己，它就退化成一个多余的确认弹窗 ——
 * 而多余的确认弹窗只会训练人闭着眼睛点确定。
 */

export interface RuleResult {
  ok: boolean;
  error?: string;
}

const OK: RuleResult = { ok: true };
const no = (error: string): RuleResult => ({ ok: false, error });

export interface RequestInput {
  reason: string;
  /** 这个动作是否登记过 */
  known: boolean;
  payloadValid: boolean;
  payloadError?: string;
}

export function checkRequest(input: RequestInput): RuleResult {
  if (!input.reason.trim()) return no("必须写明为什么要做这件事");
  // 说不清楚的理由等于没有理由。复核的人要靠它判断
  if (input.reason.trim().length < 6) return no("理由太短了，复核的人要靠它判断");

  if (!input.known) {
    // 没登记的动作绝不执行 —— 那等于开了一个任意代码执行入口
    return no("这个动作没有登记，拒绝受理");
  }
  if (!input.payloadValid) return no(input.payloadError ?? "参数不合法");

  return OK;
}

export interface DecideInput {
  actorId: string;
  requestedBy: string;
  status: string;
  expiresAt: number | null;
  now: number;
  note: string;
}

export function checkApprove(input: DecideInput): RuleResult {
  if (!input.note.trim()) return no("必须写明复核意见");
  if (input.status !== "pending") return no("这条已经处理过了");

  /*
   * 整套机制的支点。允许自己批自己的话，
   * 它就退化成一个多余的确认弹窗 —— 而那只会训练人闭着眼点确定。
   */
  if (input.actorId === input.requestedBy) {
    return no("不能批准自己提出的操作 —— 双人复核的意义就在这一条");
  }

  if (input.expiresAt !== null && input.expiresAt <= input.now) {
    return no("这条已经过期了。当时的判断依据可能已经变了，请重新发起");
  }

  return OK;
}

/** 驳回不需要等有效期 —— 驳回是让事情不发生，没有任何风险 */
export function checkReject(input: DecideInput): RuleResult {
  if (!input.note.trim()) return no("驳回也要写明原因");
  if (input.status !== "pending") return no("这条已经处理过了");
  if (input.actorId === input.requestedBy) return no("不能处理自己提出的操作");
  return OK;
}

/** 撤回：只有发起人自己能撤 */
export function checkWithdraw(input: {
  actorId: string;
  requestedBy: string;
  status: string;
}): RuleResult {
  if (input.status !== "pending") return no("这条已经处理过了");
  if (input.actorId !== input.requestedBy) return no("只有发起人能撤回");
  return OK;
}

export function isExpired(expiresAt: number | null, now: number): boolean {
  return expiresAt !== null && expiresAt <= now;
}

export const STATUS_LABELS: Record<string, string> = {
  pending: "待复核",
  approved: "已批准",
  rejected: "已驳回",
  expired: "已过期",
  executed: "已执行",
  failed: "执行失败",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}
