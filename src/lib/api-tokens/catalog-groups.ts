import type { Endpoint } from "./catalog-types";

const H = `-H "Authorization: Bearer $TOKEN"`;
const J = `-H "Content-Type: application/json"`;
const BASE = "https://agenticlab.sh";

/**
 * 群聊那一片：群列表、消息、成员、回看、检索、资源库、雷达、统计、公告。
 *
 * ═════════════════════════════════════════
 * 群列表属于隐私 —— 有令牌也只看得到自己在的群
 * ═════════════════════════════════════════
 *
 * 这不是靠这一层过滤实现的，是 `lib/queries/visibility.ts` 在
 * **SQL 层**就切掉了（`ARCHITECTURE.md` 第五节）。
 * 「只要能搜到只言片语，私密内容就已经泄露了」——
 * 所以检索这条路上尤其不能是「查出来再 filter」。
 */
export const GROUP_ENDPOINTS: readonly Endpoint[] = [
  {
    method: "GET",
    path: "/api/v1/groups",
    summary: "我在哪些群里（含能不能往那里发）",
    scopes: ["groups:read"],
    example: `curl ${H} ${BASE}/api/v1/groups`,
    note:
      "别的群接口都要 conv_id，而这是**唯一**能拿到它的地方。" +
      "只给你自己在的群 —— 群列表属于隐私，有令牌也看不到别人的",
  },
  {
    method: "GET",
    path: "/api/v1/groups/{conv_id}/members",
    summary: "这个群的成员名册",
    scopes: ["groups:read"],
    example: `curl ${H} ${BASE}/api/v1/groups/<conv_id>/members`,
    note:
      "上游只给 wx_id / 昵称 / 群昵称 / 头像 / 发言数 / 是否退群 —— " +
      "**没有群主，也没有管理员**（库里那个 is_admin 从来没被写进过值）。" +
      "所以「谁能往哪个群发」是站长逐个授权的，不是从群主身份推出来的",
  },
  {
    method: "GET",
    path: "/api/v1/groups/{conv_id}/messages",
    summary: "读这个群的聊天记录",
    scopes: ["groups:read"],
    example: `curl ${H} "${BASE}/api/v1/groups/<conv_id>/messages?q=关键词&limit=50"`,
    note:
      "只限你自己在的群。关掉了「别人能搜到我的发言」的人不会出现在结果里 —— " +
      "和站内检索同一套口径。" +
      "往上翻历史用 `?offset=`（按时间倒序，0 是最新的那一批）；" +
      "`limit` 最大 200",
  },
  {
    method: "POST",
    path: "/api/v1/groups/{conv_id}/messages",
    summary: "往一个群发一条文本",
    scopes: ["groups:send"],
    example:
      `curl -X POST ${H} ${J} -d '{"text":"大家好"}' ${BASE}/api/v1/groups/<conv_id>/messages`,
    note:
      "**发出去的消息一定会带一行代发署名**（「本消息由「你」使用 AgenticLab.sh 代发」）—— " +
      "消息由机器人账号发出，不署名的话群里没有人知道是谁说的。" +
      "另外：只能发到**站长授权过、而且你确实在其中**的群",
    sampleBody: { text: "大家好" },
  },
  {
    method: "GET",
    path: "/api/v1/groups/{conv_id}/announcement",
    summary: "读群公告",
    scopes: ["groups:read"],
    example: `curl ${H} ${BASE}/api/v1/groups/<conv_id>/announcement`,
    note: "在群里就能读 —— 群里每个人本来就看得见",
  },
  {
    method: "POST",
    path: "/api/v1/groups/{conv_id}/announcement",
    summary: "改群公告",
    scopes: ["groups:send"],
    example:
      `curl -X POST ${H} ${J} -d '{"text":"本周六线下"}' ${BASE}/api/v1/groups/<conv_id>/announcement`,
    note:
      "⚠️ **整条替换，不是追加** —— 会把群里现在的公告顶掉，返回体里的 previous 就是被顶掉的那段。" +
      "同样带代发署名，和发消息共用授权与额度",
    sampleBody: { text: "本周六线下聚会，地点群里说" },
  },
  {
    method: "GET",
    path: "/api/v1/groups/{conv_id}/stats",
    summary: "这个群的发言榜和活跃度",
    scopes: ["groups:read"],
    example: `curl ${H} "${BASE}/api/v1/groups/<conv_id>/stats?days=30&limit=20"`,
    note:
      "关掉了「出现在榜单上」的成员不会出现在结果里 —— 和站内榜单同一套口径。" +
      "活跃度是整个群按天汇总的，不分人",
  },
  {
    method: "GET",
    path: "/api/v1/archive",
    summary: "按天回看：某一天群里说了什么",
    scopes: ["groups:read"],
    example: `curl ${H} "${BASE}/api/v1/archive?conv_id=<conv_id>&date=2026-08-12"`,
    note:
      "不带 date 就是最近有消息的那一天。它是这个站数据最多的一个面 —— " +
      "翻页用 `?before=` 而不是 offset，几万条上 offset 会越翻越慢",
  },
  {
    method: "GET",
    path: "/api/v1/search",
    summary: "全站检索（群聊 + 语义）",
    scopes: ["groups:read"],
    example: `curl ${H} "${BASE}/api/v1/search?q=台风&limit=30"`,
    note:
      "**搜索是最容易绕过权限的入口**，所以可见性在 SQL 层就切掉了。" +
      "配了 LLM 的话还会带一段语义检索的结果，没配就只有全文检索 —— 不会报错",
  },
  {
    method: "GET",
    path: "/api/v1/links",
    summary: "资源库：群里贴过的链接",
    scopes: ["groups:read"],
    example: `curl ${H} "${BASE}/api/v1/links?limit=30&sort=hot"`,
  },
  {
    method: "POST",
    path: "/api/v1/links/{id}/vote",
    summary: "给一条链接投票",
    scopes: ["me:write"],
    example: `curl -X POST ${H} ${J} -d '{"on":true}' ${BASE}/api/v1/links/<id>/vote`,
    sampleBody: { on: true },
  },
  {
    method: "POST",
    path: "/api/v1/links/{id}/save",
    summary: "收藏一条链接",
    scopes: ["me:write"],
    example: `curl -X POST ${H} ${J} -d '{"on":true}' ${BASE}/api/v1/links/<id>/save`,
    sampleBody: { on: true },
  },
  {
    method: "GET",
    path: "/api/v1/radar",
    summary: "我的关键词雷达，以及最近命中了什么",
    scopes: ["groups:read"],
    example: `curl ${H} ${BASE}/api/v1/radar`,
  },
  {
    method: "POST",
    path: "/api/v1/radar",
    summary: "加一个关键词",
    scopes: ["me:write"],
    example: `curl -X POST ${H} ${J} -d '{"keyword":"招聘"}' ${BASE}/api/v1/radar`,
    sampleBody: { keyword: "招聘" },
  },
  {
    method: "DELETE",
    path: "/api/v1/radar/{id}",
    summary: "删掉一个关键词",
    scopes: ["me:write"],
    example: `curl -X DELETE ${H} ${BASE}/api/v1/radar/<id>`,
  },
];
