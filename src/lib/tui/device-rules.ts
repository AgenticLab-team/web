import { DANGEROUS_SCOPES, SCOPE_KEYS, type ScopeKey } from "@/lib/api-tokens/rules";

/**
 * 终端客户端的设备码登录 —— 纯规则。不碰数据库、不碰网络。
 *
 * ═════════════════════════════════════════
 * 这不是 `docs/OAUTH-PROVIDER.md` 里被否掉的那个 device flow
 * ═════════════════════════════════════════
 *
 * 那份文档第七节写着「不做 device flow」，否的是**给第三方应用的**：
 * 让一段我们没 review 过的代码，用一串码换到「以某个成员的身份行事」。
 * 否的理由是钓鱼 —— OAuth 的钓鱼不靠伪造页面，靠伪造应用。
 *
 * 这里的设备码只发给第一方客户端：**没有 `client_id`，
 * 也就没有「哪个应用」这个概念可以被伪造**。确认页上写死的是
 * 「Agentic Lab 终端客户端」，不接受任何应用名。
 *
 * 两份文档没有冲突，但它们长得像，所以这段话必须在这里，
 * 而不是只在 `TUI.md` 里 —— 下一个改这个文件的人未必读过那份。
 *
 * ═════════════════════════════════════════
 * 它挡不住什么，写在前面
 * ═════════════════════════════════════════
 *
 * 挡不住「攻击者把自己屏幕上的码念给你听，骗你去网页上确认」。
 * 这是所有设备码流程的共同弱点，没有协议层的解法。
 * 缓解手段全在确认页上（设备指纹、发起 IP、来源是不是 SSH），
 * 也就是说**那一页的内容是安全设计，不是文案**。
 */

/**
 * 用户码的字母表。
 *
 * ─────────────────────────────────────────
 * 抠掉的那几个字符是这条规则的全部内容
 * ─────────────────────────────────────────
 *
 * `0/O`、`1/I/L` 在绝大多数等宽字体里长得几乎一样，而这串码的
 * 使用方式恰恰是**人盯着终端念、在手机上敲**。
 *
 * 留着它们的后果不是「偶尔输错」——是一个输错的人会认为
 * 「这个登录坏了」，而不是「我看错了一个字符」。他不会再试第二次。
 *
 * 抠掉之后是 31 个字符，8 位约 39 位熵。配合 10 分钟过期、
 * 尝试次数上限和限流，够了。
 */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** 用户码总长度（不含中间那个连字符） */
export const CODE_LENGTH = 8;

/** 显示时在正中间断开：`WXYZ-7Q2M` 比 `WXYZ7Q2M` 好念也好核对 */
export function formatUserCode(raw: string): string {
  const s = raw.toUpperCase();
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/**
 * 把人敲进来的东西收拾成标准形。
 *
 * 大小写、连字符、空格、以及**从终端里复制粘贴时带上的不间断空格**
 * 全部抹平。不抹的话，一个粘贴过来的码会因为一个看不见的字符被拒，
 * 而人在屏幕上看到的两串字符一模一样 —— 那是最难自我诊断的一种失败。
 */
export function normalizeUserCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  // 分隔符一律抹掉：空格、全角空格、连字符、下划线，以及粘贴时带上的不间断空格
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== CODE_LENGTH) return null;
  if (![...cleaned].every((c) => CODE_ALPHABET.includes(c))) return null;
  return cleaned;
}

/**
 * 输错了的话，告诉他**错在哪个字符上**。
 *
 * ─────────────────────────────────────────
 * 为什么不「顺手纠正」
 * ─────────────────────────────────────────
 *
 * 字母表里没有 `O I L 0 1`，所以人敲出这几个字符一定是看错了。
 * 很诱人的做法是猜一个纠回去（`O → Q`？`1 → 7`？）——
 * 但那些猜测**都是有歧义的**：`O` 可能是把 `Q` 看漏了尾巴，
 * 也可能是把 `D` 看圆了。
 *
 * 猜错的下场比拒绝更坏：他拿到的是一句「码不对」，而他**明明照着
 * 屏幕一个字符一个字符敲的**，于是他会怀疑那串码本身，
 * 重来一遍，再错一次。
 *
 * 直接说「第 3 位那个 O，这串码里不会有它」，他一眼就能核对回去。
 */
