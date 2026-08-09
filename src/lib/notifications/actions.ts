"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { isAlwaysOn, sanitizeSubmission, type PrefsMap } from "@/lib/notifications/prefs";
import { getPrefs, savePrefs } from "@/lib/notifications/store";

export interface PrefsResult {
  ok: boolean;
  error?: string;
  prefs?: PrefsMap;
  note?: string;
}

/**
 * 保存通知偏好。
 *
 * 「关不掉的不能关」在 sanitizeSubmission 里**再判一次** ——
 * 只在界面上把开关禁用掉等于没有这条规则，改一行请求体就绕过去了。
 */
export async function updateNotificationPrefs(input: unknown): Promise<PrefsResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const prefs = sanitizeSubmission(input);
  savePrefs(user.id, prefs);

  const muted = Object.entries(prefs).filter(([type, v]) => !v.site && !isAlwaysOn(type)).length;
  revalidatePath("/me/notifications");
  revalidatePath("/notifications");

  return {
    ok: true,
    prefs,
    note: muted === 0 ? "全部保持开启" : `已关掉 ${muted} 类通知`,
  };
}

export async function readNotificationPrefs(): Promise<PrefsResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };
  return { ok: true, prefs: getPrefs(user.id) };
}
