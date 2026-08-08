import "server-only";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { and, eq, gt, isNull, lt } from "drizzle-orm";

import { db } from "@/lib/db";
import { credentials, loginAttempts, users, webauthnChallenges } from "@/lib/db/schema";
import { env } from "@/lib/env";

/**
 * Passkey（WebAuthn）。
 *
 * 用 discoverable credential（residentKey）—— 登录时不需要先输入身份，
 * 浏览器自己弹出账号选择器。这是 Passkey 相对密码最大的体验优势，
 * 要求用户先填用户名等于把这个优势丢掉一半。
 *
 * rpID 必须与访问域名严格一致，否则浏览器直接拒绝，且错误信息很难懂。
 * 本地开发用 localhost，线上是 agenticlab.sh，见 env.webauthn。
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function storeChallenge(
  challenge: string,
  kind: "registration" | "authentication",
  userId: string | null,
  ip?: string,
) {
  const now = Date.now();
  // 顺手清掉过期的，避免这张表无限增长
  db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, now)).run();
  db.insert(webauthnChallenges)
    .values({ challenge, kind, userId, ip, expiresAt: now + CHALLENGE_TTL_MS })
    .run();
}

/**
 * 取出并**立即作废**挑战值。
 * 同一个挑战值被用第二次就是重放攻击的入口，所以消费是一次性的。
 */
export function consumeChallenge(
  challenge: string,
  kind: "registration" | "authentication",
): { userId: string | null } | null {
  const row = db
    .select()
    .from(webauthnChallenges)
    .where(
      and(
        eq(webauthnChallenges.challenge, challenge),
        eq(webauthnChallenges.kind, kind),
        isNull(webauthnChallenges.consumedAt),
        gt(webauthnChallenges.expiresAt, Date.now()),
      ),
    )
    .get();
  if (!row) return null;

  const result = db
    .update(webauthnChallenges)
    .set({ consumedAt: Date.now() })
    .where(and(eq(webauthnChallenges.id, row.id), isNull(webauthnChallenges.consumedAt)))
    .run();
  // 并发下只有一个请求能拿到这次消费
  if (result.changes === 0) return null;

  return { userId: row.userId };
}

function activePasskeys(userId: string) {
  return db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.userId, userId),
        eq(credentials.type, "passkey"),
        isNull(credentials.revokedAt),
      ),
    )
    .all();
}

// ── 注册 ─────────────────────────────────────────────────────

export async function buildRegistrationOptions(userId: string, ip?: string) {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new Error("用户不存在");

  const existing = activePasskeys(userId);

  const options = await generateRegistrationOptions({
    rpName: env.webauthn.rpName,
    rpID: env.webauthn.rpId,
    // userID 必须是字节串且稳定；用账号 id 而不是微信 id，
    // 这样将来解绑重绑微信也不会让已有的 Passkey 失效
    userID: new TextEncoder().encode(user.id),
    userName: user.wxNickname ?? user.siteNickname ?? user.id,
    userDisplayName: user.siteNickname ?? user.wxNickname ?? "Agentic Lab 成员",
    attestationType: "none",
    // 已有的凭证要排除，否则同一把钥匙会被重复注册
    excludeCredentials: existing
      .filter((c) => c.credentialId)
      .map((c) => ({
        id: c.credentialId!,
        transports: (c.transports as AuthenticatorTransportLike[] | null) ?? undefined,
      })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  storeChallenge(options.challenge, "registration", userId, ip);
  return options;
}

type AuthenticatorTransportLike = "ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";

export interface RegisterResult {
  ok: boolean;
  error?: string;
  credentialId?: string;
}

export async function completeRegistration(
  userId: string,
  response: RegistrationResponseJSON,
  opts: { name?: string; ip?: string } = {},
): Promise<RegisterResult> {
  const challenge = response.response.clientDataJSON
    ? extractChallenge(response.response.clientDataJSON)
    : null;
  if (!challenge) return { ok: false, error: "缺少挑战值" };

  const record = consumeChallenge(challenge, "registration");
  if (!record) return { ok: false, error: "挑战值已失效，请重试" };
  if (record.userId !== userId) return { ok: false, error: "挑战值与当前账号不匹配" };

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: env.webauthn.origin,
      expectedRPID: env.webauthn.rpId,
      requireUserVerification: false,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "验证失败" };
  }

  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, error: "验证未通过" };
  }

  const { credential, credentialBackedUp } = verification.registrationInfo;

  db.insert(credentials)
    .values({
      userId,
      type: "passkey",
      name: opts.name?.slice(0, 40) || "Passkey",
      credentialId: credential.id,
      // 公钥存 base64url，读出来再转回字节
      secret: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: credential.transports ?? null,
      backedUp: credentialBackedUp,
      lastUsedIp: opts.ip,
    })
    .run();

  return { ok: true, credentialId: credential.id };
}

