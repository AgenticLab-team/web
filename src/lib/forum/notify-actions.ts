"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";

import { markRead, unreadCount } from "./notify";

/**
 * 把通知标成已读。传 id 就是那一条，不传就是全部。
 *
 * ─────────────────────────────────────────
 * 要把新的未读数带回去
 * ─────────────────────────────────────────
 *
 * 角标有两个来源：AppShell 服务端渲染的初始值，和 SSE 推来的实时值。
 * 这个 action 两个都碰不到 —— `revalidatePath("/notifications")`
 * revalidate 不到布局里的角标，而标记已读也不会触发一条 SSE。
 *
 * 于是「点掉最后一条未读」之后，角标上那个红点还在，
 * 直到下一次整页导航。而人会以为没点掉，回去再点一次。
 *
 * 把数字返回来，客户端直接写进那个小仓库（见 live-store）。
 */
export async function markNotificationsRead(id?: string) {
  const user = await getCurrentUser();
  if (!user) return { ok: false as const };

  markRead(user.id, id);
  revalidatePath("/notifications");

  return { ok: true as const, unread: unreadCount(user.id) };
}
