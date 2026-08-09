import "server-only";

import { and, desc, eq, gt, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { credentials, loginAttempts, users } from "@/lib/db/schema";
import {
  GENERIC_LOGIN_ERROR,
  LOCKOUT_THRESHOLD,
  checkLockout,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "@/lib/auth/password";
import { isPrivileged, passwordLoginVerdict } from "@/lib/auth/passkey-policy";
import { effectivePermissions } from "@/lib/rbac/can";
import { getSettingBool } from "@/lib/settings/store";

/**
 * 密码兜底登录的服务端部分。
 *
 * ─────────────────────────────────────────
 * 它不是一条能注册的路
 * ─────────────────────────────────────────
 *
 * 只有**已经存在且已激活**的账号才验得过。密码不能创建账号，
 * 也不能激活一个 pending 的账号 —— 这个站的入口只有一个：
 * 微信群里那条验证码。密码只是在那扇门暂时打不开时的备用钥匙。
 *
 * ─────────────────────────────────────────
 * 无论成败都要花掉一次哈希的时间
 * ─────────────────────────────────────────
 *
 * 账号不存在时直接返回，会让「这个微信号在不在社群里」
 * 从响应时间上漏出去 —— 而群成员名单是隐私。
 * 所以查不到人的时候也照样算一次 scrypt。
 */

export interface LoginResult {
  ok: boolean;
  userId?: string;
  error?: string;
  retryAfterSeconds?: number;
}

/** 用来消耗时间的假哈希 —— 参数与真的一致，所以耗时也一致 */
const DUMMY_HASH = hashPassword("this-value-is-never-a-real-password");

/**
 * 记一次尝试。
 *
 * `now` 必须一路传进来，不能靠列的默认值 ——
 * **半截注入的时钟比没有更糟**：读的时候用注入的时间、写的时候用真实时间，
 * 于是锁定逻辑在测试里永远触发不了，而测试是绿的。
 * 这一条就是这么被发现的。
 */
function recordAttempt(input: {
  userId: string | null;
  identifier: string;
  success: boolean;
  reason?: string;
  ip?: string;
  userAgent?: string;
  now: number;
}) {
  db.insert(loginAttempts)
    .values({
      userId: input.userId,
      identifier: input.identifier,
      method: "password",
      success: input.success,
      failureReason: input.reason,
      ip: input.ip,
      userAgent: input.userAgent,
      createdAt: input.now,
    })
    .run();
}

/** 这个账号最近连续失败了几次 */
export function recentFailures(userId: string, now = Date.now()) {
  const rows = db
    .select({ success: loginAttempts.success, createdAt: loginAttempts.createdAt })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.userId, userId),
        eq(loginAttempts.method, "password"),
        gt(loginAttempts.createdAt, now - 3600_000),
      ),
    )
    .orderBy(desc(loginAttempts.createdAt))
    .limit(20)
    .all();

  let failures = 0;
  let lastFailureAt: number | null = null;
  for (const row of rows) {
    // 一次成功就把连续失败清零 —— 否则昨天输错几次会一直挂着
    if (row.success) break;
    if (lastFailureAt === null) lastFailureAt = row.createdAt;
    failures++;
  }
  return { failures, lastFailureAt };
}

export function passwordCredentialOf(userId: string) {
  return (
    db
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.userId, userId),
          eq(credentials.type, "password"),
          isNull(credentials.revokedAt),
        ),
      )
      .get() ?? null
  );
}

/** 这个人有没有绑过 Passkey —— 强制策略要用它区分「去用 Passkey」和「你进不来了」 */
export function hasPasskey(userId: string): boolean {
  return (
    db
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.userId, userId),
          eq(credentials.type, "passkey"),
          isNull(credentials.revokedAt),
        ),
      )
      .all().length > 0
  );
}

export function hasPassword(userId: string): boolean {
  return passwordCredentialOf(userId) !== null;
}

/**
 * 用微信 ID + 密码登录。
 *
 * 返回的错误措辞对「没有这个人」「没设过密码」「密码不对」
 * **完全一致** —— 区分了就等于送了一个「这个微信号在不在社群里」的查询接口。
 */
