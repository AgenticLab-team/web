import type { Endpoint } from "./catalog-types";

const H = `-H "Authorization: Bearer $TOKEN"`;
const J = `-H "Content-Type: application/json"`;
const BASE = "https://agenticlab.sh";

/**
 * 论坛。
 *
 * ═════════════════════════════════════════
 * 写操作全部走网页那条同一段实现
 * ═════════════════════════════════════════
 *
 * 版块权限、等级门槛、匿名规则、必填标签、敏感词、发帖频率限制 ——
 * 一条都不少。**令牌不是绕开规则的近路**。
 *
 * 这不是一句口号，是 `tests/api-surface.test.ts` 里逐条钉着的：
 * 路由文件里出现 `db.insert(posts)` 就红。
 * 那份测试顶上写着为什么 —— 另写一份「简化版」的话，
 * 两份规则迟早分叉，而**分叉的方向永远是 API 那份更宽松**。
 */
export const FORUM_ENDPOINTS: readonly Endpoint[] = [
  {
    method: "GET",
    path: "/api/v1/forum/boards",
    summary: "有哪些版块（含我能不能在里面发帖）",
    scopes: ["forum:read"],
    example: `curl ${H} ${BASE}/api/v1/forum/boards`,
    note:
      "每个版块带一个 `can_post` —— 没有它的话，客户端只能让人写完再拿一句 403，" +
      "而那时候他已经打了三百个字",
  },
  {
    method: "GET",
    path: "/api/v1/posts",
    summary: "帖子列表（只给你看得到的）",
    scopes: ["forum:read"],
    example: `curl ${H} "${BASE}/api/v1/posts?limit=20"`,
    note:
      "可以带 `?board=<版块 key>` 筛版块。按作者筛时永远排除匿名帖 —— 这条写在查询层，没有例外",
  },
  {
    method: "GET",
    path: "/api/v1/posts/{id}",
    summary: "一篇帖子和它的回复",
    scopes: ["forum:read"],
    example: `curl ${H} ${BASE}/api/v1/posts/<id>`,
    note: "看不见的帖子和不存在的帖子给同一个 404 —— 分开说等于把「这个 id 存在」告诉了看不到它的人",
  },
  {
    method: "POST",
    path: "/api/v1/posts",
    summary: "发一个帖",
    scopes: ["forum:write"],
    example:
      `curl -X POST ${H} ${J} \\\n` +
      `  -d '{"board":"general","title":"标题","content":"正文"}' \\\n` +
      `  ${BASE}/api/v1/posts`,
    note:
      "走的是网页那条同一段实现：版块权限、等级门槛、匿名规则、必填标签、敏感词、" +
      "发帖频率限制一条都不少。**令牌不是绕开规则的近路**",
    sampleBody: { board: "general", title: "从 API 发的", content: "正文写这里" },
  },
  {
    method: "PATCH",
    path: "/api/v1/posts/{id}",
    summary: "编辑自己的帖子",
    scopes: ["forum:write"],
    example:
      `curl -X PATCH ${H} ${J} -d '{"content":"改过的正文"}' ${BASE}/api/v1/posts/<id>`,
    note: "每次编辑都留一版历史，和网页一样 —— 改过什么是可查的",
    sampleBody: { title: "改过的标题", content: "改过的正文" },
  },
  {
    method: "GET",
    path: "/api/v1/posts/{id}/history",
    summary: "这篇帖子改过几次、每次改了什么",
    scopes: ["forum:read"],
    example: `curl ${H} ${BASE}/api/v1/posts/<id>/history`,
  },
  {
    method: "POST",
    path: "/api/v1/posts/{id}/replies",
    summary: "回一个帖",
    scopes: ["forum:write"],
    example: `curl -X POST ${H} ${J} -d '{"content":"说得对"}' ${BASE}/api/v1/posts/<id>/replies`,
    note: "带 `parent_id` 就是回复某一条回复（楼中楼）",
    sampleBody: { content: "说得对" },
  },
  {
    method: "POST",
    path: "/api/v1/posts/{id}/react",
    summary: "给帖子或回复加一个态度",
    scopes: ["forum:write"],
    example:
      `curl -X POST ${H} ${J} -d '{"kind":"useful"}' ${BASE}/api/v1/posts/<id>/react`,
    note:
      "`kind` 只有四种：useful / insight / precise / love。" +
      "**不是任意 emoji** —— 一百个不同的表情摊开来每个都是 1，统计不出任何东西。" +
      "同一种再发一次就是取消。带 reply_id 就是给某条回复",
    sampleBody: { kind: "useful" },
  },
  {
    method: "POST",
    path: "/api/v1/posts/{id}/vote",
    summary: "在帖子里的投票上投一票",
    scopes: ["forum:write"],
    example: `curl -X POST ${H} ${J} -d '{"options":["<选项 id>"]}' ${BASE}/api/v1/posts/<id>/vote`,
    note:
      "路径上是**帖子 id**，不是投票 id —— 一个帖子最多挂一个投票，换算在服务端做。" +
      "选项 id 在 `GET /api/v1/posts/{id}` 的返回里。多选的传多个；" +
      "改票和截止时间的规则和网页一致",
    sampleBody: { options: ["<选项 id>"] },
  },
  {
    method: "POST",
    path: "/api/v1/posts/{id}/accept",
    summary: "采纳一条回复（问答帖）",
    scopes: ["forum:write"],
    example: `curl -X POST ${H} ${J} -d '{"reply_id":"…"}' ${BASE}/api/v1/posts/<id>/accept`,
    note: "只有楼主能采纳。帖子上挂着悬赏的话，采纳的同时把悬赏结算给被采纳的人",
    sampleBody: { reply_id: "<回复 id>" },
  },
  {
    method: "POST",
    path: "/api/v1/posts/{id}/tip",
    summary: "打赏这篇帖子",
    scopes: ["economy:write"],
    example: `curl -X POST ${H} ${J} -d '{"amount":10}' ${BASE}/api/v1/posts/<id>/tip`,
    note: "花的是你自己的积分，扣了就没了 —— 所以它归 `economy:write`，不归 `forum:write`",
    sampleBody: { amount: 10 },
  },
  {
    method: "POST",
    path: "/api/v1/posts/{id}/bookmark",
    summary: "收藏 / 取消收藏",
    scopes: ["me:write"],
    example: `curl -X POST ${H} ${J} -d '{"on":true}' ${BASE}/api/v1/posts/<id>/bookmark`,
    sampleBody: { on: true, folder: "default" },
  },
  {
    method: "POST",
    path: "/api/v1/posts/{id}/report",
    summary: "举报这篇帖子或它的某条回复",
    scopes: ["forum:write"],
    example:
      `curl -X POST ${H} ${J} -d '{"reason":"广告"}' ${BASE}/api/v1/posts/<id>/report`,
    sampleBody: { reason: "广告", reply_id: null },
  },
  {
    method: "GET",
    path: "/api/v1/forum/search",
    summary: "在论坛里搜",
    scopes: ["forum:read"],
    example: `curl ${H} "${BASE}/api/v1/forum/search?q=关键词&limit=20"`,
    note: "可见性在 SQL 层就切掉了 —— 搜不到的东西是真的搜不到，不是查出来再过滤",
  },
  {
    method: "GET",
    path: "/api/v1/forum/deep",
    summary: "深潜：值得慢慢读的长文",
    scopes: ["forum:read"],
    example: `curl ${H} ${BASE}/api/v1/forum/deep`,
  },
  {
    method: "POST",
    path: "/api/v1/forum/convert",
    summary: "把一段群聊转成帖子",
    scopes: ["forum:write", "groups:read"],
    example:
      `curl -X POST ${H} ${J} \\\n` +
      `  -d '{"conv_id":"…","message_ids":["…"],"board":"general","title":"整理"}' \\\n` +
      `  ${BASE}/api/v1/forum/convert`,
    note:
      "要两个 scope：读那段消息要 `groups:read`，发出来的帖子署你的名要 `forum:write`。" +
      "被引用的人有没有同意过，判定和网页那条一样 —— 没同意的会被隐去",
    sampleBody: {
      conv_id: "<群 id>",
      message_ids: ["<消息 id>"],
      board: "general",
      title: "整理一下昨天那段讨论",
    },
  },
];
