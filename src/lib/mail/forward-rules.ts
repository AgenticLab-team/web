/**
 * 转发到私人邮箱的**纯规则**。不碰库、不发信。
 *
 * ═════════════════════════════════════════
 * 转发最容易出的错是把自己变成开放中继
 * ═════════════════════════════════════════
 *
 * 「收到什么就往外发什么」这件事，本质上是让**任何人**都能通过
 * 我们的服务器给**任何地址**投递内容 —— 而收件人看到的发件人是我们。
 *
 * 那种服务器叫开放中继，它的下场是固定的：几天之内被拿去发垃圾，
 * 然后我们的域名进黑名单，然后**这个站所有的正常邮件都发不出去**。
 *
 * 所以下面每一条都在关同一扇门的不同缝：
 *
 *   ① 目标地址必须**验证过** —— 否则一个笔误就把私信转给陌生人
 *   ② 不转发到**我们自己的域名** —— 那是个无限循环
 *   ③ 有**频率上限** —— 被拿去当靶子时，上限就是爆炸半径
 *   ④ 转发的信**原样带上原始发件人**，而信封发件人是我们自己的地址
 *      —— 收件人一眼看得出这是转发，而退信回到我们这里不会
 *      变成第二次「代别人发信」
 */

/** 转发要几级 */
export const FORWARD_MIN_LEVEL = 5;

/**
 * 一个人一小时最多转发几封。
 *
 * ─────────────────────────────────────────
 * 这个数不是性能考虑，是**爆炸半径**
 * ─────────────────────────────────────────
 *
 * 临时箱最常见的滥用就是被拿去做转发靶子（`MAIL.md` 那条）：
 * 有人把一个能公开投递的地址挂出去，然后所有垃圾邮件都经我们
 * 转到某个受害者信箱里 —— 而在收件人眼里，**发信的是我们**。
 *
 * 上限之外的不排队、直接丢，并记一条事件。排队的话，
 * 攻击停下来之后那些信还会继续发出去，而那时候没有人在看。
 */
export const FORWARD_PER_HOUR = 50;

export type ForwardRefusal =
  | { code: "level"; need: number; have: number }
  | { code: "unverified" }
  | { code: "self_domain"; domain: string }
  | { code: "rate"; limit: number };

/**
 * 这封信能不能转发出去。
 *
 * 顺序照旧：先说他改变不了的（等级），再说他要动手的（验证），
 * 最后才是当下的状态（频率）。
 */
export function canForward(input: {
  level: number;
  target: string | null;
  targetVerified: boolean;
  /** 我们自己的域名（punycode 形式）—— 转到这里是无限循环 */
  ourDomains: readonly string[];
  sentLastHour: number;
}): ForwardRefusal | null {
  if (input.level < FORWARD_MIN_LEVEL) {
    return { code: "level", need: FORWARD_MIN_LEVEL, have: input.level };
  }
  if (!input.target || !input.targetVerified) return { code: "unverified" };

  const domain = input.target.split("@")[1]?.toLowerCase() ?? "";
  if (input.ourDomains.some((d) => d.toLowerCase() === domain)) {
    /*
     * 转到我们自己的域名上 = 那封信会再进一次收信流程，
     * 然后再被转发一次，然后……
     *
     * 这一条不能靠「用户不会那么干」：他可能把自己的一次性箱
     * 填进去当作「备份一份」，而那正好是最像合理用法的一种。
     */
    return { code: "self_domain", domain };
  }
  if (input.sentLastHour >= FORWARD_PER_HOUR) return { code: "rate", limit: FORWARD_PER_HOUR };
  return null;
}

export function explainForwardRefusal(r: ForwardRefusal): string {
  switch (r.code) {
    case "level":
      return `转发要 L${r.need}，你现在 L${r.have}`;
    case "unverified":
      return "先填一个私人邮箱并验证它 —— 没验证过的地址不转，一个笔误就把私信寄给陌生人了";
    case "self_domain":
      return `不能转发到 ${r.domain} —— 那是站里自己的域名，转过去会绕回来再转一次`;
    case "rate":
      return `一小时最多转 ${r.limit} 封，超出的丢掉了`;
  }
}

/**
 * 转发出去那封信长什么样。
 *
 * ─────────────────────────────────────────
 * 发件人是**我们**，而原始发件人写在正文顶上
 * ─────────────────────────────────────────
 *
 * 直接拿原始发件人当 From 发出去（伪造发件人）是最直觉的做法，
 * 而它会让每一封转发都通不过 SPF/DKIM —— 对方的收件箱要么判垃圾，
 * 要么直接拒收。更糟的是它让我们看起来在冒充别人。
 *
 * 所以 From 用我们自己的地址，`Reply-To` 指向原始发件人
 * （这样「回复」还是回给对方），正文顶上写清楚这是转发。
 */
export function forwardEnvelope(input: {
  originalFrom: string | null;
  originalFromName: string | null;
  toAddress: string;
  subject: string | null;
  bodyText: string | null;
  mailFrom: string;
}): { subject: string; text: string; replyTo: string | null } {
  const who = input.originalFromName
    ? `${input.originalFromName} <${input.originalFrom ?? "未知"}>`
    : (input.originalFrom ?? "未知发件人");

  return {
    // 前缀用中文的「转发」而不是 Fwd:，因为收件人是这个站的人
    subject: `[转发] ${input.subject ?? "(无主题)"}`,
    text:
      `这封信是 ${input.toAddress} 收到的，由 Agentic Lab 转发。\n` +
      `原始发件人：${who}\n` +
      `${"─".repeat(30)}\n\n` +
      (input.bodyText ?? "(没有纯文本正文)"),
    replyTo: input.originalFrom,
  };
}
