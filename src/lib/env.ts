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

  /**
   * GitHub 绑定。**故意不用 required()** —— 三项缺一不可，
   * 缺了就整个功能不出现（入口不渲染、路由 404），而不是报错。
   * 判定见 lib/github/oauth-rules.ts 的 githubConfigured()。
   *
   * tokenKey 是 32 字节的十六进制串，用来加密 access token：
   *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   * 换掉它等于让所有已存的 token 作废（功能降级，不会崩），
   * 所以它属于要备份的东西。
   */
  github: {
    clientId: process.env.GITHUB_CLIENT_ID ?? "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    tokenKey: process.env.GITHUB_TOKEN_KEY ?? "",
    /**
     * 只读 token，用来问「这个仓库/issue 是什么」。**它是配额，不是权限。**
     *
     * 不配也能跑 —— 那几个接口本来就公开。区别在限流：
     * 带 token 每小时 5000 次，不带是**按服务器 IP 60 次**，
     * 而我们全站共用一个出口 IP，资源库里 213 条链接一轮就撞墙。
     *
     * 建 token 时**一个 scope 都不要勾**。勾了 `repo` 的话，
     * 私有仓库会开始有响应 —— 于是别人贴一条私有仓库链接，
     * 我们会替他把标题和简介展开给所有人看。
     * 这一条是这个变量唯一真正危险的地方。
     */
    apiToken: process.env.GITHUB_API_TOKEN ?? "",
  },

  /**
   * 图床（files.mrusercontent.com）。
   *
   * **不配也能用**，但走的是上游的访客通道，而那是**按 IP 限流的：
   * 10 分钟 20 次**。我们是从服务器代传的，全站共用一个出口 IP ——
   * 也就是不配 key 的话，全站每 10 分钟只能发 20 张图。
   * 本地开发无所谓，线上必须配，否则第一个热闹的晚上就撞墙。
   *
   * key 在 files.mrusercontent.com 登录之后拿（登录态下它的
   * /agent-prompt 会内嵌一个）。
   */
  uploads: {
    apiKey: process.env.UPLOAD_API_KEY ?? "",
  },

  /** WebAuthn 依赖站点域名，必须与实际访问域一致，否则 Passkey 校验失败 */
  webauthn: {
    rpId: process.env.WEBAUTHN_RP_ID ?? "localhost",
    rpName: process.env.WEBAUTHN_RP_NAME ?? "Agentic Lab",
    origin: process.env.WEBAUTHN_ORIGIN ?? "http://localhost:3000",
  },

  isProd: process.env.NODE_ENV === "production",
};
