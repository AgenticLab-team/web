/**
 * 审核队列的判定规则。
 *
 * 纯函数，不碰数据库 —— 举报入口、后台队列、测试都引这一份。
 * 严重度以前写在 submitReport 里，后台队列要按它排序，
 * 抄第二份的话「涉法涉黄插队」这条迟早两边不一样。
 *
 * 这里有三条是治理公平性的底线，不是配置项：
 *   1. 不能处理自己举报的
 *   2. 不能处理针对自己内容的举报
 *   3. **不能复核自己下的处罚** —— 申诉制度的全部意义就在这一条
 */

export type ReasonCode = "spam" | "abuse" | "porn" | "illegal" | "privacy" | "offtopic" | "other";

/** 0 普通 / 1 需尽快 / 2 紧急 */
export type Severity = 0 | 1 | 2;

/**
 * 涉法涉黄直接进紧急队列 —— 这类内容多挂一小时的代价
 * 和「有人骂街晚一小时处理」完全不是一个量级。
 * 侵犯隐私次之：内容一旦扩散就撤不回来了。
 */
export function severityForReason(reasonCode: ReasonCode): Severity {
  if (reasonCode === "illegal" || reasonCode === "porn") return 2;
  if (reasonCode === "privacy") return 1;
  return 0;
}

/**
 * 多个**互不相同**的人举报同一个目标要升级。
 *
 * 一个人连点十次不算数（举报入口本身已经去重），
 * 但三个人各自独立举报同一条内容，基本不会同时看错。
 */
export function escalatedSeverity(base: Severity, distinctReporters: number): Severity {
  if (distinctReporters >= 3 && base < 2) return (base + 1) as Severity;
  return base;
}

export interface QueueItem {
  severity: number;
  createdAt: number;
  reportCount: number;
}

/**
 * 队列排序：先按严重度，同严重度**先来先处理**。
 *
 * 直觉上会想按最新排序，但那样会让老举报永远沉底 ——
 * 举报了三天没人管的人，才是最可能直接放弃这个站的人。
 */
export function compareQueue(a: QueueItem, b: QueueItem): number {
  if (a.severity !== b.severity) return b.severity - a.severity;
  if (a.reportCount !== b.reportCount) return b.reportCount - a.reportCount;
  return a.createdAt - b.createdAt;
}

/** 各严重度的处理时限，超过就在队列里标红 */
const SLA_MS: Record<number, number> = {
  2: 2 * 3600_000,
  1: 12 * 3600_000,
  0: 48 * 3600_000,
};

export function slaDeadline(createdAt: number, severity: number): number {
  return createdAt + (SLA_MS[severity] ?? SLA_MS[0]);
}

export function isOverdue(createdAt: number, severity: number, now: number): boolean {
  return now > slaDeadline(createdAt, severity);
}

export interface RuleResult {
  ok: boolean;
  error?: string;
}

const OK: RuleResult = { ok: true };
const no = (error: string): RuleResult => ({ ok: false, error });

export interface HandleReportInput {
  actorId: string;
  /** 这批举报的举报人（同一目标可能被多人举报） */
  reporterIds: readonly string[];
  /** 被举报内容的作者 */
  targetUserId: string | null;
  status: string;
  resolution: string;
}

/**
 * 处理举报的前置判定。
 *
 * 利益冲突这两条挡的不是恶意，是尴尬：
 * 版主自己被举报了、或者自己举报了别人，无论怎么处理都会被质疑，
 * 制度上不让他碰，对他自己也是保护。
 */
export function checkHandleReport(input: HandleReportInput): RuleResult {
  if (!input.resolution.trim()) return no("必须写清楚怎么处理的");
  if (input.status !== "open" && input.status !== "reviewing") {
    return no("这条举报已经处理过了");
  }
  if (input.reporterIds.includes(input.actorId)) {
    return no("不能处理自己提交的举报");
  }
  if (input.targetUserId && input.targetUserId === input.actorId) {
    return no("不能处理针对你自己的举报");
  }
  return OK;
}

export interface HandleAppealInput {
  actorId: string;
  /** 下这条处罚的人 */
  punisherId: string;
  appealantId: string;
  status: string;
  response: string;
}

/**
 * 处理申诉的前置判定。
 *
 * **不能复核自己下的处罚** —— 申诉制度的全部意义就在这一条。
 * 由原处罚人来判，等于让他给自己的判断打分，结果几乎注定是驳回，
 * 那这个入口只是让人多绕一圈再绝望一次，还不如没有。
 */
export function checkHandleAppeal(input: HandleAppealInput): RuleResult {
  if (!input.response.trim()) return no("必须给出答复，不能只点通过或驳回");
  if (input.status !== "open") return no("这条申诉已经处理过了");
  if (input.actorId === input.punisherId) {
    return no("不能复核自己下的处罚，请交给其他管理员");
  }
  if (input.actorId === input.appealantId) {
    return no("不能处理自己的申诉");
  }
  return OK;
}

/** 分派：只能派给自己或别人，但已处理的不能再派 */
export function checkAssign(status: string): RuleResult {
  if (status === "open" || status === "reviewing") return OK;
  return no("这条举报已经处理过了");
}

export const REASON_LABELS: Record<ReasonCode, string> = {
  spam: "垃圾信息",
  abuse: "辱骂攻击",
  porn: "色情内容",
  illegal: "违法内容",
  privacy: "侵犯隐私",
  offtopic: "跑题灌水",
  other: "其他",
};

export const SEVERITY_LABELS: Record<number, string> = {
  0: "普通",
  1: "需尽快",
  2: "紧急",
};

export function reasonLabel(code: string): string {
  return REASON_LABELS[code as ReasonCode] ?? code;
}

export function severityLabel(severity: number): string {
  return SEVERITY_LABELS[severity] ?? String(severity);
}
