"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/rbac/can";
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

  /*
   * ═════════════════════════════════════════
   * 能管邮箱的人不受额度限制
   * ═════════════════════════════════════════
   *
   * 判据用 `mail.box.write`（「替别人开箱/改到期/收回申领」），
   * 而不是「是不是管理员」这种笼统的说法：额度护的是
   * **池域名的命名空间和声誉**，而有权替别人开箱的人本来就能
   * 绕开这一层 —— 他跑一趟后台就是了。
   * 那么让他在自己这一页多开几个，不多出任何新的能力，
   * 只是少绕一圈。
   *
   * ⚠️ `bypassLimits` 同时也绕过最短长度和禁用词（见 burner.ts）。
   * 这是同一条口径：这些限制拦的是「别人抢好地址」，
   * 而站长本来就是那个决定谁能拿到好地址的人。
   *
   * 它每次都进 `mail_events`，所以「谁开了多少」照样查得到 ——
   * 不受限不等于不留痕。
   */
  const privileged = can(user, "mail.box.write").allowed;

  const result = openBurner({
    userId: user.id,
    localPart: input.localPart?.trim() || null,
    domain: input.domain?.trim() || null,
    bypassLimits: privileged,
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