export function explainBadCode(input: unknown): string | null {
  if (typeof input !== "string") return "没收到验证码";
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const at = [...cleaned].findIndex((c) => "OIL01".includes(c));
  if (at >= 0) {
    return `第 ${at + 1} 位是「${cleaned[at]}」，而这串码里不会出现这个字符 —— 再核对一下屏幕上那一位`;
  }
  if (cleaned.length !== CODE_LENGTH) {
    return `这串码是 ${CODE_LENGTH} 位，你输了 ${cleaned.length} 位`;
  }
  const bad = [...cleaned].findIndex((c) => !CODE_ALPHABET.includes(c));
  if (bad >= 0) return `第 ${bad + 1} 位那个「${cleaned[bad]}」不在这串码用的字符里`;
  return null;
}

/**
 * 码的有效期。
 *
 * 10 分钟：短到一串被偷看的码很快作废，长到够一个人
 * 「拿起手机、解锁、打开微信里的浏览器、登录、输码」——
 * 实测这一串动作在没准备的情况下要三四分钟。
 *
 * 定成 2 分钟的话，多数人第一次会失败，而失败的表现是
 * 「输完提示码已过期」—— 他不会知道自己只是慢了。
 */
export const CODE_TTL_MS = 10 * 60_000;

/** 终端多久轮询一次（秒）。5 秒是「看起来即时」和「别打满服务器」之间的位置 */
export const POLL_INTERVAL_SECONDS = 5;

/**
 * 轮询太快时把间隔翻倍，但有上限。
 *
 * 没有上限的话，一个写错的客户端会被推到几分钟一次 ——
 * 那时候人在网页上点了「同意」，终端要等好几分钟才反应过来，
 * 而他会以为是确认失败了。
 */
export const MAX_POLL_INTERVAL_SECONDS = 30;

export function nextPollInterval(current: number): number {
  return Math.min(current * 2, MAX_POLL_INTERVAL_SECONDS);
}

/**
 * 用户码最多能被输错几次。
 *
 * 39 位熵下暴力猜是不现实的，这条挡的是**另一件事**：
 * 有人拿着一个过期的/别人的码反复试，试出别人正在登录的那一串。
 * 超过就把这一条作废 —— 让攻击者从头开始，而不是继续试。
 */
export const MAX_CODE_ATTEMPTS = 5;

export type DeviceSource = "cli" | "ssh";

/**
 * 这个来源可以申请哪些 scope。
 *
 * ═════════════════════════════════════════
 * SSH 网关上不给 `groups:send`，也不给 `admin:all`
 * ═════════════════════════════════════════
 *
 * 网关是一台**公开可连、而且持有他人令牌**的机器（见 `TUI.md` 第三节）。
 * 在它上面默认打开「往一千六百人的群里发消息」，等于把
 * `lib/api-tokens/rules.ts` 顶上那段风险乘以在线人数。
 *
 * 本地二进制不一样：令牌只在这个人自己的机器上，
 * 泄漏的范围和他的其它凭据一样大，不多不少。
 *
 * 这不是「默认不勾」，是**根本不在可申请列表里** ——
 * 默认不勾的东西迟早会被某个版本的界面默认勾上。
 */
export function offerableScopes(source: DeviceSource): ScopeKey[] {
  if (source === "cli") return [...SCOPE_KEYS];
  return SCOPE_KEYS.filter((k) => !DANGEROUS_SCOPES.includes(k));
}

/**
 * 把终端申请的 scope 收拾干净：认不出的丢掉、这个来源不许的丢掉。
 *
 * **丢掉而不是报错**：报错会让整次登录失败，而人看到的是
 * 「登录失败」四个字 —— 他不可能推断出是某一项权限的问题。
 * 少给一项的话，他会在真正用到那个功能时看到一句准确的解释。
 */
export function allowedScopes(raw: unknown, source: DeviceSource): ScopeKey[] {
  const offerable = offerableScopes(source);
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>(raw.filter((x): x is string => typeof x === "string"));
  return offerable.filter((k) => seen.has(k));
}

/**
 * 令牌活多久。
 *
 * SSH 来的短得多，理由同上：网关持有别人的令牌，
 * 而**能被撤销的东西才谈得上安全**，7 天是「不用天天重登」
 * 和「一次失守的窗口有多长」之间的位置。
 *
 * 本地那把 90 天。不设成永不过期是因为
 * `api_tokens.last_used_at` 那一列的注释已经说过了：
 * 一把半年没动过的令牌十有八九是某次调试留下的，而它仍然能发消息。
 */
export function tokenTtlMs(source: DeviceSource): number {
  return source === "ssh" ? 7 * 24 * 3600_000 : 90 * 24 * 3600_000;
}

