import type { Endpoint } from "./catalog-types";

const H = `-H "Authorization: Bearer $TOKEN"`;
const J = `-H "Content-Type: application/json"`;
const BASE = "https://agenticlab.sh";

/**
 * 社区：首页、成员、榜单、项目、活动、商店、新人引导。
 *
 * ─────────────────────────────────────────
 * 这一组读的是**别人**，所以不归 `me:read`
 * ─────────────────────────────────────────
 *
 * 归在一起的话，一个只想读自己积分的脚本会顺手拿到整个成员目录 ——
 * 而那里面是一千多个人的主页。少给永远比多给安全。
 */
export const COMMUNITY_ENDPOINTS: readonly Endpoint[] = [
  {
    method: "GET",
    path: "/api/v1/home",
    summary: "首页摘要：公告、每日精选、待办、新人提示",
    scopes: [],
    example: `curl ${H} ${BASE}/api/v1/home`,
    note:
      "不要求任何 scope —— 它按你这把令牌能看到的东西自己收敛。" +
      "没有 `community:read` 的话，里面属于别人的那几块就不出现，而不是报错",
  },
  {
    method: "GET",
    path: "/api/v1/members",
    summary: "成员目录",
    scopes: ["community:read"],
    example: `curl ${H} "${BASE}/api/v1/members?q=&limit=50"`,
    note:
      "**微信 ID 不出现在任何对外字段里**。人的标识对外是 `wx_id` 的哈希短码，" +
      "显示名绝不会退化成 wx_id —— 这条是写死的，见 ARCHITECTURE.md 第五节",
  },
  {
    method: "GET",
    path: "/api/v1/members/{wx_id}",
    summary: "某个人的主页：画像、活跃时段、口头禅、称号、帖子、项目",
    scopes: ["community:read"],
    example: `curl ${H} ${BASE}/api/v1/members/<wx_id>`,
    note:
      "能看到多少取决于**你们有没有共同的群** —— 这个站所有的可见性判定都以这个为准。" +
      "他关掉的那些隐私开关在这里同样生效",
  },
  {
    method: "GET",
    path: "/api/v1/leaderboard",
    summary: "排行榜",
    scopes: [],
    example: `curl ${H} "${BASE}/api/v1/leaderboard?season=current&limit=50"`,
    note:
      "全站总榜对所有人开放 —— 贡献排名是荣誉。分群榜单按可见性收口。" +
      "主排序用的是**高质量消息**而不是总条数：按总条数排会让复读机上榜",
  },
  {
    method: "GET",
    path: "/api/v1/projects",
    summary: "项目目录",
    scopes: ["community:read"],
    example: `curl ${H} "${BASE}/api/v1/projects?limit=30"`,
  },
  {
    method: "POST",
    path: "/api/v1/projects",
    summary: "自荐一个项目",
    scopes: ["me:write"],
    example:
      `curl -X POST ${H} ${J} -d '{"repo":"owner/name","pitch":"一句话"}' ${BASE}/api/v1/projects`,
    sampleBody: { repo: "owner/name", pitch: "一句话说清它是干嘛的" },
  },
  {
    method: "GET",
    path: "/api/v1/projects/{owner}/{repo}",
    summary: "一个项目的详情：权威标题简介、贡献者、站内提到过它的地方",
    scopes: ["community:read"],
    example: `curl ${H} ${BASE}/api/v1/projects/<owner>/<repo>`,
    note:
      "GitHub 那边的事实是定时任务问来的，只问公开数据。" +
      "站里把「某个人」和「某个 GitHub 账号」对上是这个站拼出来的 —— " +
      "所以这条要登录才看得到",
  },
  {
    method: "GET",
    path: "/api/v1/activities",
    summary: "活动列表",
    scopes: ["community:read"],
    example: `curl ${H} ${BASE}/api/v1/activities`,
  },
  {
    method: "GET",
    path: "/api/v1/activities/{id}",
    summary: "一个活动的详情、名额、我的报名状态、资格判定",
    scopes: ["community:read"],
    example: `curl ${H} ${BASE}/api/v1/activities/<id>`,
    note:
      "资格是逐条给出来的（差多少积分、差几天打卡），不是一个「不符合条件」——" +
      "只说不符合的话，人不知道该去补哪一样",
  },
  {
    method: "POST",
    path: "/api/v1/activities/{id}/apply",
    summary: "报名 / 退出",
    scopes: ["activities:write"],
    example: `curl -X POST ${H} ${J} -d '{"on":true}' ${BASE}/api/v1/activities/<id>/apply`,
    sampleBody: { on: true, answers: {} },
  },
  {
    method: "GET",
    path: "/api/v1/shop",
    summary: "商店橱窗（含我买不买得起）",
    scopes: ["community:read"],
    example: `curl ${H} ${BASE}/api/v1/shop`,
  },
  {
    method: "POST",
    path: "/api/v1/shop/{id}/buy",
    summary: "买一件",
    scopes: ["economy:write"],
    example:
      `curl -X POST ${H} ${J} \\\n` +
      `  -d '{"client_token":"随便一个随机串"}' ${BASE}/api/v1/shop/<item_key>/buy`,
    note:
      "路径上是商品的 **key**（`GET /api/v1/shop` 里那个）。" +
      "⚠️ `client_token` **必填**：它是幂等键，同一个 token 重发拿回的是同一单。" +
      "不填就没法安全重试 —— 网络超时之后你不知道上一次成没成，" +
      "而每次换一个新 token 就等于扣两次。" +
      "扣的是真积分；库存、限购、等级门槛和网页那条完全一样",
    sampleBody: { client_token: "自己生成一个至少 8 位的随机串" },
  },
  {
    method: "GET",
    path: "/api/v1/welcome",
    summary: "新人补课包：群名、常驻成员、活跃时段、这几天发生了什么",
    scopes: ["me:read"],
    example: `curl ${H} ${BASE}/api/v1/welcome`,
    note: "它把群的画像一次端出来，所以要登录 —— 群列表属于隐私",
  },
];
