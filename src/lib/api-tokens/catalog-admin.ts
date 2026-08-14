import type { Endpoint } from "./catalog-types";

const H = `-H "Authorization: Bearer $TOKEN"`;
const J = `-H "Content-Type: application/json"`;
const BASE = "https://agenticlab.sh";

/**
 * 后台。三十个页面，三条端点。
 *
 * ═════════════════════════════════════════
 * 为什么不是一页一条
 * ═════════════════════════════════════════
 *
 * 一页一条是五十多条（三十个读、二十多个写）。那意味着加一个后台页
 * 要在**三个地方**各写一遍：页面、路由文件、这份目录 ——
 * 而三处里迟早有一处会被忘掉，忘掉的那一处不会报错。
 *
 * 现在它们共用 `{section}` 这一个参数，真正的分工写在
 * `lib/admin/api-registry.ts`：每个分区声明自己要哪个权限点、
 * 读什么、能做哪些动作。那张注册表和 `lib/admin/nav.ts` 之间
 * 有一条守卫盯着，后台导航里多一项而注册表里没有，就是红的。
 *
 * ═════════════════════════════════════════
 * `admin:all` 只决定「能不能走这扇门」
 * ═════════════════════════════════════════
 *
 * 门后面能干什么，仍然由这个人的身份组说了算：每个动作照样过
 * `requireWritableAdmin("权限点")`，照样写审计日志，一条不少。
 *
 * 也就是说这个 scope **不放大任何权限**，它只是把一把令牌
 * 从「不能碰后台」变成「和这个人在网页上一样」。
 */
export const ADMIN_ENDPOINTS: readonly Endpoint[] = [
  {
    method: "GET",
    path: "/api/v1/admin/sections",
    summary: "我能进后台的哪几个分区",
    scopes: ["admin:all"],
    example: `curl ${H} ${BASE}/api/v1/admin/sections`,
    note:
      "**按你的身份组算过的** —— 一份写死的分区清单会让人照着调，" +
      "然后拿回一串 403 并开始怀疑是自己写错了。" +
      "每一项带着它要的权限点和一句人话说明",
  },
  {
    method: "GET",
    path: "/api/v1/admin/{section}",
    summary: "读某个后台分区（带 `?id=` 就是详情）",
    scopes: ["admin:all"],
    example: `curl ${H} "${BASE}/api/v1/admin/users?q=&limit=50"`,
    note:
      "`section` 的取值见上面那条。分页、筛选参数各分区不同，" +
      "都写在 `/api/v1/admin/sections` 返回的 `params` 里 —— " +
      "同一份定义驱动着网页、终端和这份文档",
  },
  {
    method: "POST",
    path: "/api/v1/admin/{section}",
    summary: "在某个后台分区上做一个动作",
    scopes: ["admin:all"],
    example:
      `curl -X POST ${H} ${J} \\\n` +
      `  -d '{"action":"ban","user_id":"…","reason":"广告","days":7}' \\\n` +
      `  ${BASE}/api/v1/admin/users`,
    note:
      "⚠️ 每一个动作都会**以你的名义**写进审计日志。" +
      "可做的动作和它们要的参数，同样在 `/api/v1/admin/sections` 里列着。" +
      "危险等级高的那些（封禁、删号、改权限矩阵）要额外传 `confirm: true`",
    sampleBody: { action: "ban", user_id: "<用户 id>", reason: "广告", days: 7 },
  },
];
