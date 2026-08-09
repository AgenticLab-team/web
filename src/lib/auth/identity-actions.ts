"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { assertNotPreviewing, getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

import { checkPhoneAvailable, checkUsernameAvailable } from "./identity";

/**
 * 设置登录名与手机号。
 *
 * ─────────────────────────────────────────
 * 改登录名要记审计
 * ─────────────────────────────────────────
 *
 * 登录名会出现在别人眼前。一个人今天叫 `zhangsan`、明天改叫别的，
 * 而 `zhangsan` 被第三个人捡走 —— 从此之前所有提到 `zhangsan` 的地方
 * 都指向了另一个人。这个链条没有记录的话，事后没有任何办法还原。
 *
 * ─────────────────────────────────────────
 * 这里没有「用手机号找回账号」
 * ─────────────────────────────────────────
 *
 * 手机号没经过验证（这个站没有短信通道）。让一个未验证的号码
 * 能重置密码，等于「填上别人的号码就能接管账号」。
 * 它在这里只是一个好记的登录名，不多一分权力。
 */

export interface Result {
  ok: boolean;
  error?: string;
  value?: string;
}

const fail = (error: string): Result => ({ ok: false, error });

export async function setUsername(raw: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  const verdict = checkUsernameAvailable(user.id, raw);
  if (!verdict.ok) return fail(verdict.reason);

  const before = user.username;
  db.update(users).set({ username: verdict.value }).where(eq(users.id, user.id)).run();

  audit(
    { actorId: user.id },
    {
      action: "user.username.set",
      targetType: "user",
      targetId: user.id,
      before: { username: before },
      after: { username: verdict.value },
    },
  );

  revalidatePath("/me/security");
  return { ok: true, value: verdict.value };
}

export async function setPhone(raw: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  const verdict = checkPhoneAvailable(user.id, raw);
  if (!verdict.ok) return fail(verdict.reason);

  db.update(users).set({ phone: verdict.value }).where(eq(users.id, user.id)).run();

  /*
   * 审计里**只记「改过」，不记号码本身**。
   *
   * 审计日志是后台能翻的，把手机号写进去等于给它开了第二个副本，
   * 而那个副本不在任何「删除我的手机号」能碰到的地方。
   */
  audit(
    { actorId: user.id },
    { action: "user.phone.set", targetType: "user", targetId: user.id, after: { set: true } },
  );

  revalidatePath("/me/security");
  return { ok: true };
}

export async function clearPhone(): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  db.update(users).set({ phone: null, phoneVerifiedAt: null }).where(eq(users.id, user.id)).run();

  audit(
    { actorId: user.id },
    { action: "user.phone.clear", targetType: "user", targetId: user.id, after: { set: false } },
  );

  revalidatePath("/me/security");
  return { ok: true };
}

/**
 * 这个登录名能不能用。
 *
 * ─────────────────────────────────────────
 * 只给已登录的人用
 * ─────────────────────────────────────────
 *
 * 一个不需要登录的可用性接口，就是一个**社群成员枚举器**：
 * 它对每个字符串回答「这个是不是已经有人了」，
 * 而「有人」的来源里包含所有人的微信 ID。
 *
 * 登录之后仍然只回答「能不能用」，不回答「被谁占了」。
 */
export async function checkUsername(raw: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const verdict = checkUsernameAvailable(user.id, raw);
  return verdict.ok ? { ok: true, value: verdict.value } : fail(verdict.reason);
}
