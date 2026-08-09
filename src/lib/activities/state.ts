/**
 * 活动与申请的状态机。纯函数。
 *
 * 把合法流转写成表而不是散在各处的 if：
 * 散着写的话，「已履约的申请能不能再改成待审核」这种问题
 * 每个调用点都要自己回答一遍，而总有一处会答错。
 */

import type { ActivityStatus, ApplicationStatus } from "@/lib/activities/types";

/** 活动状态的合法流转 */
const ACTIVITY_TRANSITIONS: Record<ActivityStatus, ActivityStatus[]> = {
  draft: ["scheduled", "open", "cancelled"],
  scheduled: ["open", "draft", "cancelled"],
  open: ["closed", "cancelled"],
  closed: ["reviewing", "open", "cancelled"],
  reviewing: ["fulfilling", "closed", "cancelled"],
  fulfilling: ["completed", "reviewing", "cancelled"],
  // 终态：完成和取消之后不再流转
  completed: [],
  cancelled: [],
};

/** 申请状态的合法流转 */
const APPLICATION_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["validating", "invalid", "waitlisted", "approved", "rejected", "cancelled", "expired"],
  validating: ["invalid", "waitlisted", "approved", "rejected"],
  // 判无效之后可以改了重提
  invalid: ["submitted", "waitlisted", "cancelled"],
  waitlisted: ["approved", "rejected", "cancelled", "expired"],
  approved: ["fulfilling", "fulfilled", "failed", "cancelled"],
  rejected: ["submitted", "waitlisted"],
  fulfilling: ["fulfilled", "failed"],
  // 失败之后可以重提（会指向原申请）
  failed: ["submitted", "waitlisted", "cancelled"],
  /*
   * 撤回之后可以改了重提 —— 这里以前是终态。
   *
   * 终态意味着撤回一次就永远回不来，而撤回最常见的原因恰恰是
   * 「我想换一个域名」。逼人新建一条的话，一个人在一个活动里会攒下
   * 一串申请，而名额、唯一性、每人限额全是按在途申请数的 ——
   * 攒下来的那串迟早变成一堆被占住的域名。改回同一条最省事也最安全。
   *
   * 带上 waitlisted：重提那一刻名额可能已经被别人占满了，
   * 这时该进候补，而不是把人卡在「撤回了、也回不去」的地方。
   */
  cancelled: ["submitted", "waitlisted"],
  // 终态：东西已经给出去了，不再流转
  fulfilled: [],
  expired: ["submitted", "waitlisted"],
};

export interface TransitionResult {
  ok: boolean;
  error?: string;
}

export function canTransitionActivity(
  from: ActivityStatus,
  to: ActivityStatus,
): TransitionResult {
  if (from === to) return { ok: false, error: "状态没有变化" };
  const allowed = ACTIVITY_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false, error: `不能从「${activityStatusLabel(from)}」变成「${activityStatusLabel(to)}」` };
  }
  return { ok: true };
}

export function canTransitionApplication(
  from: ApplicationStatus,
  to: ApplicationStatus,
): TransitionResult {
  if (from === to) return { ok: false, error: "状态没有变化" };
  const allowed = APPLICATION_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      error: `不能从「${applicationStatusLabel(from)}」变成「${applicationStatusLabel(to)}」`,
    };
  }
  return { ok: true };
}

/** 这些状态占着名额。判无效或撤回之后名额要还回来 */
const HOLDS_QUOTA: ReadonlySet<ApplicationStatus> = new Set([
  "submitted",
  "validating",
  "approved",
  "fulfilling",
  "fulfilled",
]);

export function holdsQuota(status: ApplicationStatus): boolean {
  return HOLDS_QUOTA.has(status);
}

/**
 * 状态变化会让名额怎么动。
 *
 * 返回 +1 表示要占一个，-1 表示要还一个，0 表示不动。
 * **候补不占名额** —— 占了的话候补就没有意义了。
 */
export function quotaDelta(from: ApplicationStatus | null, to: ApplicationStatus): number {
  const before = from !== null && holdsQuota(from) ? 1 : 0;
  const after = holdsQuota(to) ? 1 : 0;
  return after - before;
}

export function isActivityOpen(
  status: ActivityStatus,
  opensAt: number | null,
  closesAt: number | null,
  now: number,
): { open: boolean; reason?: string } {
  if (status === "cancelled") return { open: false, reason: "活动已取消" };
  if (status === "draft" || status === "scheduled") {
    return { open: false, reason: opensAt ? `还没开始，${formatTime(opensAt)} 开放` : "还没开始" };
  }
  if (status !== "open") return { open: false, reason: "活动已结束" };

  if (opensAt !== null && now < opensAt) {
    return { open: false, reason: `还没开始，${formatTime(opensAt)} 开放` };
  }
  if (closesAt !== null && now >= closesAt) {
    return { open: false, reason: "已经截止了" };
  }
  return { open: true };
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

export const ACTIVITY_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  scheduled: "已排期",
  open: "进行中",
  closed: "已截止",
  reviewing: "审核中",
  fulfilling: "履约中",
  completed: "已完成",
  cancelled: "已取消",
};

export const APPLICATION_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  submitted: "已提交",
  validating: "校验中",
  invalid: "校验未通过",
  waitlisted: "候补中",
  approved: "已通过",
  rejected: "已驳回",
  fulfilling: "履约中",
  fulfilled: "已完成",
  failed: "履约失败",
  cancelled: "已撤回",
  expired: "已过期",
};

export function activityStatusLabel(status: string): string {
  return ACTIVITY_STATUS_LABELS[status] ?? status;
}

export function applicationStatusLabel(status: string): string {
  return APPLICATION_STATUS_LABELS[status] ?? status;
}
