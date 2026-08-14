import type { Endpoint } from "./catalog-types";

/**
 * 设备码登录的两条。
 *
 * ═════════════════════════════════════════
 * 这是目录里**唯一**不需要令牌的两条
 * ═════════════════════════════════════════
 *
 * 理由是循环：它们的目的就是拿到令牌。
 *
 * 它们仍然要出现在这份文档里 —— 不出现的话，一个想自己写客户端的人
 * 只能从终端的源码里反推登录怎么走，而那正是这个站
 * 「文档是唯一真源」这条原则要避免的。
 *
 * 路由那一侧的放行是**列名**的（`tests/api-surface.test.ts`
 * 里的 `NO_AUTH_ROUTES`），不是靠这里的 `auth: "none"` ——
 * 两边各自独立地登记一次，改一边不会让另一边跟着松掉。
 */
export const AUTH_ENDPOINTS: readonly Endpoint[] = [
  {
    method: "POST",
    path: "/api/v1/auth/device/start",
    summary: "要一串登录码（终端客户端用）",
    scopes: [],
    auth: "none",
    example:
      `curl -X POST -H "Content-Type: application/json" \\\n` +
      `  -d '{"fingerprint":{"host":"mbp","os":"darwin","term":"xterm-256color"},"scopes":["me:read","forum:read"]}' \\\n` +
      `  https://agenticlab.sh/api/v1/auth/device/start`,
    note:
      "拿回来的 `user_code` 显示给人看，`device_code` 自己揣着别打到屏幕上 —— " +
      "换令牌只认后者。人在浏览器里打开 `verification_uri` 确认之后，" +
      "轮询下面那条就能拿到令牌。**这条不发账号**：没有站内账号的人确认不了。",
    sampleBody: {
      fingerprint: { host: "mbp", os: "darwin", term: "xterm-256color" },
      scopes: ["me:read", "forum:read", "groups:read"],
    },
  },
  {
    method: "POST",
    path: "/api/v1/auth/device/poll",
    summary: "问一下批了没有，批了就把令牌给我",
    scopes: [],
    auth: "none",
    example:
      `curl -X POST -H "Content-Type: application/json" \\\n` +
      `  -d '{"device_code":"…"}' https://agenticlab.sh/api/v1/auth/device/poll`,
    note:
      "还没批回 428 `authorization_pending`；问太快回 429 `slow_down`（带一个新的 interval，" +
      "照着它放慢）；过期或者没有这串码都回 400 `expired_token`。" +
      "成功那一次会把这条登录请求从库里删掉 —— 同一串 device_code 换不到第二把令牌。",
    sampleBody: { device_code: "把 start 那一步拿到的填这里" },
  },
];
