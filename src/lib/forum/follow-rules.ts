/**
 * 关注作者 / 版块 / 标签。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 四个值的枚举，只有一个值出现过
 * ─────────────────────────────────────────
 *
 * `subscriptions.target_type` 一开始就写着 `post | board | tag | user`，
 * 而全站只写过也只读过 `post` —— 另外三个从来没有一行数据。
 *
 * 更要紧的是：**发新帖这件事根本不发通知**。
 * 站里只有 `notifyNewReply`，没有任何 `notifyNewPost`。
 * 也就是说「关注」这个词在这个站里目前只有一个意思：
 * 「这个帖子有人回复时叫我」。关注一个人、一个版块，
 * 在数据模型里是可表达的，在运行时什么都不会发生。
 *
 * ─────────────────────────────────────────
 * 新帖扇出是一条会绕过可见性的路
 * ─────────────────────────────────────────
 *
 * 「我关注的人发帖了」这条通知，带着标题和链接，
 * 发给的是**订阅者**而不是有权看的人。中间少一步逐人可见性判定，
 * 一个「仅自己可见」的帖子标题就会出现在所有粉丝的通知栏里 ——
 * 而那条通知本身就是泄露，点不点进去都一样。
 *
 * ─────────────────────────────────────────
 * 匿名帖不能扇给「关注作者」的人
 * ─────────────────────────────────────────
 *
 * 按作者订阅的那条路，收件人名单本身就是答案：
 * 「你关注的张三发了新帖」+ 一个匿名帖的链接 = 匿名当场失效。
 * 所以匿名帖直接跳过作者订阅这一路，版块与标签那两路
 * 也必须把作者名抹掉。
 */

export const FOLLOW_TARGETS = ["user", "board", "tag"] as const;
export type FollowTarget = (typeof FOLLOW_TARGETS)[number];

export const TARGET_LABEL: Record<FollowTarget, string> = {
  user: "作者",
  board: "版块",
  tag: "标签",
};

/**
 * 关注上限。
 *
 * 不是怕存不下，是怕**收件箱变成一条什么都在里面的河**。
 * 关注一百个人之后，「有人找你」和「有人发帖」混在一起，
 * 而前者才是必须看到的那一类 —— 到那时候人会把整页都关掉。
 */
export const MAX_FOLLOWS: Record<FollowTarget, number> = {
  user: 50,
  board: 20,
  tag: 30,
};

export type FollowVerdict = { ok: true } | { ok: false; reason: string };

export function canFollow(input: {
  target: FollowTarget;
  current: number;
  /** 关注自己没有意义 —— 自己发的帖不会给自己发通知 */
  isSelf?: boolean;
}): FollowVerdict {
  if (input.isSelf) {
    return { ok: false, reason: "不用关注自己 —— 你发的帖本来就在「我的」里" };
  }
  if (input.current >= MAX_FOLLOWS[input.target]) {
    return {
      ok: false,
      reason: `最多关注 ${MAX_FOLLOWS[input.target]} 个${TARGET_LABEL[input.target]} —— 再多通知就成了一条什么都在里面的河`,
    };
  }
  return { ok: true };
}

/**
 * 一条新帖同时命中好几种关注时，按谁来说这句话。
 *
 * ─────────────────────────────────────────
 * 一个人只该收到一条
 * ─────────────────────────────────────────
 *
 * 关注了张三、又关注了他常去的版块，他发一个帖 ——
 * 不去重就是两条一模一样的通知，而收到两条的人第一反应是这个站坏了。
 *
 * 具体到用哪一路的措辞：越**具体**的关注越优先。
 * 关注一个人是明确挑出来的，关注版块是「这块我都想看看」——
 * 说「你关注的张三发了新帖」比「综合讨论有新帖」信息量大得多。
 */
const PRIORITY: FollowTarget[] = ["user", "tag", "board"];

export function pickSource(hits: FollowTarget[]): FollowTarget | null {
  for (const target of PRIORITY) {
    if (hits.includes(target)) return target;
  }
  return null;
}

export interface NoticeCopy {
  title: string;
  /** 同一来源的未读通知会合并计数，所以 groupKey 按来源分，不按帖子分 */
  groupKey: string;
  /**
   * 合并成 n 条之后标题怎么写。
   *
   * 通用的那套合并写法是「张三等 3 人回复了你的帖子」——
   * 它假设标题以人名开头，而这里两种都不成立：
   *
   * · 版块那一路的标题是「综合讨论有新帖」，套上去变成
   *   「某人等 2 人综合讨论有新帖」，不成句
   * · 作者那一路更糟：groupKey 按作者分，合并的永远是**同一个人**，
   *   而「张三等 2 人」在说有两个人发了帖
   */
  aggregate: (count: number) => string;
}

/**
 * 通知怎么写。
 *
 * groupKey **按来源而不是按帖子**：一个活跃版块一天十条新帖，
 * 按帖子分就是十条通知，按来源分是一条「综合讨论有 10 个新帖」。
 * 后者是人想要的 —— 前者会让人关掉这一类，然后连关注的人发帖也收不到。
 */
export function noticeCopy(input: {
  source: FollowTarget;
  sourceId: string;
  sourceName: string;
  /** 匿名帖这里必须是 null */
  authorName: string | null;
}): NoticeCopy {
  const groupKey = `newpost:${input.source}:${input.sourceId}`;

  if (input.source === "user" && input.authorName) {
    const who = input.authorName;
    return {
      title: `${who}发了新帖`,
      groupKey,
      aggregate: (n) => `${who}发了 ${n} 个新帖`,
    };
  }
  if (input.source === "board") {
    return {
      title: `${input.sourceName}有新帖`,
      groupKey,
      // 不说是谁发的 —— 一个版块里的多条新帖通常来自不同的人
      aggregate: (n) => `${input.sourceName}有 ${n} 个新帖`,
    };
  }
  return {
    title: `#${input.sourceName} 有新帖`,
    groupKey,
    aggregate: (n) => `#${input.sourceName} 有 ${n} 个新帖`,
  };
}

/**
 * 退关是**真的删掉**，不是静音。
 *
 * 帖子订阅用静音，因为发帖回帖会自动订阅回来 ——
 * 删掉的话退订按钮下一次回帖就失效了。
 * 而关注人／版块／标签只有手动一条路进来，
 * 没有任何东西会把它加回去，留一行「已静音」只会让
 * 「我关注的」列表里堆着一串自己已经取消的东西。
 */
export function unfollowIsDelete(target: FollowTarget): boolean {
  return FOLLOW_TARGETS.includes(target);
}

/**
 * 谁能看见「谁关注了谁」。
 *
 * ─────────────────────────────────────────
 * 只有自己
 * ─────────────────────────────────────────
 *
 * 关注列表是一张社交图。这个站的成员目录只对同群的人开放，
 * 而一份公开的粉丝列表会把「谁在注意谁」摊开给所有人 ——
 * 那是群成员名单之外的第二层隐私，而且没人预期它是公开的。
 *
 * 同理不给被关注的人发「有人关注了你」：那条通知泄露的正是同一件事。
 */
export const FOLLOWS_ARE_PRIVATE = true;

export function canSeeFollowList(viewerId: string | null, ownerId: string): boolean {
  return viewerId !== null && viewerId === ownerId;
}
