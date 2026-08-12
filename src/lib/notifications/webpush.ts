import "server-only";

import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign as signRaw,
} from "node:crypto";

import { env } from "@/lib/env";

/**
 * Web Push 协议实现（RFC 8291 载荷加密 + RFC 8292 VAPID）。
 *
 * ─────────────────────────────────────────
 * 为什么自己写而不装 web-push
 * ─────────────────────────────────────────
 *
 * 协议要的三样 Node 自带：P-256 ECDH、HKDF、AES-128-GCM。
 * web-push 那个包连带依赖会引入一串我们没有能力逐个审计的代码，
 * 而它拿到的是**给全站用户的锁屏投递权** —— 供应链上任何一环出事，
 * 攻击面直接是每个人的手机。两百行能写完的东西，不值得引一棵依赖树。
 * 正确性由 RFC 8291 附录 A 的官方测试向量锁住（tests/webpush.test.ts）。
 *
 * ─────────────────────────────────────────
 * 「没配置」的处理原则
 * ─────────────────────────────────────────
 *
 * 密钥没配时这里的一切都要**明确失败**，不能假装发出去了。
 * 更隐蔽的坏情况是「配了但配错」：只换了公钥没换私钥这种，
 * 每次推送都会被推送服务 401，而站内一切正常 —— 没人会发现。
 * 所以 configProblem() 会验证密钥对确实互相匹配，健康检查直接读它。
 */

// ── base64url ────────────────────────────────────────────────

export function b64u(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

export function b64uDecode(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

// ── 配置 ─────────────────────────────────────────────────────

export interface WebPushConfig {
  /** 未压缩 P-256 公钥，65 字节，0x04 开头 */
  publicKey: Buffer;
  /** P-256 标量，32 字节 */
  privateKey: Buffer;
  /** mailto: 或 https:，推送服务联系我们用 */
  subject: string;
}

interface RawKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** 有没有**试图**配置 —— 与「配得对不对」是两个问题，健康检查分开报 */
export function webPushConfigured(raw: RawKeys = env.webpush): boolean {
  return Boolean(raw.publicKey || raw.privateKey || raw.subject);
}

/**
 * 配置哪里不对。null 表示可用。
 *
 * 每一种坏法都给一句能直接照着改的话 ——
 * 报「配置无效」等于没报：改配置的人只能挨个瞎试。
 */
export function configProblem(raw: RawKeys = env.webpush): string | null {
  if (!raw.publicKey && !raw.privateKey && !raw.subject) {
    return "未配置 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT（生成：npm run webpush-keys）";
  }
  if (!raw.publicKey || !raw.privateKey || !raw.subject) {
    return "VAPID 配置不全：三个环境变量必须同时设置";
  }
  const publicKey = b64uDecode(raw.publicKey);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    return "VAPID_PUBLIC_KEY 不是 base64url 的未压缩 P-256 公钥（应 65 字节、0x04 开头）";
  }
  const privateKey = b64uDecode(raw.privateKey);
  if (privateKey.length !== 32) {
    return "VAPID_PRIVATE_KEY 不是 base64url 的 32 字节 P-256 私钥";
  }
  if (!/^(mailto:|https:)/.test(raw.subject)) {
    return "VAPID_SUBJECT 必须以 mailto: 或 https: 开头";
  }

  /*
   * 验证公私钥确实是一对。只换其中一个的失败模式是：
   * 每次推送被推送服务 401 拒掉，而站内一切正常，没有任何页面会变红。
   * 在这里抓出来，健康检查才有的报。
   */
  const ecdh = createECDH("prime256v1");
  try {
    ecdh.setPrivateKey(privateKey);
  } catch {
    return "VAPID_PRIVATE_KEY 不是合法的 P-256 标量";
  }
  if (!ecdh.getPublicKey().equals(publicKey)) {
    return "VAPID 公私钥不匹配 —— 是不是只换了其中一个？";
  }
  return null;
}

/** 拿到可用配置；配错与没配都返回 null，调用方据此停用而非硬撑 */
export function getWebPushConfig(raw: RawKeys = env.webpush): WebPushConfig | null {
  if (configProblem(raw)) return null;
  return {
    publicKey: b64uDecode(raw.publicKey),
    privateKey: b64uDecode(raw.privateKey),
    subject: raw.subject,
  };
}

/**
 * 给 scripts/webpush-keys.ts 用。
 *
 * ═════════════════════════════════════════
 * 私钥必须**补足 32 字节**
 * ═════════════════════════════════════════
 *
 * `ecdh.getPrivateKey()` 回的是这个大数的**最短**大端表示 ——
 * 标量的最高位字节碰巧是 0x00 时，它就只有 31 字节（实测 20 万次里
 * 有 797 次短了，约 1/250）。
 *
 * 而 32 是硬要求，不是我们自己定的规矩：RFC 8292 的 VAPID 签名走 JWK，
 * 那里的 `d` 定长 32；上面 `configProblem` 也照着这条判。
 *
 * 不补的话，这个坏法**不会在生成的时候露面**：脚本高高兴兴打印出一对
 * 看起来正常的密钥，人把它抄进 `.env.local`，然后站起不来，
 * 报的还是「VAPID_PRIVATE_KEY 不是 base64url 的 32 字节 P-256 私钥」——
 * 于是他以为是自己复制少了一个字符，回去重抄一遍，还是不行。
 * 二百五十分之一的概率，加上一句把人指向错误方向的报错。
 */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();

  // 左边补零 —— 大端数补高位不改变它的值
  const raw = ecdh.getPrivateKey();
  const privateKey = Buffer.alloc(32);
  raw.copy(privateKey, 32 - raw.length);

  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(privateKey) };
}

