"use server";

import { revalidatePath } from "next/cache";

import { getRealUser } from "@/lib/auth/session";
import { redeemMakeupCard } from "@/lib/points/makeup";

/**
 * 用一张补签卡。
 *
 * 用 `getRealUser()`：预览态下 `getCurrentUser()` 返回被预览的那个人 ——
 * 管理员随手点一下，会花掉别人的卡、补上别人的连胜。
 */
export type MakeupActionResult =
  | { ok: true; note: string }
  | { ok: false; error: string };

export async function spendMakeupCard(date: string): Promise<MakeupActionResult> {
  const user = await getRealUser();
  if (!user) return { ok: false, error: "先登录" };
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: "日期不对" };
  }

  const result = redeemMakeupCard(user, date);
  if (!result.ok) return { ok: false, error: result.error };

  // 首页有连胜和打卡状态，补完要立刻对上
  revalidatePath("/");
  revalidatePath("/shop");
  revalidatePath("/me/points");

  return {
    ok: true,
    note:
      result.cardsLeft > 0
        ? `${result.date} 补上了，连胜 ${result.streak} 天 · 还剩 ${result.cardsLeft} 张`
        : `${result.date} 补上了，连胜 ${result.streak} 天 · 卡用完了`,
  };
}
