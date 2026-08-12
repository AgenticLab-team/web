import type { ScopeKey } from "./rules";

/**
 * 开放 API 的端点目录 —— **文档的唯一真源**。
 *
 * ═════════════════════════════════════════
 * 为什么文档要按人生成
 * ═════════════════════════════════════════
 *
 * 站长要的是「附有按照权限变动的动态 api 文档」。
 *
 * 一份写死的文档最常见的坏法不是过期，而是**它描述的是另一个人的世界**：
 * 读的人照着调，拿回一串 403，然后开始怀疑是自己写错了。
 * 尤其 `groups:send` 这种默认不给的权限 —— 文档里明明写着，
 * 而他那把令牌根本没有。
 *
 * 所以这里既是「有哪些端点」的真源，也是「你能用哪些」的判据：
 * 页面和 `/api/v1/docs` 读同一份，不会有第二种说法。
 */

export interface Endpoint {
  method: "GET" | "POST";
  path: string;
  summary: string;
  /** 要哪些 scope 才调得动；空数组 = 任何有效令牌都行 */
  scopes: ScopeKey[];
  /** 一句能直接抄去跑的例子 */
  example: string;
  /** 额外要注意的事，会原样显示在文档上 */
  note?: string;
}

export const ENDPOINTS: readonly Endpoint[] = [
  {
    method: "GET",
    path: "/api/v1/me",
    summary: "我是谁：昵称、等级、积分、称号",
    scopes: ["me:read"],
    example: `curl -H "Authorization: Bearer $TOKEN" https://agenticlab.sh/api/v1/me`,
  },
  {
    method: "GET",
    path: "/api/v1/docs",
    summary: "这份文档本身（按你的令牌算过权限）",
    scopes: [],
    example: `curl -H "Authorization: Bearer $TOKEN" https://agenticlab.sh/api/v1/docs`,
    note: "任何有效令牌都能调 —— 它要回答的正是「我这把能干什么」",
  },
  {
    method: "POST",
    path: "/api/v1/groups/{conv_id}/messages",
    summary: "往一个群发一条文本",
    scopes: ["groups:send"],
    example:
      `curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\\n` +
      `  -d '{"text":"大家好"}' \\\n` +
      `  https://agenticlab.sh/api/v1/groups/<conv_id>/messages`,
    note:
      "**发出去的消息一定会带一行代发署名**（「本消息由「你」使用 AgenticLab.sh 代发」）—— " +
      "消息由机器人账号发出，不署名的话群里没有人知道是谁说的。" +
      "另外：只能发到**站长授权过、而且你确实在其中**的群",
  },
];

/**
 * 上游做不到、所以我们也做不到的那些。
 *
 * ─────────────────────────────────────────
 * 写进文档里，而不是等人来问
 * ─────────────────────────────────────────
 *
 * 站长问过「群公告」「踢人」。实测上游一共 27 个端点，
 * 写操作只有「通过好友申请」和 send 那一族
 * （text/image/link/file/voice/sticker/pat/quote/revoke）——
 * **没有群公告，也没有踢人**。
 *
 * 不写出来的话，下一个人会先花半天找这两个接口，
 * 然后得出「文档不全」的结论 —— 而实际是它们不存在。
 */
export const NOT_POSSIBLE: readonly { what: string; why: string }[] = [
  {
    what: "群公告 / 修改群名",
    why: "上游的 27 个端点里没有任何一个能改群的属性 —— 它是只读的那一侧加上发消息",
  },
  {
    what: "踢人 / 拉人",
    why: "同上。成员名册只读，没有增删接口",
  },
  {
    what: "知道谁是群主",
    why:
      "上游的成员接口只给 wx_id / name / group_nickname / avatar / messages / left，" +
      "没有群主和管理员字段（库里那个 is_admin 2041 行全是 0）。" +
      "所以「谁能往哪个群发」由站长逐个授权，不是从群主身份推出来的",
  },
];

/** 这把令牌调得动哪几个 */
export function allowedFor(scopes: readonly ScopeKey[]): Endpoint[] {
  return ENDPOINTS.filter((e) => e.scopes.every((s) => scopes.includes(s)));
}

/** 调不动的那几个，连同「缺哪个 scope」一起给出来 */
export function blockedFor(scopes: readonly ScopeKey[]): { endpoint: Endpoint; missing: ScopeKey[] }[] {
  return ENDPOINTS.filter((e) => !e.scopes.every((s) => scopes.includes(s))).map((endpoint) => ({
    endpoint,
    missing: endpoint.scopes.filter((s) => !scopes.includes(s)),
  }));
}
