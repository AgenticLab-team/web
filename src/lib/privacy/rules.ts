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

/**
 * ─────────────────────────────────────────
 * 三个开关，一个地方
 * ─────────────────────────────────────────
 *
 * 「隐身」原来单独摆在个人资料页上，另外两个在隐私页 ——
 * 而三个问的是同一件事：**谁看得见我**。
 *
 * 分成两页的后果不是多点一次，是**有人设了其中一个就以为设完了**。
 * 而这一页顶上那句话已经说清了这种失败：
 * 一个隐私开关最坏的形态不是没有，是让人以为它管得比实际多。
 *
 * 它们存在不同的表里（隐身在 `users.directory_hidden`，
 * 另两个在 `user_privacy`），所以每一条要说明自己从哪儿读写 ——
 * 这比把三张表的值搬到一起省事，也比让界面各自去查各自的表安全：
 * 那样「取值」和「翻转」的逻辑会散成三份。
 */
export const PRIVACY_SWITCHES = [
  {
    key: "directoryHidden",
    label: "出现在成员目录里",
    /** 字段叫 hidden，开关问的是「要不要出现」 */
    inverted: true,
    source: "users",
    detail: "关掉之后你不出现在成员列表和搜人结果里。别人仍然能通过你发的帖子点进你的主页",
    exposure: "成员目录会列出你的昵称、头像、简介和技能标签，所有登录成员都看得到",
    limit:
      "它管的是「被列出来」和「被搜到人」。**它不管你已经发过的内容** —— " +
      "帖子、回复、群聊记录里的发言都还在，点得进你的主页。" +
      "要少露一点发言，看下面那两个开关",
  },
  {
    key: "hideFromLeaderboard",
    label: "出现在榜单上",
    /*
     * 反着存：字段叫 hide_*，开关问的是「要不要出现」。
     * 界面上一律用肯定句 —— 「不要不出现在榜单上」这种双重否定
     * 是没有人能一眼读懂的。
     */
    inverted: true,
    source: "user_privacy",
    detail: "关掉之后别人看到的榜单里没有你。你自己那一行还在，标着「仅自己可见」",
    /** 关掉它之后，究竟少了什么暴露 —— 说清楚才谈得上知情 */
    exposure: "榜单对未登录访客也公开，所以你的昵称、头像和发言量是全网可见的",
    limit: "积分和等级照常算 —— 藏的是榜单上那一行，不是你的记录",
  },
  {
    key: "searchableByOthers",
    label: "别人能搜到我的发言",
    inverted: false,
    source: "user_privacy",
    detail:
      "关掉之后，别人搜关键词、搜语义都搜不到你说过的话，" +
      "你的主页上也不会出现「常挂在嘴边」这类从你的发言里归纳出来的东西。" +
      "你自己看自己照常都在",
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
      "它管的是「被别人从发言里找出来」—— 检索是一种，" +
      "**主页上那句归纳也是一种**（「他最爱说 X」是一句结论，" +
      "而结论是翻记录翻不出来的，所以归在这个开关下面）。" +
      "同群的人按天翻聊天记录时仍然看得到你 —— " +
      "那些话他们本来就在微信里看过，这里没有多出新的暴露。" +
      "另外站长和处理举报的管理员仍然搜得到：有人举报一条发言、" +
      "而发言的人自己关掉了搜索的话，这个举报就没法处理了",
  },
] as const;

export type PrivacyKey = (typeof PRIVACY_SWITCHES)[number]["key"];

/** 默认值 = 什么都不藏。默认隐身的话，榜单和检索一开始就是空的，没人会再打开第二次 */
export const PRIVACY_DEFAULTS: Record<PrivacyKey, boolean> = {
  directoryHidden: false,
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
    directoryHidden: row?.directoryHidden ?? PRIVACY_DEFAULTS.directoryHidden,
    hideFromLeaderboard: row?.hideFromLeaderboard ?? PRIVACY_DEFAULTS.hideFromLeaderboard,
    searchableByOthers: row?.searchableByOthers ?? PRIVACY_DEFAULTS.searchableByOthers,
  };
}

/** 这个开关的值存在哪张表 —— 读写两侧都按它分流 */
export function sourceOf(key: PrivacyKey): "users" | "user_privacy" {
  return PRIVACY_SWITCHES.find((s) => s.key === key)!.source;
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
