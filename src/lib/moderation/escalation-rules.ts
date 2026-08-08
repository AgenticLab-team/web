import type { Visibility } from "@/lib/db/schema/forum";
import { isStricter } from "@/lib/forum/visibility";

/**
 * 可见性提升的判定。纯函数。
 *
 * 这条队列是「群聊转帖锁定在原群」这条硬约束的**唯一出口**，
 * 所以它自己必须是最严的一段流程。四条底线写在代码里，配置改不动：
 *
 *   1. **上限是「仅成员」，永远到不了公开。**
 *      群里说的话不该出现在搜索引擎里 —— 那不是「更多人能看到」，
 *      是「所有人永远都能搜到」，两回事。
 *   2. **必须是提升。** 想收紧可见性不用走队列，作者自己改就行；
 *      混进来只会让队列里出现无需审核的东西。
 *   3. **需要原作者同意。** 群里那几个人只是在群里聊天，
 *      没同意过被拿给一千六百人看。
 *   4. **不能自己批自己。** 转帖人自己批准自己的申请，
 *      整条约束就形同虚设。
 */

export interface RuleResult {
  ok: boolean;
  error?: string;
}

const OK: RuleResult = { ok: true };
const no = (error: string): RuleResult => ({ ok: false, error });

/** 群聊派生内容能提升到的最高级别。硬约束，不可配置 */
export const MAX_ESCALATION: Visibility = "member";

export interface RequestInput {
  fromVisibility: Visibility;
  toVisibility: Visibility;
  fromGroupChat: boolean;
  reason: string;
  /** 这篇帖子是否已经有一条待处理的申请 */
  hasPending: boolean;
}

export function checkRequest(input: RequestInput): RuleResult {
  if (!input.reason.trim()) return no("要说明为什么值得让更多人看到");
  if (input.hasPending) return no("这篇已经有一条待处理的申请了");

  if (input.fromVisibility === input.toVisibility) {
    return no("目标可见性和当前一样");
  }

  // 收紧不用走队列，作者自己改就行
  if (isStricter(input.toVisibility, input.fromVisibility)) {
    return no("收紧可见性不需要审核，直接改就行");
  }

  if (input.fromGroupChat && isStricter(MAX_ESCALATION, input.toVisibility)) {
    return no("群聊内容最多只能提升到「仅成员」，永远不会公开");
  }

  return OK;
}

export interface ApproveInput {
  actorId: string;
  requestedBy: string;
  /** 帖子作者（转帖人） */
  postAuthorId: string;
  status: string;
  consentRequired: number;
  consentGranted: number;
  note: string;
}

export function checkApprove(input: ApproveInput): RuleResult {
  if (!input.note.trim()) return no("必须写明理由，申请人会看到");
  if (input.status !== "pending") return no("这条申请已经处理过了");

  // 自己批自己的申请，整条约束就形同虚设
  if (input.actorId === input.requestedBy) {
    return no("不能批准自己提交的申请，请交给其他管理员");
  }
  if (input.actorId === input.postAuthorId) {
    return no("不能批准自己帖子的提升申请");
  }

  /*
   * 原作者同意是**批准的前提**，不是可选项。
   * 「先批了再去要同意」在流程上说得通，但内容已经扩散出去了 ——
   * 而扩散是不可逆的，事后撤回撤不掉别人已经看到的东西。
   */
  if (input.consentGranted < input.consentRequired) {
    return no(
      `还差 ${input.consentRequired - input.consentGranted} 位原作者同意（${input.consentGranted}/${input.consentRequired}）`,
    );
  }

  return OK;
}

/** 驳回不需要同意齐全 —— 驳回是让内容维持现状，没有任何扩散风险 */
export function checkReject(input: { actorId: string; requestedBy: string; status: string; note: string }): RuleResult {
  if (!input.note.trim()) return no("必须写明理由，申请人会看到");
  if (input.status !== "pending") return no("这条申请已经处理过了");
  if (input.actorId === input.requestedBy) {
    return no("不能处理自己提交的申请，请交给其他管理员");
  }
  return OK;
}

export function checkWithdraw(input: { actorId: string; requestedBy: string; status: string }): RuleResult {
  if (input.status !== "pending") return no("这条申请已经处理过了");
  // 撤回只有申请人自己能做 —— 别人撤回等于替他放弃
  if (input.actorId !== input.requestedBy) return no("只有申请人自己能撤回");
  return OK;
}

export interface ConsentProgress {
  required: number;
  granted: number;
  ratio: number;
  complete: boolean;
  /** 还差几位 */
  missing: number;
}

export function consentProgress(required: number, granted: number): ConsentProgress {
  const safeRequired = Math.max(0, required);
  const safeGranted = Math.min(Math.max(0, granted), safeRequired);
  return {
    required: safeRequired,
    granted: safeGranted,
    // 不需要任何同意时算作已完成，而不是 0/0 除出 NaN
    ratio: safeRequired === 0 ? 1 : safeGranted / safeRequired,
    complete: safeGranted >= safeRequired,
    missing: safeRequired - safeGranted,
  };
}

export const STATUS_LABELS: Record<string, string> = {
  pending: "待审核",
  approved: "已通过",
  rejected: "已驳回",
  withdrawn: "已撤回",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}
