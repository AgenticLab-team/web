import "server-only";

/**
 * 往外发一封信。**只有一个出口,而它默认是关的。**
 *
 * ═════════════════════════════════════════
 * 为什么不是 SMTP
 * ═════════════════════════════════════════
 *
 * 实测过：**源站出站 25 端口被云厂商封死**（连 gmail 的 MX 直接超时）。
 * 这不是配置问题，是他们的策略，改不了。
 * 所以发信只能走 HTTPS 接口，无论网关在哪台机器上。
 * （`ops/mail-gateway/README.md` 里记着这条实测。）
 *
 * ─────────────────────────────────────────
 * 供应商做成可换的，但**不做成一个抽象框架**
 * ─────────────────────────────────────────
 *
 * 站长还没定用哪家。做一层薄适配（一个函数、一个 switch）比等他定
 * 要好，而做一套「发信提供商插件体系」就过头了 ——
 * 这个站一辈子也不会同时用两家。
 *
 * 换一家的成本：加一个 case，改一个环境变量。
 *
 * ─────────────────────────────────────────
 * 没配就**明确失败**，不静默丢
 * ─────────────────────────────────────────
 *
 * 静默丢的话，转发功能会在界面上显示成「开着」而实际什么都不发 ——
 * 而用户要在几天之后、发现自己漏了一封重要邮件时才知道。
 * 宁可在开启转发的那一刻就告诉他「站里还没配发信」。
 */

export type SendResult =
  | { ok: true; id?: string }
  | { ok: false; error: string; retryable: boolean };

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
  replyTo?: string | null;
}

/** 配没配发信。界面靠它决定要不要给「转发」这个开关 */
export function senderConfigured(): boolean {
  return Boolean(process.env.MAIL_SEND_PROVIDER && process.env.MAIL_SEND_KEY);
}

/** 发信用的地址。收件人看到的 From 就是它 */
export function senderAddress(): string {
  return process.env.MAIL_SEND_FROM ?? "noreply@agenticlab.sh";
}

export async function sendMail(mail: OutboundMail): Promise<SendResult> {
  const provider = process.env.MAIL_SEND_PROVIDER;
  const key = process.env.MAIL_SEND_KEY;

  if (!provider || !key) {
    return { ok: false, error: "站里还没配发信服务", retryable: false };
  }

  switch (provider) {
    case "resend":
      return sendViaResend(mail, key);
    default:
      /*
       * 认不出的供应商名当作没配，而不是当作某个默认值。
       *
       * 猜一个默认值的后果是：他把 `MAIL_SEND_PROVIDER` 拼错了，
       * 而系统安静地用了另一家的接口、拿着一把不匹配的 key，
       * 然后所有转发都失败，错误信息是「401」。
       */
      return { ok: false, error: `不认识的发信服务：${provider}`, retryable: false };
  }
}

/**
 * Resend。选它是因为接口最小（一个 POST、一个 key），
 * 而这里要发的信也最简单：纯文本、一个收件人、没有模板。
 */
async function sendViaResend(mail: OutboundMail, key: string): Promise<SendResult> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: senderAddress(),
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
      }),
      // 转发不该把收信这条路拖住 —— 收信是同步的，而它在等我们
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { id?: string } | null;
      return { ok: true, id: body?.id };
    }

    /*
     * 5xx 和 429 是**可重试的**，4xx 不是。
     *
     * 分清楚这件事要紧：把「地址不存在」当成可重试的话，
     * 我们会对着一个永远不存在的地址重试到天荒地老，
     * 而每一次重试在对方眼里都是一次投递尝试 —— 那正是垃圾发送者的形状。
     */
    const retryable = res.status >= 500 || res.status === 429;
    return { ok: false, error: `发信服务返回 ${res.status}`, retryable };
  } catch (error) {
    // 超时和网络错都算可重试 —— 它们说的是「现在不行」，不是「这封信不行」
    return { ok: false, error: error instanceof Error ? error.message : "发信失败", retryable: true };
  }
}
