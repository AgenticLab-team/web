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
  /** 实测常为空字符串，头像要从 friend-requests 或用户画像取 */
  avatar: string;
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
  group_nickname: string;
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
