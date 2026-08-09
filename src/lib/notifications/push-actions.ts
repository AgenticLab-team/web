"use server";

import { headers } from "next/headers";

import { getCurrentUser } from "@/lib/auth/session";
import {
  removePushSubscription,
  savePushSubscription,
  validateSubscription,
} from "@/lib/notifications/push-store";
import { configProblem } from "@/lib/notifications/webpush";

export interface PushActionResult {
  ok: boolean;
  error?: string;
}

/**
 * 保存浏览器提交的推送订阅。
 *
 * 服务端没配密钥时**明说**，绝不收下订阅装作成功 ——
 * 「订阅成功」四个字意味着用户从此以为自己不会漏消息，
 * 这句话说错的代价比任何报错都大。
 */
export async function subscribePush(input: unknown): Promise<PushActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  if (configProblem() !== null) {
    return { ok: false, error: "站点还没配置推送服务，暂时只有站内通知 —— 订阅没有生效" };
  }

  const sub = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (
    !sub ||
    typeof sub.endpoint !== "string" ||
    typeof sub.keys?.p256dh !== "string" ||
    typeof sub.keys?.auth !== "string"
  ) {
    return { ok: false, error: "订阅数据不完整" };
  }

  const candidate = { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth };
  const invalid = validateSubscription(candidate);
  if (invalid) return { ok: false, error: `订阅数据无效：${invalid}` };

  savePushSubscription(user.id, {
    ...candidate,
    userAgent: (await headers()).get("user-agent") ?? undefined,
  });
  return { ok: true };
}

export async function unsubscribePush(endpoint: unknown): Promise<PushActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };
  if (typeof endpoint !== "string") return { ok: false, error: "参数不对" };

  removePushSubscription(user.id, endpoint);
  return { ok: true };
}
