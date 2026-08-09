import { NOTIFICATION_TYPES } from "@/lib/db/schema";

/**
 * 通知偏好。纯函数。
 *
 * ─────────────────────────────────────────
 * 为什么一定要有开关
 * ─────────────────────────────────────────
 *
 * 不给用户关掉某一类通知的办法，他会关掉**全部** ——
 * 而「全部关掉」在这个站上的具体做法是不再打开它。
 * 一个精细的开关面板不是贴心，是保住那些真正重要的通知的唯一方式。
 *
 * ─────────────────────────────────────────
 * 有几类不能关
 * ─────────────────────────────────────────
 *
 * 处罚、申诉结果、系统公告 —— 这些是**对当事人不利的消息**。
 * 让人能把它们静音，等于允许一个人选择不知道自己被扣了分、
 * 帖子被删了、申诉被驳回了。那不是偏好，那是让通知变得不可信：
 * 一旦有一类消息「可能被关掉」，所有没收到的消息都不能再说明什么。
 */

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** 关不掉的那几类 —— 对当事人不利的消息不该能被静音 */
export const ALWAYS_ON: readonly NotificationType[] = ["moderation", "system"] as const;

export function isAlwaysOn(type: string): boolean {
  return (ALWAYS_ON as readonly string[]).includes(type);
}

export interface ChannelPrefs {
  site: boolean;
  /** 邮件通道**还没接** —— 见 canUseEmail() */
  email: boolean;
}

export type PrefsMap = Record<string, ChannelPrefs>;

/**
 * 默认全开。
 *
 * 新用户第一周需要知道有人回了自己 —— 那是他会不会再来的关键。
 * 默认关掉的通知等于没有通知，而用户根本不知道有个开关可以打开。
 */
export function defaultPrefs(): PrefsMap {
  const out: PrefsMap = {};
  for (const type of NOTIFICATION_TYPES) out[type] = { site: true, email: false };
  return out;
}

/**
 * 邮件通道现在能不能用。
 *
 * SMTP 还没接。**在接上之前，界面上不该出现邮件开关** ——
 * 一个打开了但什么都不会发生的开关，比没有这个开关更糟：
 * 用户会以为自己已经订阅了邮件通知，然后错过所有东西。
 */
export function canUseEmail(): boolean {
  return false;
}

/**
 * 把存下来的 JSON 归一化成完整的偏好表。
 *
 * 存量数据里可能缺字段、多出已经废弃的类型、或者干脆是别的形状 ——
 * 归一化在**读**的时候做，而不是指望每次写都是完整的：
 * 加一个新通知类型时，所有老用户的记录都缺那一项。
 */
export function normalizePrefs(raw: unknown): PrefsMap {
  const base = defaultPrefs();
  if (!raw || typeof raw !== "object") return base;

  for (const [type, value] of Object.entries(raw as Record<string, unknown>)) {
    // 不认识的类型直接丢掉 —— 可能是删掉的旧类型，留着只会让面板长出鬼条目
    if (!(type in base)) continue;
    if (!value || typeof value !== "object") continue;
    const v = value as Partial<ChannelPrefs>;
    base[type] = {
      site: typeof v.site === "boolean" ? v.site : true,
      email: typeof v.email === "boolean" ? v.email : false,
    };
  }

  // 关不掉的那几类，无论存了什么都强制打开
  for (const type of ALWAYS_ON) base[type] = { ...base[type], site: true };

  return base;
}

/** 这条通知该不该产生 */
export function isEnabled(prefs: PrefsMap, type: string, channel: keyof ChannelPrefs = "site"): boolean {
  if (channel === "site" && isAlwaysOn(type)) return true;
  if (channel === "email" && !canUseEmail()) return false;
  const entry = prefs[type];
  if (!entry) return true; // 没见过的类型默认发，漏发比多发糟
  return entry[channel];
}

/**
 * 写入前把用户提交的东西过一遍。
 *
 * 前端可以被绕过，所以「关不掉的不能关」必须在这里再判一次 ——
 * 只在界面上把开关禁用掉，等于没有这条规则。
 */
