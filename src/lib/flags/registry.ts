/**
 * 功能开关的清单与判定。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 十个开关，一个调用点都没有
 * ─────────────────────────────────────────
 *
 * `feature_flags` 表里躺着十行，`isFeatureEnabled` 全站零引用。
 * 也就是说生产上 `keyword_radar` 和 `shop` 都写着「关」，
 * 而那两个页面照常打得开、照常挂在导航里。
 *
 * 这比没有开关更糟。schema 上那句注释写着
 * 「出问题时先关模块，而不是回滚整站」——
 * 而真出事那一刻去关它，会发现什么都不会发生。
 * 一个在紧急情况下才会被用到的机制，只有在紧急情况下才会发现它是假的。
 *
 * ─────────────────────────────────────────
 * 开关必须说清楚自己管着什么
 * ─────────────────────────────────────────
 *
 * 原本十个里有三个（rag_qa / temp_mailbox / external_users）
 * 对应的功能**根本还没做**（rag_qa 现在做了，剩两个）。把它们和真开关摆在同一个列表里、
 * 长得一模一样，等于在修死开关的过程中又造了三个新的：
 * 点一下，什么都不会发生。
 *
 * 所以每一条都要标出 `status`，界面上分开显示。
 */

export type FlagStatus =
  /** 真的管着东西 —— 关掉之后那个入口会消失、那个页面会 404 */
  | "wired"
  /** 功能还没做。开关先留着占位，但界面上要说清楚它现在不管任何事 */
  | "planned";

export interface FlagSpec {
  key: string;
  label: string;
  /** 关掉之后具体会发生什么 —— 这句话是管理员按下去之前唯一的依据 */
  effect: string;
  status: FlagStatus;
  /**
   * 这个开关管着哪个导航项（nav.ts 里的 key）。
   *
   * 注意**不是一一对应**：检索、资源库、雷达三个开关都指向 `chat`，
   * 因为它们是「群聊」这一个入口下面的三个视图。关掉其中一个，
   * 消失的是页内那一个标签，入口本身还在 —— 按天回看不受任何开关管，
   * 所以「群聊」永远打得开。
   */
  navKeys?: string[];
}

/**
 * 清单。
 *
 * **这是唯一的真相**：库里多出来的行会被忽略，
 * 少掉的行按这里的默认值算（见 `defaultEnabled`）。
 * 靠库当真相的话，一个空库（还没跑 seed 的新环境）会让整站全黑。
 */
export const FLAGS: readonly FlagSpec[] = [
  {
    key: "forum",
    label: "论坛",
    effect: "关掉后论坛的所有页面 404，导航里也不再出现",
    status: "wired",
    navKeys: ["forum"],
  },
  {
    key: "message_search",
    label: "群消息检索",
    effect: "关掉后搜索页 404 —— 群聊存档本身不受影响",
    status: "wired",
    navKeys: ["chat"],
  },
  {
    key: "link_library",
    label: "资源库",
    effect: "关掉后资源库页面 404，群里新出现的链接仍然会照常收录",
    status: "wired",
    navKeys: ["chat"],
  },
  {
    key: "keyword_radar",
    label: "关键词雷达",
    effect: "关掉后雷达页面 404，已经订阅的词**不再触发通知**",
    status: "wired",
    navKeys: ["chat"],
  },
  {
    key: "shop",
    label: "积分商店",
    effect: "关掉后商店页面 404 —— 已经兑换的东西不受影响",
    status: "wired",
    navKeys: ["shop"],
  },
  {
    key: "events",
    label: "活动",
    effect: "关掉后活动页面 404，进行中的活动会一起看不见",
    status: "wired",
    navKeys: ["events"],
  },
  {
    key: "rag_qa",
    label: "群聊问答",
    effect: "关掉之后搜索页上的「问一句」那一档消失，只剩关键词和语义两种搜法",
    status: "wired",
    navKeys: ["chat"],
  },
  {
    key: "temp_mailbox",
    label: "临时邮箱",
    effect: "功能还没做，开关现在不管任何事",
    status: "planned",
  },
  {
    key: "external_users",
    label: "允许非群成员注册",
    effect: "功能还没做 —— 现阶段账号只跟着群成员身份走",
    status: "planned",
  },
];

