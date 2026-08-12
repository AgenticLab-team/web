/**
 * NekoBot 上游接口类型。
 *
 * 全部字段来自 2026-08-08 对 http://127.0.0.1:8090/v1 的实测响应，
 * 不是照着文档猜的。改动前请重新探测确认。
 */

export interface Overview {
  messages_total: number;
  messages_inbound: number;
  conversations: number;
  groups: number;
  bound_groups: number;
  distinct_senders: number;
  earliest: string;
  latest: string;
}

export interface Conversation {
  conv_id: string;
  name: string;
  is_group: boolean;
  bound: boolean;
  messages: number;
  last_time: number;
  last_time_iso: string;
}

export interface LeaderboardEntry {
  rank: number;
  wx_id: string;
  name: string;
  avatar: string;
  avatar_full: string;
  messages: number;
  quality_messages: number;
  quality_ratio: number;
  total_chars: number;
  avg_chars: number;
  first_seen: string;
  last_seen: string;
}

export interface LeaderboardResponse {
  conv_id: string;
  name: string;
  quality_min: number;
  order: string;
  people: number;
  leaderboard: LeaderboardEntry[];
}

export interface ActivityResponse {
  conv_id: string;
  by: string;
  days: number;
  /** 稀疏数组：没有消息的时段不会出现，前端补零 */
  buckets: { bucket: string; messages: number }[];
}

export interface GroupMember {
  wx_id: string;
  /** 微信昵称 */
  name: string;
  /** 群内备注名，优先展示 */
  group_nickname: string;
  avatar: string;
  avatar_full: string;
  messages: number;
  left: boolean;
}

/** 上游消息类型，实测出现过的值 */
export type MessageType =
  | "text"
  | "quote"
  | "image"
  | "sticker"
  | "app"
  | "voice"
  | "video"
  | "file"
  | "so_gou_emoji"
  | "system"
  | (string & {});

export interface UpstreamMessage {
  /** 上游唯一 id，作为本地去重键 */
  msg_svr_id: string;
  conv_id: string;
  conv_name: string;
  sender_wx_id: string;
  sender_name: string;
  /** true 表示机器人自己发的 */
  is_send: boolean;
  type: MessageType;
  content: string;
  length: number;
  /** 毫秒时间戳 */
  create_time: number;
  time: string;
}

export interface MessagesResponse {
  total: number;
  limit: number;
  offset: number;
  returned: number;
  items: UpstreamMessage[];
}

export interface FriendRequest {
  wx_id: string;
  /** v3_ 开头的加好友票据，通过申请时需要 */
  user_id: string;
  nickname: string;
  /** 申请理由 —— 验证码就藏在这里 */
  reason: string;
  avatar: string;
  /** 940x940 原图 */
  avatar_full: string;
  scene: number;
  state: number;
  handled: boolean;
  at: string;
  at_ms: number;
  /** 申请人在群里的活跃度，用于后台审批时判断 */
  activity: {
    messages: number;
    quality_messages: number;
    groups: number;
  };
}

export interface FriendRequestsResponse {
  pending: number;
  count: number;
  items: FriendRequest[];
}

export interface UserSearchResult {
  wx_id: string;
  name: string;
  messages: number;
  avatar: string;
  avatar_full: string;
}

export interface UserGroupStat {
  conv_id: string;
  name: string;
  is_group?: boolean;
  messages: number;
  quality_messages: number;
  quality_ratio: number;
  first_seen: string;
  last_seen: string;
}

/**
 * /users/{wx_id}/groups 返回的是对象而非数组 —— 实测确认过。
 * 早期版本按数组处理，导致成员判定静默失败、所有人都被判为「不是社群成员」。
 */
export interface UserGroupsResponse {
  wx_id: string;
  quality_min: number;
  /** 群数量，不是列表 */
  groups: number;
  items: UserGroupStat[];
}

