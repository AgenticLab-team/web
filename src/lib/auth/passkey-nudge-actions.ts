"use server";

import { revalidatePath } from "next/cache";

import { assertNotPreviewing, getRealUser } from "@/lib/auth/session";

import {
  declinePasskeyNudge,
  snoozePasskeyNudge,
  undoDeclinePasskeyNudge,
} from "./passkey-nudge";
/*
 * 天数从规则层 import 进来，不在这里再写一个字面量。
 *
 * `"use server"` 限制的是这个文件**导出**什么（只能是 async 函数），
 * import 什么不受影响。抄一个数字过来的下场很具体：
 * 用户看到「过 14 天再说」，却在第 7 天又被提醒一次。
 */
import { SNOOZE_DAYS } from "./passkey-nudge-rules";

/**
 * 「以后再说」和「不用了」两个按钮落到服务端的地方。
 *
 * ─────────────────────────────────────────
 * 为什么两个动作都用 getRealUser()
 * ─────────────────────────────────────────
 *
 * `getCurrentUser()` 在预览态下返回**被预览的那个人**。用它的话，
 * 管理员以某个成员的视角看首页、顺手点了「不用了」，
 * 结果是**那个成员**从此再也收不到这条提醒 —— 而他本人
 * 从头到尾没看见过这张卡片，也没有任何地方能让他改回来。
 *
 * `assertNotPreviewing()` 已经把预览态整个拦掉了，理论上再用
 * getRealUser 是重复的。但这一层的坑这个项目踩过三次，
 * 便宜的重复比一次线上事故划算。
 */

export type NudgeActionResult = { ok: true; note: string } | { ok: false; error: string };

/** 「以后再说」。过些天还会再提一次 —— 具体几天见 passkey-nudge-rules 的 SNOOZE_DAYS */
export async function snoozePasskeyNudgeAction(): Promise<NudgeActionResult> {
  await assertNotPreviewing();
  const user = await getRealUser();
  if (!user) return { ok: false, error: "请先登录" };

  snoozePasskeyNudge(user.id);

  /*
   * 首页是 force-dynamic，本来就不缓存；revalidate 是为了那次
   * router.refresh() 回来的时候拿到的是已经没有这张卡片的版本。
   * 不刷的话，用户点完「以后再说」、卡片消失了，
   * 一按浏览器后退它又在那儿 —— 而那正是「消不掉」的观感。
   */
  revalidatePath("/");
  return { ok: true, note: `记下了，过 ${SNOOZE_DAYS} 天再说` };
}

/**
 * 「不用了」——永远不再提这件事。
 *
 * 提示语里必须说清楚它**不等于**「这个账号不能用 Passkey」：
 * /me/security 那一页永远都在，什么时候想加都可以。
 * 不说清楚的话，一个点错了的人会以为自己关掉了一个功能。
 */
export async function declinePasskeyNudgeAction(): Promise<NudgeActionResult> {
  await assertNotPreviewing();
  const user = await getRealUser();
  if (!user) return { ok: false, error: "请先登录" };

  declinePasskeyNudge(user.id);
  revalidatePath("/");
  return { ok: true, note: "以后不再提。想加的话，「我的 → 登录与安全」里随时可以" };
}

/**
 * 撤销刚才那下「不用了」。
 *
 * 「不用了」是永久的，而手机上那三个按钮是挨着排的 ——
 * 按歪一下就再也收不到这条提醒。这个站的规矩是不弹确认框、
 * 直接执行并给一次撤销机会，这个 action 就是那次机会。
 */
export async function undoDeclinePasskeyNudgeAction(): Promise<NudgeActionResult> {
  await assertNotPreviewing();
  const user = await getRealUser();
  if (!user) return { ok: false, error: "请先登录" };

  undoDeclinePasskeyNudge(user.id);
  revalidatePath("/");
  return { ok: true, note: "已撤销" };
}
