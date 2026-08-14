import "server-only";

import { createHash, randomBytes, randomInt } from "node:crypto";

import { and, eq, lt } from "drizzle-orm";

import { createToken } from "@/lib/api-tokens/store";
import type { ScopeKey } from "@/lib/api-tokens/rules";
import { db } from "@/lib/db";
import { deviceCodes } from "@/lib/db/schema";

import {
  CODE_ALPHABET,
  CODE_LENGTH,
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  POLL_INTERVAL_SECONDS,
  allowedScopes,
  normalizeUserCode,
  pollOutcome,
  tokenNameFor,
  tokenTtlMs,
  type DeviceSource,
  type PollOutcome,
} from "./device-rules";

/**
 * 设备码登录的存取。规则在 `device-rules.ts`，这里只落库和查库。
 *
 * ═════════════════════════════════════════
 * 这个文件里**不许出现 createSession，也不许 insert(users)**
 * ═════════════════════════════════════════
 *
 * 和 `lib/github/link.ts` 顶上那条同源：这个站唯一的门是微信群，
 * 账号只能靠在群里向机器人发验证码建立。
 *
 * 设备码是在那扇门旁边开的一个窗口 —— 它把「以某个已有成员的身份
 * 调 API」这件事交给了一台机器。它**不发账号**。
 *
 * 如果这条在这里被绕过去，等于把整个站对全世界开放，
 * 而且没有任何外部症状：站长自己点一下是能进的。
 * `tests/tui-device.test.ts` 逐条钉死这一点。
 */

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * 生成用户码。
 *
 * 用 `randomInt` 而不是 `Math.random()`：这串码是一次登录的
 * 一半凭据，可预测的随机数在这里等于没有随机数。
 *
 * 也不用「取随机字节再取模」—— 那会让字母表里靠前的字符
 * 出现得更频繁（模偏差），`randomInt` 自己处理了这件事。
 */
function makeUserCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

export interface StartInput {
  source: DeviceSource;
  /** 终端自报的机器名 · 系统 · 终端类型 */
  label: string;
  /** 发起请求的 IP —— 确认页上唯一不由客户端自报的东西 */
  ip: string | null;
  /** 终端申请哪些 scope */
  scopes: unknown;
  /** SSH 网关来的：这条码绑在哪把公钥上 */
  sshKeyFingerprint?: string | null;
}

export interface StartedDevice {
  /** 显示给人的那一串（未格式化，调用方自己加连字符） */
  userCode: string;
  /** 终端自己揣着，从不显示 */
  deviceCode: string;
  expiresAt: number;
  interval: number;
  scopes: ScopeKey[];
}

export function startDevice(input: StartInput): StartedDevice {
  const scopes = allowedScopes(input.scopes, input.source);
  const deviceCode = randomBytes(32).toString("base64url");

  /*
   * 用户码要保证不撞。
   *
   * 31^8 下撞的概率极低，但「极低」不等于零，而撞上的后果很坏：
   * 唯一索引会让 insert 抛异常，人看到的是「登录失败」——
   * 一个重试就能解决、却完全无法自我诊断的失败。
   *
   * 重试三次。三次都撞说明表里堆了海量未过期的码，
   * 那是另一个问题（限流没生效），不该在这里静默吞掉。
   */
  for (let attempt = 0; attempt < 3; attempt++) {
    const userCode = makeUserCode();
    const userCodeHash = sha256(userCode);
    const existing = db
      .select({ id: deviceCodes.id })
      .from(deviceCodes)
      .where(eq(deviceCodes.userCodeHash, userCodeHash))
      .get();
    if (existing) continue;

    const expiresAt = Date.now() + CODE_TTL_MS;
    db.insert(deviceCodes)
      .values({
        userCodeHash,
        deviceCodeHash: sha256(deviceCode),
        status: "pending",
        source: input.source,
        deviceLabel: input.label.slice(0, 120) || "未知设备",
        requestIp: input.ip,
        scopes,
        sshKeyFingerprint: input.sshKeyFingerprint ?? null,
        expiresAt,
        pollInterval: POLL_INTERVAL_SECONDS,
      })
      .run();

    return { userCode, deviceCode, expiresAt, interval: POLL_INTERVAL_SECONDS, scopes };
  }

  throw new Error("生成设备码连续撞车 —— 检查过期清理和限流");
}

