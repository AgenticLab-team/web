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
 * · ~~`hide_activity_hours`~~ —— 当初删掉是因为**它守的东西不存在**：
 *   `hour_histogram` 每天都在写，但没有任何地方读它来展示。
 *   那条注释里留了一句「哪天真做了热力图，再把它加回来 ——
 *   它暴露的是一个人的作息」。**8-10 主页上做了，所以它回来了**
 *   （见下面第四个开关）。
 *
 * 剩下这几个都是真的有暴露面、也真的能关上的：
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

/**
 * ═════════════════════════════════════════
 * `adminBypass`：**豁免要一条一条给，而且要说出来**
 * ═════════════════════════════════════════
 *
 * 这个字段是补上一个真实的事故补上的。原来的写法是
 * 「管理员绕过隐私」—— 一个权限（`moderation.queue`）一次性
 * 打开了**所有**开关，包括榜单和作息那两条。
 *
 * 站长自己把自己从榜单上藏了，然后换一个有管理权限的账号一看，
 * 自己还在榜上。而榜单那条开关对他说的是：
 * 「关掉之后**别人看到的榜单里没有你**」—— 一句没有例外的话。
 *
 * ─────────────────────────────────────────
 * 判断豁免的标准只有一条
 * ─────────────────────────────────────────
 *
 * **不处理举报会办不成，才给豁免。**
 *
 * 检索过得了这一条：有人举报一条发言，而发言的人自己关掉了检索，
 * 那个举报就没法处理了 —— 豁免是这个功能能成立的前提。
 *
 * 榜单过不了。没有任何一件审核工作需要知道一个藏起来的人排第几。
 * 作息更过不了：它暴露的是**一个人什么时候醒着**，
 * 而没有一条举报是靠这个处理的。
 *
 * 原来给榜单留豁免的理由是「不然管理员会以为公开的榜就长这样」——
 * 这句话是反的。公开的榜**就是**长这样，那正是它该显示的东西。
 *
 * ─────────────────────────────────────────
 * 给了就必须写进 `limit` 里
 * ─────────────────────────────────────────
 *
 * 一个没写出来的豁免，比没有豁免糟得多：用户照着开关上那句话
 * 去判断自己露了多少，而那句话是假的。
 *
 * 所以 `adminBypass: true` 和「`limit` 里提到管理员」是**互为条件**的，
 * `tests/privacy-switches.test.ts` 两个方向都盯着。
 * 想加一条豁免，就得先想清楚怎么跟用户说 —— 说不出口的那条，
 * 本来就不该加。
 */
export const PRIVACY_SWITCHES = [
  {
    key: "directoryHidden",
    label: "出现在成员目录里",
    /** 藏起来的人管理员也看不到 —— 处理举报不需要一份完整的花名册 */
    adminBypass: false,
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
    /** **没有豁免**。没有一件审核工作需要知道藏起来的人排第几 —— 见顶上那段 */
    adminBypass: false,
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
    /**
     * **四个里唯一有豁免的那个**，而且下面 `limit` 的最后一句写明了。
     *
     * 理由是这条豁免不给的话，举报功能整个不成立：有人举报一条发言、
     * 而发言的人自己关掉了检索，那条举报就没法处理。
     */
    adminBypass: true,
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
  {
    key: "hideActivityHours",
    label: "在主页上显示我一般什么时候说话",
    /** **没有豁免**，而且这条最不该有：它暴露的是一个人什么时候醒着 */
    adminBypass: false,
    /** 字段叫 hide_*，开关问的是「要不要显示」 */
    inverted: true,
    source: "user_privacy",
    detail:
      "关掉之后，你的主页上不再出现那张「一般什么时候说话」的条形图。" +
      "别的统计（发言数、常挂在嘴边）不受影响",
    /*
     * 这一条的 exposure 要说得比别的更直白 —— 它和别的开关不是一个量级：
     * 别的开关暴露的是「你说过什么」，这一条暴露的是**你什么时候醒着**。
     */
    exposure:
      "逐小时的分布会露出作息 —— 几点睡、几点起、是不是上夜班、" +
      "哪天开始作息变了。这些是同群的人翻聊天记录也拼不出来的东西",
    limit:
      "它管的是那张图。「本周活跃过」那种粗粒度的标记还在 —— " +
      "那说的是「这个人还在」，不是你的生活规律",
  },
] as const;

export type PrivacyKey = (typeof PRIVACY_SWITCHES)[number]["key"];

/** 默认值 = 什么都不藏。默认隐身的话，榜单和检索一开始就是空的，没人会再打开第二次 */
export const PRIVACY_DEFAULTS: Record<PrivacyKey, boolean> = {
  directoryHidden: false,
  hideFromLeaderboard: false,
  searchableByOthers: true,
  /*
   * 默认**显示**。
   *
   * 和别的开关同一条理由：默认全藏的话，这些统计一开始就是空的，
   * 没有人会再打开第二次去看。而这一项本身也不是秘密 ——
   * 同群的人翻记录能看出个大概，图只是把它说清楚了。
   */
  hideActivityHours: false,
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
    hideActivityHours: row?.hideActivityHours ?? PRIVACY_DEFAULTS.hideActivityHours,
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