export function loginWithPassword(input: {
  wxId: string;
  password: string;
  ip?: string;
  userAgent?: string;
  now?: number;
}): LoginResult {
  const now = input.now ?? Date.now();
  const identifier = input.wxId.trim();

  const user = identifier
    ? db.select().from(users).where(eq(users.wxId, identifier)).get()
    : undefined;

  const credential = user ? passwordCredentialOf(user.id) : null;

  // 账号级锁定：IP 限流挡不住「换 IP 继续试同一个人」
  if (user) {
    const lockout = checkLockout(recentFailures(user.id, now), now);
    if (lockout.locked) {
      recordAttempt({
        userId: user.id,
        identifier,
        success: false,
        reason: "locked",
        ip: input.ip,
        userAgent: input.userAgent,
        now,
      });
      return { ok: false, error: lockout.message, retryAfterSeconds: lockout.retryAfterSeconds };
    }
  }

  /*
   * 无论有没有这个人、有没有设过密码，都算一次哈希。
   * 直接返回会让响应时间把「这个微信号在不在社群里」漏出去。
   */
  const matched = verifyPassword(input.password, credential?.secret ?? DUMMY_HASH);

  if (!user || !credential || !matched) {
    recordAttempt({
      userId: user?.id ?? null,
      identifier,
      success: false,
      reason: !user ? "no_user" : !credential ? "no_password" : "bad_password",
      ip: input.ip,
      userAgent: input.userAgent,
      now,
    });
    return { ok: false, error: GENERIC_LOGIN_ERROR };
  }

  /*
   * 状态检查放在密码校验**之后**。
   * 放前面的话，「这个账号被封了」会在密码还没验之前就说出来 ——
   * 等于告诉任何人某个微信号在这个社群里且被封过。
   */
  if (user.status !== "active") {
    recordAttempt({
      userId: user.id,
      identifier,
      success: false,
      reason: `status:${user.status}`,
      ip: input.ip,
      userAgent: input.userAgent,
      now,
    });
    return {
      ok: false,
      error:
        user.status === "banned" || user.status === "suspended"
          ? "这个账号目前不能登录，去「处罚与申诉」看看"
          : GENERIC_LOGIN_ERROR,
    };
  }

  /*
   * 管理员强制 Passkey。
   *
   * ─────────────────────────────────────────
   * 位置和状态检查一样，必须在密码验完之后
   * ─────────────────────────────────────────
   *
   * 放前面的话，「这个账号有管理权限」会在密码还没验之前就说出来 ——
   * 等于给了一个「这个微信号是不是管理员」的免密查询接口，
   * 而那正是攻击者最想先知道的一件事。
   *
   * 这个开关在库里躺了很久没人读（默认值还是 true，设置页显示成开着的）。
   * 一个显示成「开」的安全开关，效果是让人不再去想这件事 ——
   * 它把「管理员账号只有一道密码」这个事实藏了起来。
   */
  const verdict = passwordLoginVerdict({
    privileged: isPrivileged(effectivePermissions(user).keys()),
    hasPasskey: hasPasskey(user.id),
    enforced: getSettingBool("auth.require_passkey_for_admin", true),
  });

  if (!verdict.allowed) {
    recordAttempt({
      userId: user.id,
      identifier,
      success: false,
      reason: `passkey_required:${verdict.code}`,
      ip: input.ip,
      userAgent: input.userAgent,
      now,
    });
    return { ok: false, error: verdict.message };
  }

  // 参数升级：老哈希在这次登录里顺手换成当前强度
  if (needsRehash(credential.secret)) {
    db.update(credentials)
      .set({ secret: hashPassword(input.password) })
      .where(eq(credentials.id, credential.id))
      .run();
  }

  db.update(credentials)
    .set({ lastUsedAt: now, lastUsedIp: input.ip })
    .where(eq(credentials.id, credential.id))
    .run();

  recordAttempt({
    userId: user.id,
    identifier,
    success: true,
    ip: input.ip,
    userAgent: input.userAgent,
    now,
  });

  return { ok: true, userId: user.id };
}

export { LOCKOUT_THRESHOLD };
