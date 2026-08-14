import "server-only";

import { createHash, randomInt, timingSafeEqual } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { credentials, users } from "@/lib/db/schema";

import { sendMail, senderConfigured } from "./sender";

/**
 * 验证私人邮箱 —— **转发那个开关的前提**。
 *
 * ═════════════════════════════════════════
 * 没有这一步的话，转发是一个永远不会生效的开关
 * ═════════════════════════════════════════
 *
 * `canForward` 要求目标地址验证过（`users.email_verified_at`），
 * 而站里原本**没有任何地方写那一列** —— 登录靠微信绑定码和 Passkey，
 * 邮箱一直只是个资料字段。
 *
 * 也就是说：不做这一步，转发做完了也永远拒绝。
 * 而那正是这个仓库最不想要的形状 —— 一个显示成「开着」、
 * 按下去什么都不发生的开关。
 *
 * ─────────────────────────────────────────
 * 验证码存在 `credentials` 里，不新开一张表
 * ─────────────────────────────────────────
 *
 * 那张表的 `type` 枚举里本来就有 `email_magic` 这一档 ——
 * 它是为这件事留的。新开一张表的代价不是那张表本身，
 * 是**账号注销那条路要多记一处**（`DELETION_PLAN`），
 * 而漏记一处的后果是注销之后验证码还留着。
 */

/** 验证码活多久。短一点 —— 它是发到邮箱里的，人拿到就会用 */
const CODE_TTL_MS = 15 * 60_000;

const hash = (code: string) => createHash("sha256").update(code).digest("hex");

export type VerifyResult = { ok: true } | { ok: false; error: string };

/**
 * 填一个私人邮箱并发验证码。
 *
 * ⚠️ 填的那一刻就**把旧的验证状态清掉**：改了地址之后旧地址
 * 不该还留着「已验证」——否则改地址就成了绕过验证的方法。
 */
export async function startEmailVerification(input: {
  userId: string;
  email: string;
}): Promise<VerifyResult> {
  if (!senderConfigured()) {
    // 发不出去就别让他填 —— 一个填完永远收不到码的表单最让人上火
    return { ok: false, error: "站里还没配发信服务，暂时验证不了" };
  }

  const email = input.email.trim().toLowerCase();
  /*
   * 校验松一点：这里不做「这个地址真的存在吗」的判断 ——
   * 那正是发验证码这件事本身在回答的问题。
   * 只挡明显不是地址的输入。
   */
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: "这看起来不是一个邮箱地址" };
  }

  const taken = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .get();
  if (taken && taken.id !== input.userId) {
    /*
     * 「已经有人用了」和「地址不合法」说不同的话是有意的：
     * 前者他换一个就行，后者他要检查自己是不是打错了。
     */
    return { ok: false, error: "这个邮箱已经绑在别的账号上了" };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");

  db.update(users)
    .set({ email, emailVerifiedAt: null, updatedAt: Date.now() })
    .where(eq(users.id, input.userId))
    .run();

  // 同一个人只留一份待验证的码 —— 留一堆的话，「哪个是最新的」没有答案
  db.delete(credentials)
    .where(and(eq(credentials.userId, input.userId), eq(credentials.type, "email_magic")))
    .run();

  db.insert(credentials)
    .values({
      userId: input.userId,
      type: "email_magic",
      // 存哈希，不存明文 —— 库被看到的时候它不该是一把能直接用的钥匙
      secret: `${hash(code)}:${Date.now() + CODE_TTL_MS}`,
      name: email,
    })
    .run();

  const sent = await sendMail({
    to: email,
    subject: "Agentic Lab 邮箱验证码",
    text:
      `你的验证码是 ${code}\n\n` +
      `${Math.round(CODE_TTL_MS / 60_000)} 分钟内有效。\n\n` +
      `这个码用来把这个邮箱设成你在 Agentic Lab 的转发地址。\n` +
      `不是你本人操作的话，忽略这封信就行 —— 没有这个码，什么都不会发生。`,
  });

  if (!sent.ok) return { ok: false, error: `验证码没发出去：${sent.error}` };
  return { ok: true };
}

/** 填验证码。对了就把 `email_verified_at` 写上 —— 转发那道闸认的就是它 */
export function confirmEmailVerification(input: {
  userId: string;
  code: string;
}): VerifyResult {
  const row = db
    .select()
    .from(credentials)
    .where(and(eq(credentials.userId, input.userId), eq(credentials.type, "email_magic")))
    .get();

  if (!row) return { ok: false, error: "没有待验证的邮箱 —— 先填一个地址" };

  const [want, expiresAt] = row.secret.split(":");
  if (Number(expiresAt) < Date.now()) {
    db.delete(credentials).where(eq(credentials.id, row.id)).run();
    return { ok: false, error: "验证码过期了，重新发一个" };
  }

  const got = hash(input.code.trim());
  /*
   * `timingSafeEqual` 而不是 `===`：字符串比较会在第一个不同的字节上
   * 返回，而那个时间差足以让人逐字节猜出验证码。
   * 六位数字本来就只有一百万种，别再送他一个旁路。
   */
  const a = Buffer.from(got);
  const b = Buffer.from(want ?? "");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: "验证码不对" };
  }

  db.update(users)
    .set({ emailVerifiedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(users.id, input.userId))
    .run();
  // 用过就删 —— 一个码只有一次机会
  db.delete(credentials).where(eq(credentials.id, row.id)).run();

  return { ok: true };
}