/**
 * ─────────────────────────────────────────
 * 退役的开关
 * ─────────────────────────────────────────
 *
 * 从这份清单里删掉**不够** —— 后台那一页读的是库里的
 * `feature_flags` 表。删了清单不删库，那个开关照样摆在后台，
 * 而且再没有人知道它是死的。
 *
 * 和配置项、权限点走的是同一套办法：seed 启动时清掉。
 */
export const RETIRED_FLAGS: readonly { key: string; why: string }[] = [
  {
    key: "weekly_digest",
    why: "它叫「每周精选回推微信群」，而**回推这件事代码明确拒绝做** —— 精选永远只备草稿，发送走群发那一整套复核流程。一个承诺了代码不打算做的事的开关，比没有更坏。周报的开关归进模块登记表（`module.digest.enabled`），和同步、雷达、裁剪并列",
  },
] as const;

export const FLAG_KEYS = FLAGS.map((f) => f.key);

export function specOf(key: string): FlagSpec | undefined {
  return FLAGS.find((f) => f.key === key);
}

/**
 * 库里查不到时按什么算。
 *
 * ─────────────────────────────────────────
 * 不能一律当成「关」
 * ─────────────────────────────────────────
 *
 * 原来的实现是 `?? false`。一个还没跑过 seed 的新环境、
 * 或者一次把表清空的事故，会让**整站所有功能同时消失** ——
 * 而看起来像是代码坏了，没人会想到去看一张空表。
 *
 * 已经做完的功能默认开着，没做的默认关着。这既是安全的一边，
 * 也正好是「这个站现在的样子」。
 */
export function defaultEnabled(key: string): boolean {
  return specOf(key)?.status === "wired";
}

export type Rollout = "all" | "role" | "user" | "percent";

export interface FlagRow {
  key: string;
  enabled: boolean;
  rollout: Rollout;
  rolloutValue: unknown;
}

export interface FlagViewer {
  userId: string | null;
  roleKeys: string[];
}

/**
 * 稳定散列。
 *
 * 同一个人对同一个开关，答案永远一样 —— 否则一次灰度会变成
 * 「这个功能一会儿有一会儿没有」，那比没开还让人烦。
 * 拌上 key：不同开关的 20% 应该是不同的 20%，
 * 否则同一批倒霉蛋会撞上每一次灰度。
 */
export function bucketOf(userId: string, key: string): number {
  let hash = 0;
  const seed = `${key}:${userId}`;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 100;
}

/**
 * 这个人现在能不能用这个功能。
 *
 * `enabled` 是总闸：关了就是关了，rollout 不再看 ——
 * 反过来的话，「关掉」这个动作对灰度里的人不生效，
 * 而那正是最需要它生效的时候（出事时先关模块）。
 */
export function evaluate(row: FlagRow | undefined, viewer: FlagViewer, key: string): boolean {
  if (!row) return defaultEnabled(key);
  if (!row.enabled) return false;

  switch (row.rollout) {
    case "all":
      return true;

    case "role": {
      const allowed = readList(row.rolloutValue, "roles");
      /*
       * 没登录的人没有任何身份 —— 灰度不该漏给访客。
       * 空名单也算没开：一个「按身份放行、但没填身份」的配置，
       * 更可能是填了一半，而不是想放给所有人。
       */
      if (!viewer.userId || allowed.length === 0) return false;
      return viewer.roleKeys.some((r) => allowed.includes(r));
    }

    case "user": {
      const allowed = readList(row.rolloutValue, "users");
      if (!viewer.userId) return false;
      return allowed.includes(viewer.userId);
    }

    case "percent": {
      const percent = readPercent(row.rolloutValue);
      if (percent >= 100) return true;
      if (percent <= 0) return false;
      // 访客没有稳定身份，按比例放行会变成「刷新一下就有了」
      if (!viewer.userId) return false;
      return bucketOf(viewer.userId, key) < percent;
    }
  }
}

function readList(value: unknown, field: "roles" | "users"): string[] {
  if (!value || typeof value !== "object") return [];
  const list = (value as Record<string, unknown>)[field];
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

function readPercent(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const raw = (value as Record<string, unknown>).percent;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

/**
 * 后台自己**永远不受开关管**。
 *
 * 一个能把管理后台关掉的开关，只要按错一次就再也打不开了 ——
 * 而唯一能重新打开它的地方，正是刚被关掉的那一页。
 * 这条不做成配置，做成代码里的一句话。
 */
export const NEVER_GATED = ["/admin", "/login", "/join", "/api"] as const;

export function isGatedPath(pathname: string): boolean {
  return !NEVER_GATED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