/** 令牌列表里显示的名字。要能一眼答出「这把是哪台机器上的」 */
export function tokenNameFor(source: DeviceSource, label: string): string {
  const clean = label.replace(/[\r\n]/g, " ").trim().slice(0, 60) || "未知设备";
  return source === "ssh" ? `SSH 网关 · ${clean}` : `终端 · ${clean}`;
}

/* ── 设备指纹 ─────────────────────────────────────────── */

export interface DeviceFingerprint {
  /** 机器名 */
  host: string;
  /** 终端类型（$TERM）与尺寸 */
  term: string;
  os: string;
  /** 客户端版本 */
  version: string;
}

/**
 * 确认页上要显示的那一行。
 *
 * ═════════════════════════════════════════
 * 它是这套流程里唯一一处「用户能自己发现不对劲」的地方
 * ═════════════════════════════════════════
 *
 * 所以它显示的必须是**用户自己认得出的东西**：机器名和终端类型。
 * 显示一串设备 id 等于没显示 —— 没有人知道自己的设备 id 是什么，
 * 于是每个人都会直接点同意，包括被骗的那一个。
 *
 * 全部字段都是客户端自己报的，也就是说**它们可以是假的**。
 * 这不削弱它的价值：攻击者能伪造成「你的机器」，
 * 但他伪造不出你此刻真的在登录这件事 —— 页面上那句
 * 「如果你现在没有在终端里登录，关掉这一页」才是判据。
 */
export function describeDevice(fp: Partial<DeviceFingerprint>): string {
  const parts = [fp.host, fp.os, fp.term].map((s) => (s ?? "").trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(" · ").slice(0, 120) : "未报上名字的设备";
}

/** 客户端报上来的东西一律当成不可信的字符串处理 */
export function sanitizeFingerprint(raw: unknown): DeviceFingerprint {
  const o = (raw ?? {}) as Record<string, unknown>;
  const pick = (k: string, max = 40) =>
    typeof o[k] === "string" ? (o[k] as string).replace(/[\r\n\t]/g, " ").trim().slice(0, max) : "";
  return { host: pick("host"), term: pick("term"), os: pick("os"), version: pick("version", 20) };
}

/* ── 轮询的回答 ───────────────────────────────────────── */

/**
 * 轮询的四种结果。**用 OAuth 那套错误码的名字**（`authorization_pending`
 * / `slow_down` / `expired_token` / `access_denied`）——
 * 不是为了兼容任何东西，是因为写客户端的人见过它们。
 * 自创一套名字只会让每个人都去读一遍文档。
 */
export type PollOutcome =
  | { state: "pending"; error: "authorization_pending" }
  | { state: "slow_down"; error: "slow_down"; interval: number }
  | { state: "expired"; error: "expired_token" }
  | { state: "denied"; error: "access_denied" }
  | { state: "granted" };

export interface PollInput {
  /** 这条码的状态 */
  status: "pending" | "approved" | "denied";
  expiresAt: number;
  /** 上一次轮询是什么时候；从没轮询过传 null */
  lastPolledAt: number | null;
  /** 客户端当前用的间隔（秒） */
  interval: number;
  now: number;
}

/**
 * 该回什么。
 *
 * ─────────────────────────────────────────
 * 过期要排在「已同意」前面判吗？不
 * ─────────────────────────────────────────
 *
 * 一个人在最后一秒点了同意，而终端下一次轮询落在过期之后 ——
 * 这在 5 秒间隔下是常事。先判过期的话他会看到「码已过期」，
 * 而他明明刚刚点了同意，屏幕上还留着那一页。
 *
 * 所以**已经同意了就发令牌**，过期只对还没决定的那些生效。
 * 安全上不亏：同意这个动作本身已经发生在有效期内了。
 */
export function pollOutcome(input: PollInput): PollOutcome {
  if (input.status === "approved") return { state: "granted" };
  if (input.status === "denied") return { state: "denied", error: "access_denied" };
  if (input.now >= input.expiresAt) return { state: "expired", error: "expired_token" };

  if (input.lastPolledAt !== null) {
    const elapsed = input.now - input.lastPolledAt;
    /*
     * 留 500 毫秒余量。客户端按 5 秒睡，但网络抖动会让它
     * 偶尔早到几十毫秒 —— 卡得死死的话，一个完全守规矩的客户端
     * 会被随机地推到 10 秒、20 秒，最后慢到人以为它卡住了。
     */
    if (elapsed + 500 < input.interval * 1000) {
      return { state: "slow_down", error: "slow_down", interval: nextPollInterval(input.interval) };
    }
  }
  return { state: "pending", error: "authorization_pending" };
}