/* ── 网页那一侧 ───────────────────────────────────────── */

export interface PendingDevice {
  id: string;
  source: DeviceSource;
  deviceLabel: string;
  requestIp: string | null;
  scopes: ScopeKey[];
  createdAt: number;
  expiresAt: number;
  sshKeyFingerprint: string | null;
}

export type LookupResult =
  | { ok: true; device: PendingDevice }
  | { ok: false; reason: "not_found" | "expired" | "used" };

/**
 * 按用户码找那条待批的登录。
 *
 * ─────────────────────────────────────────
 * 「没找到」和「过期了」要分开说
 * ─────────────────────────────────────────
 *
 * 合成一句「无效的验证码」的话，一个慢了半分钟的人会以为
 * 自己敲错了，然后把同一串码再敲一遍 —— 再错一次。
 * 而他真正要做的是回终端里按一下重新生成。
 *
 * 这里不怕泄露信息：能查到「这串码存在但过期了」，
 * 前提是他已经知道那串码。
 */
export function lookupByUserCode(raw: unknown): LookupResult {
  const code = normalizeUserCode(raw);
  if (!code) return { ok: false, reason: "not_found" };

  const row = db
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.userCodeHash, sha256(code)))
    .get();
  if (!row) return { ok: false, reason: "not_found" };

  // 换走令牌的那一行已经被删掉了，所以能查到就只剩「批过 / 拒过」两种可能
  if (row.status !== "pending") return { ok: false, reason: "used" };

  /*
   * 尝试次数加在**找到之后**，而不是每次调用都加。
   *
   * 加在前面的话，任何人往这个接口灌随机串都会推高某一条的计数 ——
   * 而那一条是别人正在进行的登录。也就是说那种写法会让
   * 「防止试码」的机制本身变成一个拒绝服务的工具。
   */
  const tries = row.wrongCodeTries + 1;
  db.update(deviceCodes).set({ wrongCodeTries: tries }).where(eq(deviceCodes.id, row.id)).run();
  if (tries > MAX_CODE_ATTEMPTS) {
    db.update(deviceCodes).set({ status: "denied" }).where(eq(deviceCodes.id, row.id)).run();
    return { ok: false, reason: "not_found" };
  }

  if (Date.now() >= row.expiresAt) return { ok: false, reason: "expired" };

  return {
    ok: true,
    device: {
      id: row.id,
      source: row.source,
      deviceLabel: row.deviceLabel,
      requestIp: row.requestIp,
      scopes: (row.scopes as ScopeKey[]) ?? [],
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      sshKeyFingerprint: row.sshKeyFingerprint,
    },
  };
}

/**
 * 同意。
 *
 * `userId` 是**从会话里取的那个真实的人**（`getRealUser()`），
 * 调用方负责。传预览态下那个被预览的人的话，令牌会发给别人 ——
 * 这正是 `ARCHITECTURE.md` 第四节里已经踩过三次的那个坑。
 */
export function approveDevice(
  id: string,
  userId: string,
  /** 用户在确认页上最终勾了哪些 —— 只能是申请集合的子集 */
  grantedScopes: readonly ScopeKey[],
): boolean {
  const row = db.select().from(deviceCodes).where(eq(deviceCodes.id, id)).get();
  if (!row || row.status !== "pending") return false;
  if (Date.now() >= row.expiresAt) return false;

  /*
   * 只能收窄，不能扩。
   *
   * 页面上的勾选框是客户端提交的，也就是说提交内容完全可以被改。
   * 不做这一步的话，一个申请了 `me:read` 的终端可以在提交那一刻
   * 变成申请 `groups:send` —— 而用户在页面上从头到尾没见过那一项。
   */
  const asked = new Set((row.scopes as ScopeKey[]) ?? []);
  const granted = grantedScopes.filter((s) => asked.has(s));

  const result = db
    .update(deviceCodes)
    .set({
      status: "approved",
      approvedByUserId: userId,
      approvedAt: Date.now(),
      scopes: granted,
    })
    .where(and(eq(deviceCodes.id, id), eq(deviceCodes.status, "pending")))
    .run();
  return result.changes > 0;
}

