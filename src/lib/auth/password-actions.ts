"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { credentials } from "@/lib/db/schema";
import { checkPassword, hashPassword, verifyPassword } from "@/lib/auth/password";
import { passwordCredentialOf } from "@/lib/auth/password-login";
import { getCurrentUser } from "@/lib/auth/session";

export interface PasswordResult {
  ok: boolean;
  error?: string;
  note?: string;
}

/**
 * 设置或修改密码。
 *
 * **必须已经登录**。这是整条设计的关键：密码不是第二条注册路径，
 * 只是给已经通过微信验证过身份的人多一把钥匙。
 * 允许未登录设置密码，等于绕开「只有群成员能登录」这条规矩。
 *
 * 已经有密码时要先验旧的 —— 否则一台没锁屏的电脑就能改掉别人的密码，
 * 而改完之后原主人连自己的账号都进不去。
 */
export async function setPassword(input: {
  password: string;
  current?: string;
}): Promise<PasswordResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const existing = passwordCredentialOf(user.id);
  if (existing) {
    if (!input.current) return { ok: false, error: "改密码要先输入现在的密码" };
    if (!verifyPassword(input.current, existing.secret)) {
      return { ok: false, error: "现在的密码不对" };
    }
  }

  const check = checkPassword(input.password, {
    nickname: user.siteNickname ?? user.wxNickname,
    wxId: user.wxId,
  });
  if (!check.ok) return { ok: false, error: check.error };

  const secret = hashPassword(check.password);

  if (existing) {
    db.update(credentials).set({ secret }).where(eq(credentials.id, existing.id)).run();
  } else {
    db.insert(credentials)
      .values({ userId: user.id, type: "password", name: "密码", secret })
      .run();
  }

  revalidatePath("/me/security");
  return {
    ok: true,
    note: existing
      ? "密码已更新"
      : "密码已设置 —— 换了设备、或者群猫娘发不出验证码时，用它登录",
  };
}

/**
 * 删掉密码。
 *
 * 删之前要确认还有别的办法进来 —— 一个既没有 Passkey 又没有密码的人，
 * 只能靠群里的验证码，而那条路依赖机器人没被风控。
 * 所以这里不拦，但把后果说清楚。
 */
export async function removePassword(input: { current: string }): Promise<PasswordResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const existing = passwordCredentialOf(user.id);
  if (!existing) return { ok: false, error: "本来就没有设置密码" };
  if (!verifyPassword(input.current, existing.secret)) {
    return { ok: false, error: "密码不对" };
  }

  db.update(credentials)
    .set({ revokedAt: Date.now(), revokeReason: "用户自己删除" })
    .where(eq(credentials.id, existing.id))
    .run();

  const passkeys = db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.userId, user.id),
        eq(credentials.type, "passkey"),
        isNull(credentials.revokedAt),
      ),
    )
    .all().length;

  revalidatePath("/me/security");
  return {
    ok: true,
    note:
      passkeys > 0
        ? "密码已删除，你还有 Passkey 可以登录"
        : "密码已删除。你现在只能靠群里的验证码登录 —— 那条路依赖群猫娘没被风控",
  };
}
