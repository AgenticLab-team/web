/**
 * 编辑与折叠回复的规则。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 三个字段一直在库里，一个都没接上
 * ─────────────────────────────────────────
 *
 * · `replies.edit_count` —— 列在、查询也读它，但**没有任何地方写它**，
 *   因为根本没有编辑回复的入口
 * · `replies.collapsed` / `collapse_reason` —— 查询把它们取出来了，
 *   而**界面上一处都没渲染**：折叠一条回复和不折叠长得一模一样
 * · `moderateReply` —— 支持 hide/delete/restore/collapse 四种动作，
 *   而全站没有一个组件调它
 *
 * 第二条最糟：数据写进去了、看起来生效了，而实际什么都没发生。
 * 这比「功能没做」更难发现 —— 版主会以为自己折叠成功了。
 *
 * ─────────────────────────────────────────
 * 编辑回复和编辑帖子不是一回事
 * ─────────────────────────────────────────
 *
 * 帖子是一个人的表达，改了就改了。**回复是对话的一部分** ——
 * 底下可能已经有人引用它、回应它。悄悄改掉一条被引用过的回复，
 * 会让后面那串回应看起来莫名其妙，而读的人只会觉得那些人在胡言乱语。
 *
 * 所以这里的规矩比帖子严：
 *   · 改过就必须显示「编辑过」，不给「小改不标记」的口子
 *   · 超过一段时间就不让改了 —— 那时候对话已经往下走了
 */

/** 发出去多久之内还能改 */
export const EDIT_WINDOW_MS = 30 * 60_000;

export const MIN_REPLY_CHARS = 1;
export const MAX_REPLY_CHARS = 8000;

export type EditVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 能不能编辑这条回复。
 *
 * `isModerator` 走的是另一条路 —— 版主改别人的话属于**处置**，
 * 不属于编辑，应该走 moderateReply 留处罚记录。
 * 所以这个函数只回答「作者自己能不能改」。
 */
export function canEditReply(input: {
  isAuthor: boolean;
  status: string;
  createdAt: number;
  now: number;
}): EditVerdict {
  if (!input.isAuthor) {
    return { ok: false, reason: "只能改自己的回复" };
  }
  if (input.status !== "published") {
    return { ok: false, reason: "被折叠或删除的回复改不了 —— 先联系版主" };
  }

  const age = input.now - input.createdAt;
  if (age > EDIT_WINDOW_MS) {
    return {
      ok: false,
      reason: `超过 ${Math.round(EDIT_WINDOW_MS / 60_000)} 分钟就不能改了 —— 底下可能已经有人在回应它`,
    };
  }
  return { ok: true };
}

export type ContentVerdict = { ok: true; content: string } | { ok: false; reason: string };

export function checkReplyContent(raw: string): ContentVerdict {
  const content = raw.trim();
  if (content.length < MIN_REPLY_CHARS) {
    /*
     * 不允许改成空。
     *
     * 「清空」在效果上等于删除，但**不会留下删除记录**，
     * 于是引用它的那几条会指向一个空气泡，而没有任何地方
     * 说明发生过什么。要删就走删除。
     */
    return { ok: false, reason: "改成空的等于删除 —— 那就直接删，会留记录" };
  }
  if (content.length > MAX_REPLY_CHARS) {
    return { ok: false, reason: `太长了（上限 ${MAX_REPLY_CHARS} 字）` };
  }
  return { ok: true, content };
}

/**
 * 折叠之后还显示什么。
 *
 * ─────────────────────────────────────────
 * 折叠不是删除
 * ─────────────────────────────────────────
 *
 * 折叠的用处是「这条没营养，但它确实存在过」——
 * 藏得一干二净的话，引用过它的那几条就变成了自言自语。
 *
 * 所以折叠后仍然显示：谁说的、第几楼、为什么被折叠，
 * 以及一个能展开看原文的口子。**理由必须显示** ——
 * 一条没有理由的折叠，和版主随手删人没有区别。
 */
export interface CollapsedView {
  summary: string;
  expandable: boolean;
}

export function collapsedView(input: {
  authorName: string;
  floor: number;
  reason: string | null;
}): CollapsedView {
  const why = input.reason?.trim();
  return {
    summary: why
      ? `${input.floor} 楼 · ${input.authorName} 的回复被折叠了：${why}`
      : `${input.floor} 楼 · ${input.authorName} 的回复被折叠了`,
    expandable: true,
  };
}

/** 编辑说明必填的最短长度 —— 「改了个错字」也是说明 */
export const MIN_EDIT_NOTE = 0;

/**
 * 改过就要标出来，没有「小改不算」这一说。
 *
 * 给出「改动很小就不标记」的口子之后，它会被用来
 * 悄悄改掉一句话的意思 —— 而那正是最需要标出来的那种改动。
 */
export function shouldMarkEdited(): boolean {
  return true;
}