export interface UserProfile {
  wx_id: string;
  name: string;
  nickname: string;
  remark: string;
  avatar: string;
  avatar_full: string;
  quality_min: number;
  summary: {
    groups: number;
    messages: number;
    quality_messages: number;
    quality_ratio: number;
    total_chars: number;
    avg_chars: number;
    first_seen: string;
    last_seen: string;
    span_days: number;
    msgs_per_day: number;
    peak_hour: string;
  };
  by_type: Record<string, number>;
  by_hour: { hour: string; messages: number }[];
  groups: UserGroupStat[];
  group_nicknames: { group_id: string; nickname: string }[];
  samples: { conv: string; at: string; text: string }[];
}

export interface WhoAmI {
  name: string;
  prefix: string;
  scopes: string[];
  calls: number;
}

export interface MessageQuery {
  conv_id?: string;
  sender?: string;
  sender_name?: string;
  keyword?: string;
  msg_type?: string;
  days?: number;
  start_ms?: number;
  end_ms?: number;
  min_len?: number;
  include_self?: boolean;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

// ── 发送侧（/send/*）────────────────────────────────────────
//
// 形态全部按实测响应定义，不按文档推测 —— 这条规矩踩过坑：
// /users/{wx_id}/groups 文档说是数组、实测是对象，
// 当时的 catch 把 TypeError 吞了，结果每个人都被告知「你不是社群成员」。

/** GET /send/quota 实测：{"per_minute":{"used":0,"limit":20},"per_hour":{...}} */
export interface SendQuotaWindow {
  used: number;
  limit: number;
}

export interface SendQuota {
  per_minute: SendQuotaWindow;
  per_hour: SendQuotaWindow;
}

/** GET /send/targets 实测：数组，群和私聊混在一起 */
export interface SendTarget {
  conv_id: string;
  name: string;
  is_group: boolean;
  bound: boolean;
  last_active: string;
}

/** GET /send/history 实测：{action,target,detail,ok,at} */
export interface SendHistoryEntry {
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
  ok: boolean;
  at: string;
}

/**
 * POST /send/text 的响应。
 *
 * ⚠️ msg_svr_id 是**撤回的唯一凭据**，拿不到就再也撤不回来了。
 * 所以这里定成可选并在调用侧显式检查 —— 假定它一定存在的话，
 * 真出事那天会发现手里什么都没有。
 */
export interface SendResult {
  ok?: boolean;
  msg_svr_id?: string;
  [key: string]: unknown;
}

/**
 * 上游**发送失败但仍然回 200** 时的判定。
 *
 * ═════════════════════════════════════════
 * 这是站长说的那个「发消息 API 的 bug」
 * ═════════════════════════════════════════
 *
 * `request()` 只在 HTTP 非 2xx 时抛错。而 `/send/text` 失败时
 * 会回 `200 {"ok": false, ...}` —— 于是那一条在我们这边被记成
 * **「已发送」**，计数说成功、界面说送达，而群里什么都没出现。
 *
 * 这个坑这个仓库已经踩过一次：GitHub 换 token 那个接口
 * 「出错时也返回 200，错误信息在 body 里的 error 字段」，
 * 注释就写在 `lib/github/api.ts` 上。同一类错，第二个上游。
 *
 * ─────────────────────────────────────────
 * 只有 `ok === false` 才算失败
 * ─────────────────────────────────────────
 *
 * `ok` 缺失时**当成功**：有些成功响应本来就不带这个字段，
 * 把 `undefined` 当失败会让正常的发送变成「失败」并触发重发 ——
 * 而重发的代价是同一条消息在一千六百人的群里出现两次。
 * 宁可漏判一次失败，不能误判一次成功。
 */
export function sendFailed(result: SendResult): string | null {
  if (result.ok !== false) return null;
  const detail =
    typeof result.error === "string"
      ? result.error
      : typeof result.message === "string"
        ? result.message
        : JSON.stringify(result);
  /*
   * **每一条分支都要截断**，不能只截兜底那条。
   *
   * 这句话会原样进数据库、再原样显示在群发结果页上 ——
   * 上游回一段五千字的堆栈时，那一页会被一条错误信息撑爆，
   * 而真正要看的「哪几个群没发出去」被挤到看不见。
   */
  return `上游拒绝了这一条：${detail.slice(0, 200)}`;
}
