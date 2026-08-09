"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/admin/guard";
import { getRealUser } from "@/lib/auth/session";

import { endPreview, startPreview } from "./preview";
import { PREVIEW_COOKIE, PREVIEW_PERMISSION, PREVIEW_TTL_MS, canNest } from "./preview-rules";

/**
 * 开始以某人的身份预览。
 *
 * 这个 action 自己不能用 requireWritableAdmin —— 它就是预览的入口，
 * 拦住它等于这个功能开不起来。它靠 canNest() 挡住套娃：
 * 预览态里再开一个预览之后，「我现在到底是谁」就说不清了，
 * 而说不清的时候人会默认自己是自己 —— 那正是出事的那一刻。
 */
export async function startPreviewAction(subjectId: string): Promise<void> {
  await requireAdmin(PREVIEW_PERMISSION);

  /*
   * 失败时用重定向带回一句话，而不是返回 { error }。
   *
   * 返回值要读出来就得有个客户端组件接着，而这个功能全站只有几个人
   * 用得到 —— 为它往每个页面的首屏包里塞一段 JS 不划算。
   */
  const fail = (reason: string): never =>
    redirect(`/admin/roles?preview_error=${encodeURIComponent(reason)}`);

  const store = await cookies();
  if (store.get(PREVIEW_COOKIE) && !canNest()) {
    fail("你已经在预览态里了，先退出再切换");
  }

  /*
   * 用真实身份开预览。
   *
   * getCurrentUser() 在预览态里返回的是被预览的人 —— 拿它当 viewer
   * 就等于让预览自己给自己发令牌，一层套一层地漂移下去。
   */
  const real = await getRealUser();
  if (!real) fail("登录状态已失效");

  const h = await headers();
  const result = startPreview(real!.id, subjectId, {
    ip: h.get("x-forwarded-for") ?? undefined,
    userAgent: h.get("user-agent") ?? undefined,
  });

  if (!result.ok) fail(result.reason);
  if (!result.ok) return;

  store.set(PREVIEW_COOKIE, result.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(PREVIEW_TTL_MS / 1000),
  });

  // 切到首页 —— 预览的意义在于看他进站看到什么，而不是停在后台
  redirect("/");
}

/**
 * 退出预览。
 *
 * **这个不能有任何前置条件。** 退出是唯一一条无论如何都必须走得通的路 ——
 * 权限被撤了、账号状态变了、令牌过期了，都得能出来。
 * 一个进得去出不来的预览态，比没有这个功能危险得多。
 */
export async function exitPreviewAction(): Promise<never> {
  const store = await cookies();
  endPreview(store.get(PREVIEW_COOKIE)?.value, "exit");
  store.delete(PREVIEW_COOKIE);
  redirect("/admin/roles");
}
