/**
 * 附件保不保存 —— **纯规则**，不碰库、不碰文件。
 *
 * ═════════════════════════════════════════
 * 默认不保存，这是设计不是省事
 * ═════════════════════════════════════════
 *
 * 九成的临时邮件里那个附件没人会点开，而附件是这套东西里
 * 唯一真正吃盘的部分。所以门开得很小：**够等级、够小、有配额**，
 * 三样缺一就只留文件名和大小。
 *
 * 界面上那时要显示「文件名 · 大小 · 未保存」——
 * 而不是一个点了没反应的下载按钮。一个按下去什么都不发生的按钮，
 * 比明说「没存」糟得多。
 *
 * ─────────────────────────────────────────
 * 为什么是等级而不是积分
 * ─────────────────────────────────────────
 *
 * `MAIL.md` 四节那条：**最贵的资源是磁盘**，所以「能不能落盘」
 * 放在等级上，而不是放在积分上。用积分买磁盘意味着
 * 有人可以一次性买爆磁盘。
 */

/** 附件要落盘至少几级 */
export const ATTACHMENT_MIN_LEVEL = 4;

/** 单个附件最大多少字节。超了只留元信息 */
export const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;

/** 一个人一共能存多少字节的附件 */
export const ATTACHMENT_QUOTA_BYTES = 50 * 1024 * 1024;

export type SkipReason =
  /** 等级不够 */
  | "level"
  /** 这一个太大 */
  | "too_big"
  /** 这个人的总配额满了 */
  | "quota"
  /** 网关没把内容发过来（老版本网关，或者它自己也判定不该带） */
  | "no_content";

export interface AttachmentVerdict {
  store: boolean;
  reason?: SkipReason;
}

/**
 * 这一个附件要不要存。
 *
 * 判断顺序是有讲究的：**先说他改变不了的**（等级），
 * 再说这一个的问题（太大），最后才说配额 ——
 * 配额是唯一一个他清一清就能腾出来的。
 */
export function shouldStore(input: {
  level: number;
  size: number;
  hasContent: boolean;
  /** 这个人已经存了多少字节 */
  usedBytes: number;
}): AttachmentVerdict {
  if (input.level < ATTACHMENT_MIN_LEVEL) return { store: false, reason: "level" };
  if (!input.hasContent) return { store: false, reason: "no_content" };
  if (input.size > ATTACHMENT_MAX_BYTES) return { store: false, reason: "too_big" };
  if (input.usedBytes + input.size > ATTACHMENT_QUOTA_BYTES) {
    return { store: false, reason: "quota" };
  }
  return { store: true };
}

/** 把「为什么没存」说成人话。每一句都要说出下一步能做什么 */
export function explainSkip(reason: SkipReason): string {
  switch (reason) {
    case "level":
      return `附件要 L${ATTACHMENT_MIN_LEVEL} 才保存 —— 现在只留了文件名和大小`;
    case "too_big":
      return `超过 ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}M，没有保存`;
    case "quota":
      return `附件空间满了（一共 ${Math.round(ATTACHMENT_QUOTA_BYTES / 1024 / 1024)}M）—— 删掉几封旧信就能腾出来`;
    case "no_content":
      return "这封信的附件没有传过来";
  }
}
