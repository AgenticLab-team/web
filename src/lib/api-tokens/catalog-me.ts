import type { Endpoint } from "./catalog-types";

const H = `-H "Authorization: Bearer $TOKEN"`;
const J = `-H "Content-Type: application/json"`;
const BASE = "https://agenticlab.sh";

/**
 * 「我的」那一片：资料、积分、收藏、草稿、关注、通知、令牌、会话、导出。
 *
 * ─────────────────────────────────────────
 * 为什么这些全归 `me:*` 而不是各分各的
 * ─────────────────────────────────────────
 *
 * 判据在 `rules.ts` 顶上那段：按「泄漏了会损失什么」分，
 * 不按「它是哪个页面」。收藏夹、草稿箱、关注列表泄漏的后果
 * 是同一件事 —— 别人知道了我私下在看什么。
 *
 * 两个例外，各有各的理由：
 *   · 通知单独一组（`notifications:*`）—— 它读得到**别人对我说的话**
 *   · 花积分单独一条（`economy:write`）—— 改错了能改回来，花掉了不能
 */
export const ME_ENDPOINTS: readonly Endpoint[] = [
  {
    method: "GET",
    path: "/api/v1/me",
    summary: "我是谁：昵称、等级、积分、称号",
    scopes: ["me:read"],
    example: `curl ${H} ${BASE}/api/v1/me`,
  },
  {
    method: "POST",
    path: "/api/v1/me/profile",
    summary: "改昵称、简介、技能标签",
    scopes: ["me:write"],
    example:
      `curl -X POST ${H} ${J} \\\n` +
      `  -d '{"nickname":"新名字","bio":"一句话"}' ${BASE}/api/v1/me/profile`,
    note: "走网页那条同一段实现：长度、敏感词、改名冷却一条都不少",
    sampleBody: { nickname: "新名字", bio: "一句话简介", skills: ["Go", "Rust"] },
  },
  {
    method: "GET",
    path: "/api/v1/me/privacy",
    summary: "我的隐私开关现在是什么样",
    scopes: ["me:read"],
    example: `curl ${H} ${BASE}/api/v1/me/privacy`,
    note:
      "每一项都带着「它不管什么」那句说明 —— " +
      "一个让人以为管得比实际多的隐私开关，比没有开关更坏",
  },
  {
    method: "POST",
    path: "/api/v1/me/privacy",
    summary: "改隐私开关",
    scopes: ["me:write"],
    example:
      `curl -X POST ${H} ${J} -d '{"key":"searchable","on":false}' ${BASE}/api/v1/me/privacy`,
    sampleBody: { key: "searchable", on: false },
  },
  {
    method: "GET",
    path: "/api/v1/me/points",
    summary: "积分明细、等级、打卡状态、赛季名次",
    scopes: ["me:read"],
    example: `curl ${H} "${BASE}/api/v1/me/points?limit=50"`,
  },
  {
    method: "POST",
    path: "/api/v1/me/checkin",
    summary: "打卡",
    scopes: ["me:write"],
    example: `curl -X POST ${H} ${BASE}/api/v1/me/checkin`,
    note: "一天一次。已经打过的那一次不报错，回同一份状态 —— 重试是安全的",
    sampleBody: {},
  },
  {
    method: "POST",
    path: "/api/v1/me/makeup",
    summary: "用一张补签卡补上某天",
    scopes: ["economy:write"],
    example: `curl -X POST ${H} ${J} -d '{"date":"2026-08-10"}' ${BASE}/api/v1/me/makeup`,
    note: "补签卡是花积分买的，所以它归 `economy:write` 而不是 `me:write`",
    sampleBody: { date: "2026-08-10" },
  },
  {
    method: "GET",
    path: "/api/v1/me/titles",
    summary: "我有哪些称号、现在挂着哪个",
    scopes: ["me:read"],
    example: `curl ${H} ${BASE}/api/v1/me/titles`,
  },
  {
    method: "POST",
    path: "/api/v1/me/titles/equip",
    summary: "换一个挂着的称号",
    scopes: ["me:write"],
    example: `curl -X POST ${H} ${J} -d '{"title_id":"…"}' ${BASE}/api/v1/me/titles/equip`,
    note: "传 null 就是摘下来，不挂任何称号",
    sampleBody: { title_id: null },
  },
  {
    method: "GET",
    path: "/api/v1/me/bookmarks",
    summary: "收藏夹",
    scopes: ["me:read"],
    example: `curl ${H} "${BASE}/api/v1/me/bookmarks?folder=default"`,
  },
  {
    method: "GET",
    path: "/api/v1/me/drafts",
    summary: "草稿箱",
    scopes: ["me:read"],
    example: `curl ${H} ${BASE}/api/v1/me/drafts`,
  },
  {
    method: "POST",
    path: "/api/v1/me/drafts",
    summary: "存一份草稿（不带 id 就是新建）",
    scopes: ["me:write"],
    example:
      `curl -X POST ${H} ${J} \\\n` +
      `  -d '{"board":"general","title":"半成品","content":"写到一半"}' ${BASE}/api/v1/me/drafts`,
    sampleBody: { board: "general", title: "半成品", content: "写到一半" },
  },
  {
    method: "DELETE",
    path: "/api/v1/me/drafts/{id}",
    summary: "扔掉一份草稿",
    scopes: ["me:write"],
    example: `curl -X DELETE ${H} ${BASE}/api/v1/me/drafts/<id>`,
  },
  {
    method: "GET",
    path: "/api/v1/me/following",
    summary: "我关注了谁、谁关注了我",
    scopes: ["me:read"],
    example: `curl ${H} ${BASE}/api/v1/me/following`,
  },
  {
    method: "POST",
    path: "/api/v1/me/following",
    summary: "关注 / 取关",
    scopes: ["me:write"],
    example:
      `curl -X POST ${H} ${J} -d '{"target":"<user_id>","on":true}' ${BASE}/api/v1/me/following`,
    sampleBody: { target: "<user_id>", on: true },
  },
  {
    method: "GET",
    path: "/api/v1/me/notifications",
    summary: "通知列表",
    scopes: ["notifications:read"],
    example: `curl ${H} "${BASE}/api/v1/me/notifications?unread=1&limit=50"`,
    note:
      "它读得到 @ 我的那条消息的正文 —— 所以是单独一个 scope，" +
      "而且危险级是 1 不是 0",
  },
  {
    method: "GET",
    path: "/api/v1/me/notifications/stream",
    summary: "通知的实时流（SSE）",
    scopes: ["notifications:read"],
    example: `curl -N ${H} ${BASE}/api/v1/me/notifications/stream`,
    note:
      "断线重连要带 `Last-Event-ID`（或 `?cursor=`），服务端会把断线期间的补上 —— " +
      "**漏掉的通知比没有通知更糟**：它教会人不信任这个通道。" +
      "连接最长 15 分钟，之后主动断开，重连即可",
  },
  {
    method: "POST",
    path: "/api/v1/me/notifications/read",
    summary: "标记已读（不带 id 就是全部）",
    scopes: ["notifications:write"],
    example: `curl -X POST ${H} ${J} -d '{"ids":["…"]}' ${BASE}/api/v1/me/notifications/read`,
    sampleBody: { ids: [] },
  },
  {
    method: "GET",
    path: "/api/v1/me/notifications/prefs",
    summary: "哪几类通知开着",
    scopes: ["notifications:write"],
    example: `curl ${H} ${BASE}/api/v1/me/notifications/prefs`,
    note: "读偏好归 `notifications:write` 而不是 read —— read 那一档能看到内容，这里只看开关",
  },
  {
    method: "POST",
    path: "/api/v1/me/notifications/prefs",
    summary: "改通知偏好",
    scopes: ["notifications:write"],
    example: `curl -X POST ${H} ${J} -d '{"key":"reply","on":false}' ${BASE}/api/v1/me/notifications/prefs`,
    sampleBody: { key: "reply", on: false },
  },
  {
    method: "GET",
    path: "/api/v1/me/moderation",
    summary: "我身上的处罚和我提过的申诉",
    scopes: ["me:read"],
    example: `curl ${H} ${BASE}/api/v1/me/moderation`,
  },
  {
    method: "POST",
    path: "/api/v1/me/appeals",
    summary: "对一条处罚提申诉",
    scopes: ["me:write"],
    example:
      `curl -X POST ${H} ${J} \\\n` +
      `  -d '{"action_id":"…","reason":"说明情况"}' ${BASE}/api/v1/me/appeals`,
    sampleBody: { action_id: "<处罚 id>", reason: "说明情况" },
  },
  {
    method: "GET",
    path: "/api/v1/me/tokens",
    summary: "我的令牌列表（含终端和 SSH 网关签出的）",
    scopes: ["me:read"],
    example: `curl ${H} ${BASE}/api/v1/me/tokens`,
    note:
      "`source` 分三类：`manual` 是自己建的，`device` 是本地终端登录换的，" +
      "`ssh` 是 SSH 网关换的 —— **最后一类的明文躺在网关那台机器上**，" +
      "所以它们单独成一组、7 天到期",
  },
  {
    method: "POST",
    path: "/api/v1/me/tokens",
    summary: "建一把新令牌",
    scopes: ["me:write"],
    example:
      `curl -X POST ${H} ${J} \\\n` +
      `  -d '{"name":"我的脚本","scopes":["me:read","forum:read"]}' ${BASE}/api/v1/me/tokens`,
    note: "明文只在这一次返回里出现，之后库里只有哈希 —— 没抄下来就只能重建一把",
    sampleBody: { name: "我的脚本", scopes: ["me:read", "forum:read"] },
  },
  {
    method: "DELETE",
    path: "/api/v1/me/tokens/{id}",
    summary: "撤销一把令牌",
    scopes: ["me:write"],
    example: `curl -X DELETE ${H} ${BASE}/api/v1/me/tokens/<id>`,
    note: "传 `?source=ssh` 就是把 SSH 网关签出的**全部**撤掉 —— 怀疑网关失守时按这个",
  },
  {
    method: "GET",
    path: "/api/v1/me/sessions",
    summary: "我在哪些设备上登录着",
    scopes: ["me:read"],
    example: `curl ${H} ${BASE}/api/v1/me/sessions`,
  },
  {
    method: "DELETE",
    path: "/api/v1/me/sessions/{id}",
    summary: "把某个设备踢下线",
    scopes: ["me:write"],
    example: `curl -X DELETE ${H} ${BASE}/api/v1/me/sessions/<id>`,
    note: "这里踢的是**网页会话**，不是令牌。令牌走上面那条",
  },
  {
    method: "POST",
    path: "/api/v1/me/export",
    summary: "让服务端开始打包我的数据",
    scopes: ["me:read"],
    example: `curl -X POST ${H} ${BASE}/api/v1/me/export`,
    note: "打包要跑一会儿，返回一个 id；用下面那条问进度和拿下载地址",
    sampleBody: {},
  },
  {
    method: "GET",
    path: "/api/v1/me/export",
    summary: "导出进度与下载地址",
    scopes: ["me:read"],
    example: `curl ${H} ${BASE}/api/v1/me/export`,
  },
];
