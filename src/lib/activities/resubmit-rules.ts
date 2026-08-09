import type { ApplicationStatus } from "@/lib/activities/types";

/**
 * 撤回之后重新编辑再提交。
 *
 * ─────────────────────────────────────────
 * 为什么要有这一条
 * ─────────────────────────────────────────
 *
 * 域名想好了才填，但人是填完才想清楚的 —— 撤回一次等于从头再来，
 * 而「从头再来」在页面上根本走不通：撤回之后那条申请还挂在那儿，
 * 表单只会显示「你已经登记了 xxx（已撤回）」，连再填一次的入口都没有。
 *
 * ─────────────────────────────────────────
 * 为什么是「改这一条」而不是「新建一条」
 * ─────────────────────────────────────────
 *
 * 每撤回一次就新建一条的话，一个人在一个活动里会攒下一串申请。
 * 名额、唯一性、每人限额这三道判定全都是按「在途的申请」数的，
 * 只要有一条判漏了，攒下来的那一串就变成了一堆被占住的域名。
 *
 * 复用同一行则天然没有这个问题：这个人在这个活动里从头到尾只有一行，
 * 它要么在途（占一个名额、占住一个域名），要么作废（什么都不占）。
 *
 * 剩下的口子只有一个：**反复撤回—改—提交**去连续试探。它不占名额
 * （每一刻都只占一个），但会一直打注册商的 RDAP 查询，等于拿站点当扫描器。
 * 所以给同一行加一个重提次数上限。
 *
 * 纯函数。名额、唯一性由数据库那一层保证，这里只回答「该不该让他改」。
 */

/** 这些状态下这条申请什么都不占，可以改了重来 */
export const RESUBMITTABLE: ReadonlySet<ApplicationStatus> = new Set([
  "cancelled",
  "invalid",
  "rejected",
  "expired",
  "failed",
]);

/**
 * 同一条申请最多重提几次。
 *
 * 不是防占名额（那由名额和唯一索引管），是防有人拿撤回—重提当
 * 域名查询接口刷 RDAP。5 次足够一个人改主意，不够拿来扫描。
 */
export const MAX_RESUBMITS = 5;

export interface ResubmitCheck {
  ok: boolean;
  reason?: string;
}

export function canResubmit(input: {
  /** 是不是本人 */
  isOwner: boolean;
  status: ApplicationStatus;
  /** 活动现在还开着吗 */
  activityOpen: boolean;
  activityClosedReason?: string;
  /** 这个人在这个活动里**另外**还有几条在途的申请（不含这一条） */
  otherActiveApplications: number;
  perUserLimit: number;
  /** 这一条已经提交过几次 */
  submitCount: number;
}): ResubmitCheck {
  // 先判归属：不是你的东西，连它是什么状态都不该告诉你
  if (!input.isOwner) return { ok: false, reason: "这不是你的申请" };

  if (!RESUBMITTABLE.has(input.status)) {
    /*
     * 在途的申请不能直接改。
     *
     * 允许的话，「改域名」就绕开了撤回那一步 —— 而撤回那一步正是
     * 把名额和原来那个域名还回去的地方。结果会是名额还挂在旧的那次上，
     * 域名却已经换成新的了。要改就先撤回。
     */
    return { ok: false, reason: "这条申请还在处理中，要改的话先撤回" };
  }

  if (!input.activityOpen) {
    return { ok: false, reason: input.activityClosedReason ?? "活动已经不接受申请了" };
  }

  /*
   * 每人限额按**在途的**算，撤回掉的那条不算 —— 否则撤回等于把
   * 自己的名额扔了。这一条自己正处在作废状态，本来就不在计数里。
   */
  if (input.otherActiveApplications >= input.perUserLimit) {
    return { ok: false, reason: `每人最多同时有 ${input.perUserLimit} 份申请` };
  }

  if (input.submitCount >= MAX_RESUBMITS) {
    return {
      ok: false,
      reason: `这条申请已经改过 ${input.submitCount} 次了 —— 想好了再来，或者找管理员`,
    };
  }

  return { ok: true };
}
