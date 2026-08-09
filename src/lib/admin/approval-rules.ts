/**
 * 危险操作留痕的判定。纯函数。
 *
 * ─────────────────────────────────────────
 * 从「双人复核」改成「可选的留痕」（2026-08 站长指令）
 * ─────────────────────────────────────────
 *
 * 这套机制原来卡一条硬规则：不能批自己提出的操作。站长明确要求
 * 管理员操作不被复核流程挡住，所以那条支点拿掉了 —— 现在它是一个
 * **操作日志式的队列**：想留一步「先写下来、再执行」的痕迹就用它，
 * 自己批自己也放行。
 *
 * 但有两条不是复核规则、是安全边界的，留着不动：
 *   - 没登记的动作绝不执行（checkRequest）—— 那是任意代码执行入口
 *   - 过期的不再执行（checkApprove）—— 表里的 payload 是旧的，
 *     外部世界早就变了，批一条旧记录不等于批当时那件事
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
  // 说不清楚的理由等于没有理由。事后翻这条记录的人（多半是未来的自己）要靠它判断
  if (input.reason.trim().length < 6) return no("理由太短了，事后翻记录的人要靠它判断");

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
  if (!input.note.trim()) return no("必须写明批准意见 —— 留痕队列没有意见就只剩一个点击");
  if (input.status !== "pending") return no("这条已经处理过了");

  /*
   * 自己批自己：放行（站长指令）。这里刻意**不再读 requestedBy**，
   * 但参数保留 —— 将来要恢复双人复核时，调用方不用重新接线。
   */

  if (input.expiresAt !== null && input.expiresAt <= input.now) {
    return no("这条已经过期了。当时的判断依据可能已经变了，请重新发起");
  }

  return OK;
}

/** 驳回不需要等有效期 —— 驳回是让事情不发生，没有任何风险 */
export function checkReject(input: DecideInput): RuleResult {
  if (!input.note.trim()) return no("驳回也要写明原因");
  if (input.status !== "pending") return no("这条已经处理过了");
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