export function sanitizeSubmission(input: unknown): PrefsMap {
  return normalizePrefs(input);
}

// ── 面板上的呈现 ────────────────────────────────────────────

export interface TypeMeta {
  type: NotificationType;
  label: string;
  hint: string;
  /** 面板分组 */
  section: "interaction" | "recognition" | "account";
}

/**
 * 每一类都要有一句「什么时候会收到」。
 *
 * 「回复」这种词对写代码的人清楚，对用户不清楚 ——
 * 分不清 reply_to_post 和 subscribed_reply 的人，
 * 关开关的时候只能靠猜，而猜错一次就会把整页都关掉。
 */
export const TYPE_META: TypeMeta[] = [
  {
    type: "mention",
    label: "有人 @ 我",
    hint: "别人在帖子或回复里点名提到你",
    section: "interaction",
  },
  {
    type: "reply_to_post",
    label: "有人回复我的帖子",
    hint: "你发的帖子下面有了新回复",
    section: "interaction",
  },
  {
    type: "reply_to_reply",
    label: "有人回复我的回复",
    hint: "别人在楼中楼里接着你的话说",
    section: "interaction",
  },
  {
    type: "subscribed_reply",
    label: "我关注的帖子有新回复",
    hint: "不是你发的，但你点过关注",
    section: "interaction",
  },
  {
    type: "reaction",
    label: "有人给我的内容点了表情",
    hint: "量最大的一类 —— 觉得吵先关这个",
    section: "recognition",
  },
  {
    type: "featured",
    label: "我的帖子被加精",
    hint: "被选进精华或推到首页",
    section: "recognition",
  },
  {
    type: "accepted",
    label: "我的回答被采纳",
    hint: "提问者把你的回复标成了答案",
    section: "recognition",
  },
  {
    type: "keyword",
    label: "关键词雷达命中",
    hint: "群里有人提到你订阅的词 —— 每个词每天最多提醒 5 次",
    section: "interaction",
  },
  {
    type: "moderation",
    label: "处罚与申诉结果",
    hint: "内容被处理、申诉有结论时通知你",
    section: "account",
  },
  {
    type: "system",
    label: "系统公告",
    hint: "站点维护、规则变更这类事",
    section: "account",
  },
];

export const SECTION_LABELS: Record<TypeMeta["section"], string> = {
  interaction: "有人找你",
  recognition: "被认可",
  account: "与你的账号有关",
};

export const SECTION_HINTS: Record<TypeMeta["section"], string> = {
  interaction: "这几类通常是你真的想知道的",
  recognition: "量可能很大，嫌吵可以只留精华与采纳",
  account: "关不掉 —— 对你不利的消息不该能被静音",
};

// ── 列表页的筛选 ────────────────────────────────────────────

export type NotificationFilter =
  | "all"
  | "unread"
  | "mention"
  | "reply"
  | "radar"
  | "account";

export const FILTER_LABELS: Record<NotificationFilter, string> = {
  all: "全部",
  unread: "未读",
  mention: "@ 我",
  reply: "回复",
  radar: "雷达",
  account: "账号",
};

const FILTER_TYPES: Record<NotificationFilter, readonly string[] | null> = {
  all: null,
  unread: null,
  mention: ["mention"],
  reply: ["reply_to_post", "reply_to_reply", "subscribed_reply"],
  radar: ["keyword"],
  account: ["moderation", "system"],
};

export function parseFilter(value: string | undefined): NotificationFilter {
  return value && value in FILTER_LABELS ? (value as NotificationFilter) : "all";
}

export function matchesFilter(
  item: { type: string; readAt: number | null },
  filter: NotificationFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "unread") return item.readAt === null;
  const types = FILTER_TYPES[filter];
  return types ? types.includes(item.type) : true;
}

/**
 * 每个筛选项对应的类型必须真实存在。
 *
 * 打错一个字的表现是那个页签永远空着，而用户会以为「我没有被 @ 过」。
 */
export function filterTypes(filter: NotificationFilter): readonly string[] | null {
  return FILTER_TYPES[filter];
}
