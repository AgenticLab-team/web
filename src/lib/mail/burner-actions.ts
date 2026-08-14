"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { readMessage, type MailMessageDetail } from "@/lib/mail/message";
import { destroyBurner, openBurner } from "@/lib/mail/burner";

/**
 * 一次性箱的网页动作。薄壳 —— 逻辑在 `burner.ts`，那里能单测。
 *
 * 这个文件里**只能导出 async 函数**。导出一个同步的常量或类型
 * 会让整个构建挂掉（"use server" 的硬规矩），而报错信息指向的
 * 是别的地方。
 */

export interface BurnerActionResult {
  ok: boolean;
  error?: string;
  address?: string;
  id?: string;
}

export async function createBurner(input: {
  localPart?: string;
  domain?: string;
}): Promise<BurnerActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const result = openBurner({
    userId: user.id,
    localPart: input.localPart?.trim() || null,
    domain: input.domain?.trim() || null,
  });

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/mail/burner");
  return { ok: true, address: result.box.displayAddress, id: result.box.id };
}

export async function discardBurner(input: { id: string }): Promise<BurnerActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const done = destroyBurner(input.id, { userId: user.id });
  if (!done) return { ok: false, error: "没有这个箱子" };

  revalidatePath("/mail/burner");
  return { ok: true };
}

/**
 * 打开一封信。
 *
 * ─────────────────────────────────────────
 * 为什么是 action 而不是让页面直接查
 * ─────────────────────────────────────────
 *
 * 打开一封信会**改状态**（标记已读）。写在服务端组件里的话，
 * 那次写会发生在渲染期 —— 而渲染是可以被重放的（预取、
 * 快速前进后退、React 的并发渲染都会），于是「已读时间」
 * 变成一个说不清什么时候被写的值。
 *
 * 走 action 就只有一个入口：人点了那一下。
 */
export async function openMessage(input: { id: string }): Promise<
  { ok: true; message: MailMessageDetail } | { ok: false; error: string }
> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const message = readMessage({ userId: user.id, messageId: input.id });
  /*
   * 「不是你的」和「不存在」给同一句话。
   * 分开说的话，这个 action 就成了一个「这个 id 存不存在」的探针。
   */
  if (!message) return { ok: false, error: "这封信不在了" };

  return { ok: true, message };
}
