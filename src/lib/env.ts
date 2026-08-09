import "server-only";

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`缺少环境变量 ${name}，请在 .env.local 中配置`);
  return value;
}

function optionalInt(value: string | undefined, fallback: number): number {
  const n = value ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  /** 上游 NekoBot API（经 frp 隧道反代到本机 8090） */
  nekobot: {
    baseUrl: process.env.NEKOBOT_BASE_URL ?? "http://127.0.0.1:8090/v1",
    apiKey: required("NEKOBOT_API_KEY", process.env.NEKOBOT_API_KEY),
    timeoutMs: optionalInt(process.env.NEKOBOT_TIMEOUT_MS, 20_000),
    /** 上游默认的高质量消息阈值；真实值以各接口返回的 quality_min 为准 */
    defaultQualityMin: optionalInt(process.env.NEKOBOT_QUALITY_MIN, 15),
  },

  db: {
    path: process.env.DB_PATH ?? "./data/agenticlab.db",
  },

  site: {
    url: process.env.SITE_URL ?? "http://localhost:3000",
    name: process.env.SITE_NAME ?? "Agentic Lab",
  },

  /**
   * Web Push 的 VAPID 密钥。**故意不用 required()** ——
   * 没配的时候推送功能整体停用并在健康检查里如实报「没配置」，
   * 而不是让整个站起不来：推送是增强，站内通知才是底线。
   * 生成方式见 scripts/webpush-keys.ts。
   */
  webpush: {
    publicKey: process.env.VAPID_PUBLIC_KEY ?? "",
    privateKey: process.env.VAPID_PRIVATE_KEY ?? "",
    /** 推送服务出问题时联系我们用的地址，规范要求 mailto: 或 https: */
    subject: process.env.VAPID_SUBJECT ?? "",
  },

  /** WebAuthn 依赖站点域名，必须与实际访问域一致，否则 Passkey 校验失败 */
  webauthn: {
    rpId: process.env.WEBAUTHN_RP_ID ?? "localhost",
    rpName: process.env.WEBAUTHN_RP_NAME ?? "Agentic Lab",
    origin: process.env.WEBAUTHN_ORIGIN ?? "http://localhost:3000",
  },

  isProd: process.env.NODE_ENV === "production",
};
