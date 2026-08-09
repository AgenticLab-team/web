"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { credentials, users } from "@/lib/db/schema";
import { checkPassword, hashPassword, verifyPassword } from "@/lib/auth/password";
import { hasPasskey, passwordCredentialOf } from "@/lib/auth/password-login";
import { assertNotPreviewing, getCurrentUser } from "@/lib/auth/session";

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
  /*
   * 预览态要拦。getCurrentUser 在预览态下返回**被预览的那个人**，
   * 而首次设密码不需要旧密码 —— 不拦的话，预览中的管理员
   * 一次误触就给别人的账号装了一把自己知道的钥匙。
   */
  await assertNotPreviewing();
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

  /*
   * 设了密码就自动退出「不设密码」状态，不要求先手动取消 ——
   * 设密码这个动作本身就是最明确的改主意。反过来两个状态并存的话，
   * 安全页会同时显示「已设置密码」和「这个账号不设密码」，
   * 谁看谁糊涂。
   */
  db.update(users)
    .set({ passwordOptOutAt: null, updatedAt: Date.now() })
    .where(eq(users.id, user.id))
    .run();

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
  // 同 setPassword：预览态下 getCurrentUser 是别人，不能替他删钥匙
  await assertNotPreviewing();
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

/**
 * 「这个账号就是不设密码」—— 把这句话记下来或收回。
 *
 * 为什么值得单独一个状态：没有它，「还没设」和「决定不设」在数据上
 * 长得一模一样，安全页只能对着后者反复劝设密码 ——
 * 被反复劝的人最后会把真正重要的提醒（比如「你连 Passkey 都没有」）
 * 一起无视掉。表过态的人，页面就该闭嘴，只在门路真的只剩一条时再开口。
 *
 * 有密码时不允许直接表态「不设密码」：那句话和现实矛盾。
 * 想过去就先删密码 —— 删除那一步会验旧密码，顺便挡住
 * 「没锁屏的电脑被人点了一下」这种误触。
 */
export async function setPasswordlessIntent(input: { optOut: boolean }): Promise<PasswordResult> {
  // 预览态下 getCurrentUser 是别人，不能替他表态
  await assertNotPreviewing();
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  if (input.optOut && passwordCredentialOf(user.id)) {
    return { ok: false, error: "你已经设了密码 —— 想改成不设密码，先把密码删掉" };
  }

  db.update(users)
    .set({ passwordOptOutAt: input.optOut ? Date.now() : null, updatedAt: Date.now() })
    .where(eq(users.id, user.id))
    .run();

  revalidatePath("/me/security");

  if (!input.optOut) {
    return { ok: true, note: "已取消。什么时候想设密码都可以" };
  }
  return {
    ok: true,
    note: hasPasskey(user.id)
      ? "记下了：这个账号不设密码，靠 Passkey 和群验证码登录"
      : "记下了。但注意你也没有 Passkey —— 现在唯一的门路是群验证码，它依赖群猫娘没被风控",
  };
}
