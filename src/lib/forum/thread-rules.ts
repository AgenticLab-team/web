/**
 * 楼中楼（树形视图）。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 先量了一下：28 条回复，0 次引用
 * ─────────────────────────────────────────
 *
 * `replies.parent_id` 零引用，`quoted_reply_id` 也一行数据都没有。
 *
 * 也就是说树是空的 —— 而原因不是没人想回复某一楼，
 * 是那个动作在界面上**几乎不存在**：它是一个没有文字、
 * 用最淡的墨色画的引号图标。
 *
 * 所以这件事得倒过来做：先让「回复这一楼」看得见，
 * 树才有东西可长。只做视图的话，就是又一个死开关 ——
 * 一棵永远只有一层的树，和平铺看起来一模一样。
 *
 * ─────────────────────────────────────────
 * 楼层号不跟着树变
 * ─────────────────────────────────────────
 *
 * 树形只是**一种看法**，不是重新编号。#12 在两种视图下
 * 指的必须是同一条 —— 它是这个页面唯一能拿去引用、
 * 能贴进群里的坐标。按树的顺序重排编号，等于让所有
 * 已经发出去的 `#12` 全部指错。
 */

export const VIEW_MODES = ["flat", "threaded"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export function parseViewMode(value: string | undefined, fallback: ViewMode): ViewMode {
  return value === "flat" || value === "threaded" ? value : fallback;
}

/**
 * 视觉上最多缩进几层。
 *
 * ─────────────────────────────────────────
 * 手机屏幕是硬约束
 * ─────────────────────────────────────────
 *
 * 每层缩进大约 16px。手机上正文栏本来就窄，
 * 缩到第六层时留给文字的宽度只剩不到一半 ——
 * 一句话被切成七行，而那七行讲的是同一件事。
 *
 * 超过这个深度的仍然显示，只是不再往里缩，靠「回复 #12」
 * 那一行说明它接的是谁。信息一点不少，只是不再用缩进表达。
 */
export const MAX_DEPTH = 3;

export interface FlatReply {
  id: string;
  floor: number;
  parentId: string | null;
}

export interface ThreadNode<T extends FlatReply> {
  reply: T;
  /** 真实层级，可能超过 MAX_DEPTH */
  depth: number;
  /** 实际用来缩进的层级，封顶在 MAX_DEPTH */
  indent: number;
  /**
   * 父级被删掉了，这条被提到了顶层。
   *
   * 界面上要说一句 —— 否则一条明明在回答别人的话
   * 会突然以顶层身份出现，读起来像是在自言自语。
   */
  orphaned: boolean;
  /** 直接子节点数（不含更深的）—— 折叠时要显示「还有 N 条」 */
  childCount: number;
  /** 这一支底下总共多少条 */
  descendantCount: number;
}

/**
 * 把平铺的回复排成树的显示顺序。
 *
 * 返回的仍然是**一维数组** —— 界面按 indent 缩进就行，
 * 不用递归组件。递归渲染在这种场景下没有好处，
 * 反而会让「折叠某一支」变成一件要往下传状态的事。
 */
export function buildThread<T extends FlatReply>(replies: T[]): ThreadNode<T>[] {
  const byId = new Map(replies.map((r) => [r.id, r]));

  /*
   * 父级不在这批里 = 被删了 / 被折叠滤掉了 / 数据坏了。
   * 一律当顶层处理并标记 —— **绝不能因为找不到父级就丢掉**。
   */
  const childrenOf = new Map<string | null, T[]>();
  const orphans = new Set<string>();

  for (const r of replies) {
    const hasParent = r.parentId !== null && byId.has(r.parentId);
    if (r.parentId !== null && !hasParent) orphans.add(r.id);

    const key = hasParent ? r.parentId : null;
    const list = childrenOf.get(key);
    if (list) list.push(r);
    else childrenOf.set(key, [r]);
  }

  // 同一层按楼层升序 —— 楼层就是时间顺序，读起来才是对话的样子
  for (const list of childrenOf.values()) list.sort((a, b) => a.floor - b.floor);

  const out: ThreadNode<T>[] = [];
  const counted = new Map<string, number>();

  const countDescendants = (id: string): number => {
    const cached = counted.get(id);
    if (cached !== undefined) return cached;
    // 先占位，万一数据里有环也不会无限递归
    counted.set(id, 0);
    const kids = childrenOf.get(id) ?? [];
    const total = kids.reduce((sum, k) => sum + 1 + countDescendants(k.id), 0);
    counted.set(id, total);
    return total;
  };

  const walk = (parent: string | null, depth: number) => {
    for (const reply of childrenOf.get(parent) ?? []) {
      const kids = childrenOf.get(reply.id) ?? [];
      out.push({
        reply,
        depth,
        indent: Math.min(depth, MAX_DEPTH),
        orphaned: orphans.has(reply.id),
        childCount: kids.length,
        descendantCount: countDescendants(reply.id),
      });
      /*
       * 深度上限只封**缩进**，不封遍历 —— 再深的回复也要显示出来。
       * 封遍历的话，一串长对话会在第四层凭空消失，
       * 而且没有任何地方说明它去哪了。
       */
      walk(reply.id, depth + 1);
    }
  };

  walk(null, 0);

  /*
   * 兜底：如果因为环之类的原因漏了谁，把漏掉的补在最后。
   *
   * 宁可显示得难看，也不能让一条回复凭空消失 ——
   * 写它的人会以为被删了。
   */
  if (out.length !== replies.length) {
    const shown = new Set(out.map((n) => n.reply.id));
    for (const r of replies) {
      if (shown.has(r.id)) continue;
      out.push({ reply: r, depth: 0, indent: 0, orphaned: true, childCount: 0, descendantCount: 0 });
    }
  }

  return out;
}

/**
 * 平铺视图的顺序：就是楼层顺序。
 *
 * 单独写出来是为了让两种视图在同一处对照 ——
 * 「树形只是换个顺序和缩进」这件事，读代码时应该一眼看得到。
 */
export function buildFlat<T extends FlatReply>(replies: T[]): ThreadNode<T>[] {
  return [...replies]
    .sort((a, b) => a.floor - b.floor)
    .map((reply) => ({
      reply,
      depth: 0,
      indent: 0,
      orphaned: false,
      childCount: 0,
      descendantCount: 0,
    }));
}

export function arrange<T extends FlatReply>(replies: T[], mode: ViewMode): ThreadNode<T>[] {
  return mode === "threaded" ? buildThread(replies) : buildFlat(replies);
}

/**
 * 这个帖子值不值得给「树形」这个选项。
 *
 * 一条嵌套都没有的时候，两种视图长得**一模一样** ——
 * 摆一个切换按钮在那儿，点了什么都不变，
 * 人第一反应是这个站坏了。
 */
export function threadingIsMeaningful(replies: FlatReply[]): boolean {
  const ids = new Set(replies.map((r) => r.id));
  return replies.some((r) => r.parentId !== null && ids.has(r.parentId));
}
