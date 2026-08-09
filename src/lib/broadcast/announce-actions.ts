"use server";

import { getRealUser } from "@/lib/auth/session";
import { dismissAnnouncement } from "@/lib/broadcast/announce";

/**
 * 关掉一条站内公告。
 *
 * ─────────────────────────────────────────
 * 状态只存服务端
 * ─────────────────────────────────────────
 *
 * 存 localStorage 更省事，但那样换个设备、清一次缓存，
 * 关掉的公告全都回来了 —— 而人会觉得这个站在骚扰他。
 *
 * 这个项目刚修过一个同类的 bug（通知重复弹出），根因正是
 * 「已读」有两份、而其中一份活不过刷新。真值只能有一份。
 *
 * 用 `getRealUser()`：预览态下 `getCurrentUser()` 返回被预览的人 ——
 * 管理员随手点掉一条公告，会记在别人头上，那个人再也看不到它了。
 */
export async function dismiss(broadcastId: string): Promise<{ ok: boolean }> {
  const user = await getRealUser();
  if (!user) return { ok: false };
  if (!broadcastId || typeof broadcastId !== "string") return { ok: false };

  dismissAnnouncement(user.id, broadcastId);

  /*
   * 这里**不 revalidate**。
   *
   * 关掉的那一刻界面上已经把它移走了（乐观更新），
   * 而 revalidate 会让整页重渲染一次 —— 人正在读的位置会跳。
   * 下一次导航自然会拿到新的结果。
   */
  return { ok: true };
}
