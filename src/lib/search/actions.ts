"use server";

import { getCurrentUser } from "@/lib/auth/session";

import { messageContext } from "./messages";

/**
 * 取上下文。
 *
 * 权限判定在 messageContext 里 —— 拿不到就是 null，
 * 不区分「不存在」与「没权限」，避免被用来探测某条消息是否存在。
 */
export async function loadContext(messageId: string) {
  const user = await getCurrentUser();
  return messageContext(user, messageId, 8);
}
