import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * 密码兜底登录。
 *
 * ─────────────────────────────────────────
 * 它是兜底，不是第二条正门
 * ─────────────────────────────────────────
 *
 * 这个站的身份锚点是**微信群里那条验证码** —— 只有群成员能登录，
 * 靠的就是那一步。密码如果能独立注册，这条规矩当场就没了。
 *
 * 所以：**只有已经登录的人才能设置密码**。它解决的是一个具体问题 ——
 * Passkey 换设备就进不来，而如果那天群猫娘刚好被风控、发不出验证码，
 * 人就被永久锁在门外了。密码是那种情况下唯一还能用的钥匙。
 *
 * ─────────────────────────────────────────
 * 用 scrypt，不用 argon2
 * ─────────────────────────────────────────
 *
 * schema 的注释里写的是 argon2id。改成 scrypt 是因为它在
 * Node 标准库里 —— 而认证是这台机器上最不该依赖第三方包的地方：
 * 一个被投毒的密码哈希库能安静地把所有人的密码带走。
 * scrypt 的强度足够，代价是少一点参数灵活性。
 */

export const MIN_LENGTH = 10;
export const MAX_LENGTH = 128;

/**
 * scrypt 参数。
 *
 * 实测（生产那台 2 核机器，2026-08）：
 *   N=2^14  54ms
 *   N=2^15 117ms   ← 用这个
 *   N=2^16 231ms
 *
 * 一次登录多花一百毫秒没人感觉得到，而爆破的人每试一次都要付同样的代价。
 * 再往上就开始影响体感了，而且这台机器只有两核 ——
 * IP 限流（每小时 20 次失败）把并发压在很低的水平，
 * 不然光是算哈希就能把 CPU 占满。
 *
 * 这里的数字是**跑出来的**，不是估的：这条注释第一版写着「约 60ms」，
 * 而实际是它的两倍。
 */
const SCRYPT_N = 32768;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LENGTH = 64;

export interface PasswordIssue {
  ok: false;
  error: string;
}

/**
 * 密码强度。
 *
 * 不要求「大小写数字符号各一个」——那套规则produce 的是
 * `Password1!` 这种既难记又好猜的东西。**长度是唯一真正有用的维度**，
 * 所以只卡长度下限，再挡掉几个一定会被先试的。
 */
const OBVIOUS = new Set([
  "password", "12345678", "123456789", "1234567890", "qwertyuiop",
  "agenticlab", "wechat", "11111111", "88888888", "aaaaaaaa",
]);

export function checkPassword(
  raw: string,
  context: { nickname?: string | null; wxId?: string | null } = {},
): { ok: true; password: string } | PasswordIssue {
  const password = raw.normalize("NFKC");

  if (password.length < MIN_LENGTH) {
    return { ok: false, error: `至少 ${MIN_LENGTH} 位 —— 长度比花样管用得多` };
  }
  if (password.length > MAX_LENGTH) {
    return { ok: false, error: `最多 ${MAX_LENGTH} 位` };
  }
  if (/^\s|\s$/.test(password)) {
    // 首尾空格几乎一定是复制粘贴带进来的，而下次手打就对不上了
    return { ok: false, error: "首尾不能有空格 —— 下次手打会对不上" };
  }

  const lower = password.toLowerCase();
  if (OBVIOUS.has(lower)) {
    return { ok: false, error: "这个密码会被最先试到，换一个" };
  }
  // 一整串同一个字符
  if (/^(.)\1+$/.test(password)) {
    return { ok: false, error: "整串都是同一个字符，换一个" };
  }

  for (const [label, value] of [
    ["昵称", context.nickname],
    ["微信 ID", context.wxId],
  ] as const) {
    if (value && value.length >= 4 && lower.includes(value.toLowerCase())) {
      return { ok: false, error: `别把${label}放进密码里` };
    }
  }

  return { ok: true, password };
}

// ── 哈希 ────────────────────────────────────────────────────

/**
 * 存储格式：`scrypt$N$r$p$salt$hash`（都是 base64url）。
 *
 * 参数一起存下来，是为了将来调高强度时**老密码还能验**——
 * 不存参数的话，改一次 N 就等于把所有人锁在门外。
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    maxmem: 128 * SCRYPT_N * SCRYPT_r * 2,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_r,
    SCRYPT_p,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

/**
 * 校验。
 *
 * 用 timingSafeEqual —— 逐字节短路比较会把「前几位对不对」
 * 透过响应时间漏出去。这在本地几乎测不出来，但它是免费的正确做法。
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (!N || !R || !P) return false;

  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(hashB64, "base64url");
    actual = scryptSync(password.normalize("NFKC"), Buffer.from(saltB64, "base64url"), expected.length, {
      N,
      r: R,
      p: P,
      maxmem: 128 * N * R * 2,
    });
  } catch {
    return false;
  }

  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** 这个哈希是不是用当前参数生成的 —— 不是的话登录成功后顺手升级 */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number(parts[1]) < SCRYPT_N;
}

// ── 锁定 ────────────────────────────────────────────────────

/** 连续失败几次就锁一会儿 */
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MS = 15 * 60_000;

export interface LockoutState {
  failures: number;
  lastFailureAt: number | null;
}

export interface LockoutVerdict {
  locked: boolean;
  retryAfterSeconds: number;
  message: string;
}

/**
 * 账号级锁定。
 *
 * IP 限流挡不住「一个 IP 试一次、换一个 IP 再试」——
 * 而针对某一个人的爆破正是这么做的。所以按账号也要计一次。
 *
 * 锁定是**有时限的**，不是永久：永久锁定意味着任何人都能靠
 * 反复输错密码把别人锁死。
 */
export function checkLockout(state: LockoutState, now: number): LockoutVerdict {
  if (state.failures < LOCKOUT_THRESHOLD || state.lastFailureAt === null) {
    return { locked: false, retryAfterSeconds: 0, message: "" };
  }

  const elapsed = now - state.lastFailureAt;
  if (elapsed >= LOCKOUT_MS) {
    return { locked: false, retryAfterSeconds: 0, message: "" };
  }

  const wait = Math.ceil((LOCKOUT_MS - elapsed) / 1000);
  return {
    locked: true,
    retryAfterSeconds: wait,
    message: `连续输错 ${state.failures} 次，${Math.ceil(wait / 60)} 分钟后再试 —— 也可以直接用群里的验证码登录`,
  };
}

/**
 * 登录失败时对外说什么。
 *
 * **不区分「没有这个人」和「密码不对」**。区分了就等于送了一个
 * 查询接口：输入一个微信号，从回答里就能知道他在不在这个社群。
 */
export const GENERIC_LOGIN_ERROR = "微信 ID 或密码不对";
