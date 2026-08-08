import type { Visibility } from "@/lib/db/schema/forum";

/**
 * 帖子可见性判定。
 *
 * 这是论坛里最不能出错的一段代码：判松了泄露私密群聊，
 * 判严了整个论坛没人看得见。所以它被写成**纯函数** ——
 * 不碰数据库、不读会话，全部输入显式传进来，好让矩阵测试逐条覆盖。
 *
 * 三条硬约束写死在这里，配置改不动（见 FORUM.md 4.2）：
 *   1. 群聊派生内容永不 public / unlisted
 *   2. 群聊转帖锁定在原群范围，提升需审核 + 原作者同意
 *   3. external 与访客永远看不到任何群消息派生内容
 */

/** 从宽到严。索引越大越私密 */
const ORDER: Visibility[] = ["public", "unlisted", "member", "role", "group", "private"];

export function isStricter(a: Visibility, b: Visibility): boolean {
  return ORDER.indexOf(a) > ORDER.indexOf(b);
}

/**
 * 取两者中更严的那个。
 * 版块封顶就是这么生效的：帖子想公开，但版块只允许到 member，结果是 member。
 */
export function capVisibility(requested: Visibility, boardMax: Visibility): Visibility {
  return isStricter(requested, boardMax) ? requested : boardMax;
}

export interface PostVisibilityInfo {
  visibility: Visibility;
  /** role 级需要的身份组 */
  visibilityRoleId?: string | null;
  /** group 级需要的群 */
  visibilityGroupId?: string | null;
  authorId: string;
  status: "draft" | "published" | "locked" | "hidden" | "deleted";
  /** 是否由群聊转帖而来。这类内容受硬约束 1 与 2 管辖 */
  fromGroupChat?: boolean;
}

export interface ViewerContext {
  userId: string | null;
  /** member / external / null(访客) */
  kind: "member" | "external" | null;
  /** 这个人所在的群 */
  groupIds: string[];
  /** 这个人持有的身份组 id */
  roleIds: string[];
  /** 是否有跨越可见性的管理权限（管理员、对应版块的版主） */
  canModerate: boolean;
}

export const GUEST: ViewerContext = {
  userId: null,
  kind: null,
  groupIds: [],
  roleIds: [],
  canModerate: false,
};

export type VisibilityVerdict = { visible: true } | { visible: false; reason: string };

export function canSeePost(post: PostVisibilityInfo, viewer: ViewerContext): VisibilityVerdict {
  const deny = (reason: string): VisibilityVerdict => ({ visible: false, reason });

  // 作者永远看得见自己的东西，草稿也不例外
  const isAuthor = Boolean(viewer.userId) && viewer.userId === post.authorId;

  if (post.status === "deleted") {
    return viewer.canModerate ? { visible: true } : deny("内容已删除");
  }
  if (post.status === "hidden" && !isAuthor && !viewer.canModerate) {
    return deny("内容已被隐藏");
  }
  if (post.status === "draft" && !isAuthor && !viewer.canModerate) {
    return deny("草稿只有作者可见");
  }

  if (isAuthor) return { visible: true };

  /*
   * 硬约束 3：群聊派生内容对访客与 external 永远不可见。
   * 放在管理员判定**之前**也无所谓 —— 管理员一定是 member。
   * 但放在可见性级别判定之前是必须的：哪怕某个帖子被误标成 public，
   * 只要它来自群聊，访客就看不到。
   */
  if (post.fromGroupChat && viewer.kind !== "member") {
    return deny("群聊内容仅对社群成员开放");
  }

  if (viewer.canModerate) return { visible: true };

  switch (post.visibility) {
    case "public":
    case "unlisted":
      // 硬约束 1 由 normalizePostVisibility 在写入时保证，这里再兜一次
      if (post.fromGroupChat) return deny("群聊内容不可公开");
      return { visible: true };

    case "member":
      return viewer.kind === "member" || viewer.kind === "external"
        ? { visible: true }
        : deny("请先登录");

    case "role":
      if (!post.visibilityRoleId) return deny("可见范围未配置");
      return viewer.roleIds.includes(post.visibilityRoleId)
        ? { visible: true }
        : deny("你没有查看这条内容的身份");

    case "group":
      if (!post.visibilityGroupId) return deny("可见范围未配置");
      // external 用户拿不到任何群的可见权，这里天然为 false
      return viewer.groupIds.includes(post.visibilityGroupId)
        ? { visible: true }
        : deny("仅该群成员可见");

    case "private":
      return deny("仅作者可见");
  }
}

/**
 * 写入时对可见性做规范化。
 *
 * 这是硬约束 1 与 2 的落点：**不管调用方传什么**，
 * 群聊派生内容都会被压到 group 级并锁定。
 * 校验放在写入侧而不是读取侧 —— 读取侧漏一处就是泄露。
 */
export function normalizePostVisibility(input: {
  requested: Visibility;
  boardMax: Visibility;
  fromGroupChat?: boolean;
  sourceGroupId?: string | null;
}): { visibility: Visibility; visibilityGroupId: string | null; locked: boolean } {
  if (input.fromGroupChat) {
    return {
      visibility: "group",
      visibilityGroupId: input.sourceGroupId ?? null,
      // 锁定后普通编辑改不动可见性，必须走审核 + 原作者同意
      locked: true,
    };
  }

  return {
    visibility: capVisibility(input.requested, input.boardMax),
    visibilityGroupId: null,
    locked: false,
  };
}

/** 能否被搜索引擎索引。只有 public 可以 */
export function isIndexable(post: PostVisibilityInfo): boolean {
  return post.visibility === "public" && post.status === "published" && !post.fromGroupChat;
}

/**
 * 看不见的内容该返回 404 还是 403。
 *
 * 一律 404。403 等于告诉对方「这个帖子存在，只是你看不了」——
 * 对私密内容来说，存在性本身就是信息。
 */
export const NOT_VISIBLE_STATUS = 404;