// ── 登录 ─────────────────────────────────────────────────────

export async function buildAuthenticationOptions(ip?: string) {
  const options = await generateAuthenticationOptions({
    rpID: env.webauthn.rpId,
    // 不给 allowCredentials：让浏览器用 discoverable credential 自己列出账号。
    // 传了列表就等于向未登录的人透露「这个账号有哪些凭证」
    userVerification: "preferred",
  });

  storeChallenge(options.challenge, "authentication", null, ip);
  return options;
}

export interface LoginResult {
  ok: boolean;
  userId?: string;
  error?: string;
}

export async function completeAuthentication(
  response: AuthenticationResponseJSON,
  ctx: { ip?: string; userAgent?: string } = {},
): Promise<LoginResult> {
  const fail = (error: string, userId?: string): LoginResult => {
    db.insert(loginAttempts)
      .values({
        userId,
        method: "passkey",
        success: false,
        failureReason: error,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
      .run();
    return { ok: false, error };
  };

  const challenge = extractChallenge(response.response.clientDataJSON);
  if (!challenge) return fail("缺少挑战值");
  if (!consumeChallenge(challenge, "authentication")) return fail("挑战值已失效，请重试");

  const credential = db
    .select()
    .from(credentials)
    .where(and(eq(credentials.credentialId, response.id), isNull(credentials.revokedAt)))
    .get();
  if (!credential) return fail("凭证不存在或已撤销");

  const user = db.select().from(users).where(eq(users.id, credential.userId)).get();
  if (!user) return fail("账号不存在", credential.userId);
  // 封禁必须在这里就拦住，不能等会话建好之后再判
  if (user.status === "banned" || user.status === "deleted") {
    return fail("账号已被封禁", user.id);
  }
  if (user.status === "suspended") return fail("账号已被暂停", user.id);

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: env.webauthn.origin,
      expectedRPID: env.webauthn.rpId,
      credential: {
        id: credential.credentialId!,
        publicKey: new Uint8Array(Buffer.from(credential.secret, "base64url")),
        counter: credential.counter,
        transports: (credential.transports as AuthenticatorTransportLike[] | null) ?? undefined,
      },
      requireUserVerification: false,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "验证失败", user.id);
  }

  if (!verification.verified) return fail("验证未通过", user.id);

  const { newCounter } = verification.authenticationInfo;

  if (isClonedCredential(credential.counter, newCounter)) {
    db.update(credentials)
      .set({
        revokedAt: Date.now(),
        revokeReason: `签名计数器倒退（${credential.counter} → ${newCounter}），疑似凭证被克隆`,
      })
      .where(eq(credentials.id, credential.id))
      .run();
    return fail("检测到凭证异常，该 Passkey 已被撤销，请用微信重新验证", user.id);
  }

  db.update(credentials)
    .set({ counter: newCounter, lastUsedAt: Date.now(), lastUsedIp: ctx.ip })
    .where(eq(credentials.id, credential.id))
    .run();

  db.insert(loginAttempts)
    .values({
      userId: user.id,
      method: "passkey",
      success: true,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    })
    .run();

  return { ok: true, userId: user.id };
}

// ── 管理 ─────────────────────────────────────────────────────

export function listPasskeys(userId: string) {
  return activePasskeys(userId).map((c) => ({
    id: c.id,
    name: c.name ?? "Passkey",
    createdAt: c.createdAt,
    lastUsedAt: c.lastUsedAt,
    backedUp: c.backedUp,
  }));
}

export function revokePasskey(userId: string, credentialRowId: string, reason: string) {
  return db
    .update(credentials)
    .set({ revokedAt: Date.now(), revokedBy: userId, revokeReason: reason })
    .where(
      and(
        eq(credentials.id, credentialRowId),
        eq(credentials.userId, userId),
        isNull(credentials.revokedAt),
      ),
    )
    .run();
}

export function hasPasskey(userId: string): boolean {
  return activePasskeys(userId).length > 0;
}

/**
 * 签名计数器倒退说明这把钥匙被克隆了 —— 正品每用一次计数器加一，
 * 出现相同或更小的值意味着有人拿着复制品在用。
 *
 * 但**计数器恒为 0 是合法的**：很多平台认证器（含 iCloud 钥匙串）
 * 根本不实现计数器，一律返回 0。把 0 当成克隆会把绝大多数 iPhone 用户挡在门外。
 */
export function isClonedCredential(storedCounter: number, incomingCounter: number): boolean {
  if (storedCounter === 0) return false;
  return incomingCounter <= storedCounter;
}

/** clientDataJSON 是 base64url 编码的 JSON，挑战值藏在里面 */
export function extractChallenge(clientDataJSON: string): string | null {
  try {
    const parsed = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8"));
    return typeof parsed.challenge === "string" ? parsed.challenge : null;
  } catch {
    return null;
  }
}