// ── RFC 8291 载荷加密（aes128gcm）────────────────────────────

/** 测试注入口：RFC 附录 A 的向量给定了发送方密钥与 salt，随机值必须可替换 */
export interface EncryptOverrides {
  asPrivateKey?: Buffer;
  salt?: Buffer;
}

export function encryptPayload(
  plaintext: Buffer,
  uaPublicKey: Buffer,
  authSecret: Buffer,
  overrides: EncryptOverrides = {},
): Buffer {
  // 浏览器给的订阅公钥必须是合法曲线点 —— computeSecret 会替我们校验，
  // 非法的点在这里抛异常，比拿错误的共享密钥加密后被静默丢弃好
  const ecdh = createECDH("prime256v1");
  if (overrides.asPrivateKey) ecdh.setPrivateKey(overrides.asPrivateKey);
  else ecdh.generateKeys();
  const asPublicKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublicKey);

  const salt = overrides.salt ?? randomBytes(16);

  // RFC 8291 §3.3/§3.4：两级 HKDF，info 的结尾字节都是 \0
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublicKey, asPublicKey]);
  const ikm = Buffer.from(hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));

  // 单记录消息：明文 + 0x02（最后一条记录的填充定界符，RFC 8188）
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  // 头：salt(16) | 记录大小 4096(4, BE) | keyid 长度 65(1) | 发送方公钥(65)
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(65, 20);

  return Buffer.concat([header, asPublicKey, body]);
}

// ── RFC 8292 VAPID ───────────────────────────────────────────

/**
 * 给某个推送服务签的 JWT。
 *
 * aud 只能是 endpoint 的 origin —— 带上 path 的话部分推送服务直接 403，
 * 而且报错信息不会告诉你是 aud 的问题。
 */
export function vapidAuthorization(
  endpoint: string,
  config: WebPushConfig,
  nowMs = Date.now(),
): string {
  const claims = {
    aud: new URL(endpoint).origin,
    // 规范上限 24h；留 12h，让时钟漂移不至于顶到上限被拒
    exp: Math.floor(nowMs / 1000) + 12 * 3600,
    sub: config.subject,
  };

  const input = [
    b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" }))),
    b64u(Buffer.from(JSON.stringify(claims))),
  ].join(".");

  const key = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: b64u(config.privateKey),
      x: b64u(config.publicKey.subarray(1, 33)),
      y: b64u(config.publicKey.subarray(33, 65)),
    },
  });
  // JWT 要 r||s 裸签名，不是 DER —— dsaEncoding 忘了设的症状是所有推送 401
  const signature = signRaw("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });

  return `vapid t=${input}.${b64u(signature)}, k=${b64u(config.publicKey)}`;
}

// ── 投递 ─────────────────────────────────────────────────────

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSendResult {
  ok: boolean;
  /** 订阅已失效（404/410），应当删除而不是重试 */
  gone: boolean;
  status?: number;
  error?: string;
}

export async function sendWebPush(
  target: PushTarget,
  payload: unknown,
  config: WebPushConfig,
): Promise<PushSendResult> {
  try {
    const body = encryptPayload(
      Buffer.from(JSON.stringify(payload)),
      b64uDecode(target.p256dh),
      b64uDecode(target.auth),
    );

    const res = await fetch(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidAuthorization(target.endpoint, config),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        // 一天后还没送达就丢弃 —— 隔夜的「有人回复了」不值得再亮一次屏
        TTL: "86400",
        Urgency: "normal",
      },
      body: new Uint8Array(body),
      // 推送服务挂了不能拖住调用方 —— 这条链路上游是通知轮询循环
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) return { ok: true, gone: false, status: res.status };
    return {
      ok: false,
      gone: res.status === 404 || res.status === 410,
      status: res.status,
      error: `推送服务返回 ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      gone: false,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}
