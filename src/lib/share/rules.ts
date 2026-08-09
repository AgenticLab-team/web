/**
 * 分享的规则。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 图片是一份跑掉了就收不回来的副本
 * ─────────────────────────────────────────
 *
 * 链接还能靠权限收口 —— 对方点进来没权限就看不到。
 * **图片不行。** 生成的那一刻内容就离开了这个站，之后发到哪、
 * 被谁看到，我们一点办法都没有。
 *
 * 所以不能把「链接能分享的」和「图片能分享的」当成同一件事。
 *
 * ─────────────────────────────────────────
 * 但也不能装作能拦住
 * ─────────────────────────────────────────
 *
 * 成员本来就能截图。禁掉生成图片不会让内容更安全，
 * 只会让人去用截图 —— 而截图上什么都没有：没有出处、没有时间、
 * 没有「这是成员社区内部内容」的标记。
 *
 * 所以这里的立场是：**不去拦人能做的事，但不替他多泄露一分**。
 * 具体三条：
 *
 *   1. 群聊图上**永远不出现群名**。群的身份是这个站最不能外泄的东西 ——
 *      「这条消息来自哪个群」比消息本身敏感得多
 *   2. 图上带出处标记，让拿到图的人知道它来自一个成员社区
 *   3. 生成即记审计。图跑出去之后，至少查得到是谁生成的
 */

export type ShareKind = "post" | "window";

export type ShareVerdict =
  | { ok: true; redactGroupName: boolean }
  | { ok: false; reason: string };

/**
 * 论坛帖能不能生成分享图。
 *
 * 公开帖 —— 随便分享，它本来就是公开的。
 * 成员可见的帖 —— 允许成员生成，但要标出「内部内容」。
 * 草稿、已删除、私密 —— 不给。那些东西连作者之外的人都不该看到，
 * 做成一张图之后**连作者自己都控制不住它去哪**。
 */
export function canSharePost(input: {
  visibility: string;
  status: string;
  viewerCanSee: boolean;
}): ShareVerdict {
  if (!input.viewerCanSee) return { ok: false, reason: "你看不到这个帖子" };
  if (input.status !== "published") {
    return { ok: false, reason: "草稿和已删除的帖子不能生成分享图" };
  }
  if (input.visibility === "private") {
    return { ok: false, reason: "私密内容不生成图片 —— 图跑出去就收不回来了" };
  }
  return { ok: true, redactGroupName: input.visibility !== "public" };
}

/**
 * 群聊片段能不能生成分享图。
 *
 * **群名一律不出现**，不管谁来分享 —— 这不是可配置项。
 * 「这条消息来自哪个群」比消息本身敏感得多：
 * 它同时泄露了群的存在、群的主题、以及分享者在那个群里。
 */
export function canShareWindow(input: { viewerIsMember: boolean }): ShareVerdict {
  if (!input.viewerIsMember) {
    return { ok: false, reason: "你不在这个群里" };
  }
  return { ok: true, redactGroupName: true };
}

/** 图上最多画几条消息 —— 再多就看不清了，而看不清的图没人会转 */
export const MAX_IMAGE_MESSAGES = 12;

/** 单条消息在图上最多显示多少字 */
export const MAX_IMAGE_MESSAGE_CHARS = 90;

export interface ShareMessage {
  senderName: string;
  content: string;
  ts: number;
}

/**
 * 把一段对话裁成图上放得下的样子。
 *
 * 从**后往前**取:一段对话的结论通常在末尾,
 * 而截断了结论的分享图会让人看不懂在讲什么。
 */
export function trimForImage(
  messages: ShareMessage[],
  limit = MAX_IMAGE_MESSAGES,
): { shown: ShareMessage[]; omitted: number } {
  if (messages.length <= limit) return { shown: messages, omitted: 0 };
  return { shown: messages.slice(-limit), omitted: messages.length - limit };
}

export function clampContent(text: string, limit = MAX_IMAGE_MESSAGE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * 分享文案。
 *
 * ─────────────────────────────────────────
 * 文案里带链接，而链接是有权限的
 * ─────────────────────────────────────────
 *
 * 这一条让分享变得安全:文案可以随便转，
 * 而真正的内容在链接后面，谁点进来都要过一遍权限。
 * 所以文案里只放**足以让人决定要不要点**的信息，不放正文。
 */
export function shareText(input: {
  kind: ShareKind;
  title: string;
  url: string;
  /** 帖子的摘要 / 群聊片段的第一句 */
  excerpt?: string | null;
  siteName?: string;
}): string {
  const site = input.siteName ?? "Agentic Lab";
  const lines: string[] = [];

  if (input.kind === "post") {
    lines.push(input.title);
    if (input.excerpt) lines.push(clampContent(input.excerpt, 60));
  } else {
    /*
     * 群聊片段不给标题 —— 标题只能从内容里编，
     * 而编出来的标题会比内容本身传播得更远、也更容易失真。
     */
    lines.push("一段群聊记录");
    if (input.excerpt) lines.push(clampContent(input.excerpt, 60));
  }

  lines.push(input.url);
  lines.push(`—— ${site}`);
  return lines.join("\n");
}

/**
 * 图上那行出处。
 *
 * 拿到图的人得知道它来自哪 —— 不是为了引流，
 * 是为了让他知道这是**成员社区的内部内容**，不是公开发布的东西。
 */
export function attribution(input: { siteName?: string; memberOnly: boolean }): string {
  const site = input.siteName ?? "Agentic Lab";
  return input.memberOnly ? `${site} · 成员社区内部内容` : site;
}