export function denyDevice(id: string, userId: string): boolean {
  const result = db
    .update(deviceCodes)
    .set({ status: "denied", approvedByUserId: userId, approvedAt: Date.now() })
    .where(and(eq(deviceCodes.id, id), eq(deviceCodes.status, "pending")))
    .run();
  return result.changes > 0;
}

/* ── 终端那一侧 ───────────────────────────────────────── */

export type PollResult =
  | { granted: false; outcome: Exclude<PollOutcome, { state: "granted" }> }
  | {
      granted: true;
      token: string;
      scopes: ScopeKey[];
      expiresAt: number | null;
    };

/**
 * 终端轮询。换到令牌的那一次会**删掉这一行**。
 *
 * ─────────────────────────────────────────
 * 为什么是删，不是标记「已用」
 * ─────────────────────────────────────────
 *
 * 标记的话，这张表会长期存着一批已完成的登录，
 * 而每一行都还带着 `device_code_hash` —— 每一行都是一次
 * 「如果哪天判定写错了就能再换一把令牌」的机会。
 * 删掉才没有第二次机会。
 *
 * （`docs/OAUTH-PROVIDER.md` 第六节对 `oauth_codes` 写的是同一句。）
 */
export function pollDevice(deviceCode: unknown): PollResult | null {
  if (typeof deviceCode !== "string" || deviceCode.length < 20) return null;

  const row = db
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.deviceCodeHash, sha256(deviceCode)))
    .get();
  if (!row) return null;

  const now = Date.now();
  const outcome = pollOutcome({
    status: row.status,
    expiresAt: row.expiresAt,
    lastPolledAt: row.lastPolledAt,
    interval: row.pollInterval,
    now,
  });

  if (outcome.state !== "granted") {
    db.update(deviceCodes)
      .set({
        lastPolledAt: now,
        pollInterval: outcome.state === "slow_down" ? outcome.interval : row.pollInterval,
      })
      .where(eq(deviceCodes.id, row.id))
      .run();
    return { granted: false, outcome };
  }

  const userId = row.approvedByUserId;
  /*
   * 状态是 approved 而没有批准人，说明有人直接改了库。
   * 当成「找不到」而不是抛异常：抛出去会变成 500，
   * 而 500 在客户端那边会被当成网络问题一直重试。
   */
  if (!userId) return null;

  const scopes = (row.scopes as ScopeKey[]) ?? [];
  const ttl = tokenTtlMs(row.source);
  const created = createToken({
    userId,
    name: tokenNameFor(row.source, row.deviceLabel),
    scopes,
    expiresAt: now + ttl,
    source: row.source === "ssh" ? "ssh" : "device",
    deviceLabel: row.deviceLabel,
  });

  db.delete(deviceCodes).where(eq(deviceCodes.id, row.id)).run();

  return { granted: true, token: created.plaintext, scopes, expiresAt: now + ttl };
}

/**
 * 清掉过期的码。
 *
 * 挂在 health 那一轮里。不清的话这张表只增不减，
 * 而 `startDevice` 里那个「用户码撞车」的重试会随着表变大
 * 越来越容易触发 —— 一个几个月后才发作、且症状是
 * 「偶尔登录失败」的问题。
 */
export function sweepExpiredDeviceCodes(now = Date.now()): number {
  /*
   * 多留一小时再删。
   *
   * 卡着过期时间删的话，一个刚过期的人在网页上输码会拿到
   * 「没有这串码」，而正确的说法是「过期了，回终端重新生成」——
   * 两句话导向的下一步动作完全不同。
   */
  const result = db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, now - 3600_000)).run();
  return result.changes;
}
