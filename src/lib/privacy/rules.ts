/**
 * 隐私开关。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * `user_privacy` 是一张完全没人用的表
 * ─────────────────────────────────────────
 *
 * 建表时的注释写着「群聊可检索这件事需要它来平衡」——
 * 而这张表在 schema 之外**零读零写**。四个开关，没有一个接上过。
 *
 * 也就是说：这个站把 45,000 条群聊做成了全文可检索，
 * 而当初说好用来平衡它的那个东西，从来不存在。
 *
 * 这比一个坏掉的功能更糟。坏掉的功能人看得出来；
 * 一个没接线的隐私开关**看起来是好的** ——
 * 而 `DirectoryToggle` 顶上那句话已经把道理说完了：
 * 「只能靠相信」的隐私开关，跟没有是一样的。
 *
 * ─────────────────────────────────────────
 * 四个开关里只有两个该留下
 * ─────────────────────────────────────────
 *
 * · `hide_from_directory` —— **重复的**。`users.directory_hidden`
 *   才是真正接了线的那个（成员目录、`DirectoryToggle` 都用它）。
 *   同一件事两个字段，迟早分叉，而分叉那天用户以为自己隐身了。
 * · `hide_activity_hours` —— **它守的东西不存在**。`hour_histogram`
 *   每天都在写，但没有任何地方读它来展示，活跃时段热力图根本没做。
 *   给一个不存在的功能配开关，本身就是这里要治的那个病。
 *   哪天真做了热力图，再把它加回来 —— 它暴露的是一个人的作息。
 *
 * 剩下两个是真的有暴露面、也真的能关上的：
 */

export const PRIVACY_SWITCHES = [
  {
    key: "hideFromLeaderboard",
    label: "出现在榜单上",
    /*
     * 反着存：字段叫 hide_*，开关问的是「要不要出现」。
     * 界面上一律用肯定句 —— 「不要不出现在榜单上」这种双重否定
     * 是没有人能一眼读懂的。
     */
    inverted: true,
    detail: "关掉之后别人看到的榜单里没有你。你自己那一行还在，标着「仅自己可见」",
    /** 关掉它之后，究竟少了什么暴露 —— 说清楚才谈得上知情 */
    exposure: "榜单对未登录访客也公开，所以你的昵称、头像和发言量是全网可见的",
    limit: "积分和等级照常算 —— 藏的是榜单上那一行，不是你的记录",
  },
  {
    key: "searchableByOthers",
    label: "别人能搜到我的发言",
    inverted: false,
    detail: "关掉之后，别人搜关键词、搜语义都搜不到你说过的话。你自己搜自己照样搜得到",
    exposure:
      "微信自己的搜索半年前的内容就等于不存在，而这里能搜到全部 —— " +
      "这对找东西的人是好事，对被搜的人是一次新的暴露",
    /*
     * 说清楚它**不管**什么。
     *
     * 一个隐私开关最坏的形态不是没有，是让人以为它管得比实际多 ——
     * 那样他会照着一个不存在的保护去说话。
     */
    limit:
      "它管的是「搜」。同群的人按天翻聊天记录时仍然看得到你 —— " +
      "那些话他们本来就在微信里看过，这里没有多出新的暴露。" +
      "另外站长和处理举报的管理员仍然搜得到：有人举报一条发言、" +
      "而发言的人自己关掉了搜索的话，这个举报就没法处理了",
  },
] as const;

export type PrivacyKey = (typeof PRIVACY_SWITCHES)[number]["key"];

/** 默认值 = 什么都不藏。默认隐身的话，榜单和检索一开始就是空的，没人会再打开第二次 */
export const PRIVACY_DEFAULTS: Record<PrivacyKey, boolean> = {
  hideFromLeaderboard: false,
  searchableByOthers: true,
};

export function isPrivacyKey(value: string): value is PrivacyKey {
  // 不用 `in`：它会走原型链，`__proto__` 会被判成合法的开关名
  return Object.hasOwn(PRIVACY_DEFAULTS, value);
}

/**
 * 开关在界面上是「开」还是「关」。
 *
 * 库里存的是 `hide_*`（藏起来 = true），而开关问的是「要不要出现」，
 * 所以 inverted 的那些要翻一下。**这一步必须只有一处**：
 * 翻两次等于没翻，而少翻一次会让用户点了「隐藏」反而更暴露 ——
 * 这种错误在界面上完全看不出来。
 */
export function switchIsOn(key: PrivacyKey, stored: boolean): boolean {
  const spec = PRIVACY_SWITCHES.find((s) => s.key === key)!;
  return spec.inverted ? !stored : stored;
}

/** 用户把开关拨到 on/off，该往库里存什么 */
export function storedValue(key: PrivacyKey, on: boolean): boolean {
  const spec = PRIVACY_SWITCHES.find((s) => s.key === key)!;
  return spec.inverted ? !on : on;
}

export type PrivacySettings = Record<PrivacyKey, boolean>;

/** 没有这个人的行时用默认值 —— 绝大多数人永远不会打开这一页 */
export function withDefaults(row: Partial<PrivacySettings> | null | undefined): PrivacySettings {
  return {
    hideFromLeaderboard: row?.hideFromLeaderboard ?? PRIVACY_DEFAULTS.hideFromLeaderboard,
    searchableByOthers: row?.searchableByOthers ?? PRIVACY_DEFAULTS.searchableByOthers,
  };
}

/**
 * 这个人现在藏起来了几样。
 *
 * 用来在「我的」页面上显示一句摘要 —— 不显示的话，
 * 一个三个月前关过某个开关的人根本想不起来自己关过，
 * 然后会来问「为什么我不在榜上」。
 */
export function hiddenCount(settings: PrivacySettings): number {
  return PRIVACY_SWITCHES.filter((s) => !switchIsOn(s.key, settings[s.key])).length;
}
