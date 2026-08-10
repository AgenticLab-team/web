"use server";

import { redirect } from "next/navigation";

import { audit } from "@/lib/audit";
import { clearSessionCookie, getCurrentUser, getRealUser } from "@/lib/auth/session";
import { deleteAccount } from "@/lib/users/delete";
import { CONFIRM_WORD } from "@/lib/users/deletion-plan";

/**
 * 自助注销。
 *
 * ─────────────────────────────────────────
 * 三道闸，缺一不可
 * ─────────────────────────────────────────
 *
 * ① **必须是本人**。预览别人身份（`getCurrentUser` 在预览态下返回的是
 *    被预览的那个人）时绝不能触发 —— 管理员点开预览随手删掉别人的账号，
 *    是这个功能能造成的最坏后果。所以拿 `getRealUser` 再比一次。
 * ② **必须手打确认词**。一个只需要点一下的不可撤销操作，
 *    迟早会有人在地铁上误触。
 * ③ **删完立刻登出**。不登出的话，页面上还挂着一个已经不存在的账号，
 *    下一步操作会撞上各种「查不到」，而人会以为是没删掉。
 */

export interface DeleteAccountResult {
  ok: false;
  error: string;
}

export async function deleteMyAccount(input: {
  confirm: string;
  reason?: string;
}): Promise<DeleteAccountResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  /*
   * 预览态下 getCurrentUser 是被预览的那个人，getRealUser 才是操作的人。
   * 两者不一致 = 有人正在以别人的身份点这个按钮 —— 一律拒绝。
   *
   * 这一条不是防坏人，是防手滑：管理员开着预览排查问题，
   * 顺手点进设置页，看到一个「注销账号」。
   */
  const real = await getRealUser();
  if (!real || real.id !== user.id) {
    return { ok: false, error: "正在预览别人的身份，不能在这里注销账号" };
  }

  if (input.confirm.trim() !== CONFIRM_WORD) {
    return { ok: false, error: `请完整输入「${CONFIRM_WORD}」` };
  }

  /*
   * 审计先写。
   *
   * 写在删除之后的话，一旦删除成功而审计写失败，
   * 就成了一次**没有任何记录的账号消失** —— 而 audit_logs 恰恰是
   * 注销时刻意保留的那一档，为的就是这种时候查得到。
   */
  audit(
    { actorId: user.id },
    {
      action: "user.delete.self",
      targetType: "user",
      targetId: user.id,
      reason: input.reason?.slice(0, 200) || "用户自助注销",
    },
  );

  deleteAccount(user.id, { by: user.id, reason: input.reason?.slice(0, 200) || "用户自助注销" });

  await clearSessionCookie();
  redirect("/?bye=1");
}
