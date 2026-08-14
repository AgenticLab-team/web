import type { ScopeKey } from "./rules";

import { ADMIN_ENDPOINTS } from "./catalog-admin";
import { AUTH_ENDPOINTS } from "./catalog-auth";
import { COMMUNITY_ENDPOINTS } from "./catalog-community";
import { FORUM_ENDPOINTS } from "./catalog-forum";
import { GROUP_ENDPOINTS } from "./catalog-groups";
import { MAIL_ENDPOINTS } from "./catalog-mail";
import { ME_ENDPOINTS } from "./catalog-me";
import type { Endpoint } from "./catalog-types";

export type { Endpoint } from "./catalog-types";

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
 *
 * ═════════════════════════════════════════
 * 它现在还是终端客户端的真源
 * ═════════════════════════════════════════
 *
 * `lib/tui/surface.ts` 里每个「面」声明自己靠哪些端点，
 * 而 `tests/tui-parity.test.ts` 对着这份表逐条核 ——
 * 写了一个不存在的端点就红。
 *
 * 反方向也核：这里有而没有任何面用到的端点，同样是红的。
 * 一个谁也没用的端点意味着两件事之一 —— 要么它该被删，
 * 要么**终端漏做了一个面**。两种都值得当场知道。
 *
 * ─────────────────────────────────────────
 * 为什么按域拆成几份
 * ─────────────────────────────────────────
 *
 * 七十多条端点、每条带一段说明，堆在一个文件里是一千多行，
 * 而人来这里通常只想找某一域的那几条。
 *
 * 拆开之后这个文件只剩「有哪几组」和「怎么按权限筛」——
 * 而它仍然是唯一的导出口：所有调用点 import 的都是这里，
 * 拆分对它们不可见。
 */

export const ENDPOINTS: readonly Endpoint[] = [
  ...AUTH_ENDPOINTS,
  ...ME_ENDPOINTS,
  ...FORUM_ENDPOINTS,
  ...GROUP_ENDPOINTS,
  ...MAIL_ENDPOINTS,
  ...COMMUNITY_ENDPOINTS,
  ...ADMIN_ENDPOINTS,
  {
    method: "GET",
    path: "/api/v1/docs",
    summary: "这份文档本身（按你的令牌算过权限）",
    scopes: [],
    example: `curl -H "Authorization: Bearer $TOKEN" https://agenticlab.sh/api/v1/docs`,
    note: "任何有效令牌都能调 —— 它要回答的正是「我这把能干什么」",
  },
  {
    method: "GET",
    path: "/api/v1/release",
    summary: "终端客户端的最新版本与下载地址",
    scopes: [],
    auth: "none",
    example: `curl https://agenticlab.sh/api/v1/release`,
    note:
      "自更新用。每个平台一条，带 sha256 —— **没有校验和的自更新等于一条远程执行**。" +
      "不需要令牌：一个还没登录的人也要能装上客户端",
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
  /*
   * 「群公告」原来在这一栏，写着「上游的 27 个端点里没有任何一个能改群的属性」。
   * 后来上游加了读写公告的接口，这句话就成了假的 ——
   * 而一份说「做不到」而其实做得到的文档比没有文档更糟：它让人根本不去试。
   * 所以那一条挪去了 ENDPOINTS。这段注释留着，是为了记住这一栏会过期。
   */
  {
    what: "改群名",
    why: "上游能改公告，但没有改群名的接口",
  },
  {
    what: "踢人 / 拉人",
    why: "成员名册是只读的，没有增删接口",
  },
  {
    what: "知道谁是群主",
    why:
      "上游的成员接口只给 wx_id / name / group_nickname / avatar / messages / left，" +
      "没有群主和管理员字段（库里那个 is_admin 2041 行全是 0）。" +
      "所以「谁能往哪个群发」由站长逐个授权，不是从群主身份推出来的",
  },
  {
    what: "实时收到群消息",
    why:
      "上游那 27 个端点里没有 webhook、也没有长连接，只能轮询 —— " +
      "所以群消息是每 2 分钟同步一次的镜像，终端里收到新消息最多晚 2 分钟。" +
      "这一条要在界面上直说，不然人会以为是自己网络断了",
  },
];

/**
 * 这把令牌调得动哪几个。
 *
 * `auth: "none"` 的那几条永远在里面 —— 它们本来就不看令牌，
 * 把它们排进「你还差某个权限」那一栏会让人去申请一个根本不存在的东西。
 */
export function allowedFor(scopes: readonly ScopeKey[]): Endpoint[] {
  return ENDPOINTS.filter((e) => e.auth === "none" || e.scopes.every((s) => scopes.includes(s)));
}

/** 调不动的那几个，连同「缺哪个 scope」一起给出来 */
export function blockedFor(scopes: readonly ScopeKey[]): { endpoint: Endpoint; missing: ScopeKey[] }[] {
  return ENDPOINTS.filter(
    (e) => e.auth !== "none" && !e.scopes.every((s) => scopes.includes(s)),
  ).map((endpoint) => ({
    endpoint,
    missing: endpoint.scopes.filter((s) => !scopes.includes(s)),
  }));
}
