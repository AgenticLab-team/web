import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { mailBoxes, mailMessages } from "@/lib/db/schema";

/**
 * 读一封信。
 *
 * ═════════════════════════════════════════
 * 这条路以前根本不存在
 * ═════════════════════════════════════════
 *
 * 库里一直存着 `body_text`，而没有任何地方读它：列表只给
 * `preview` 和抽出来的验证码，`read_at` 那一列从来没人写过。
 *
 * 后果是**抽不出验证码的时候就没辙了** —— 而抽不出来恰恰是
 * 最需要看正文的情况（`extractOtp` 宁可不抽也不猜，见 otp.ts）。
 * 收到一封信、看得见主题、点不开，是这个功能最尴尬的形状。
 *
 * ─────────────────────────────────────────
 * 归属校验和标记已读必须在同一处
 * ─────────────────────────────────────────
 *
 * 「这封信是不是你的」和「把它标成已读」如果分成两步，
 * 中间那一刻就有一条路能标记别人的信为已读 ——
 * 本身危害不大，但它说明**校验没有覆盖到写**。
 * 所以这里一次查询带上 box 的主人，查不到就当作不存在。
 *
 * 「查不到」和「不是你的」返回同一个 null，不区分：
 * 区分开的话，这个接口就成了一个「这个 id 存不存在」的探针。
 */

export interface MailMessageDetail {
  id: string;
  boxId: string;
  /** 收件地址。同一个人可能同时开着好几个箱子，详情里要说清楚是哪个 */
  toAddress: string;
  from: string | null;
  fromName: string | null;
  subject: string | null;
  otpCode: string | null;
  /** 纯文本正文。HTML 那一份现在根本不落盘（见 ingest.ts），所以只有这个 */
  bodyText: string | null;
  attachments: { filename: string; mime?: string | null; size: number }[];
  receivedAt: number;
  /** 这次读之前的已读时间。null = 这是第一次打开 */
  readAt: number | null;
  size: number;
  /** 三项发件人校验。全 null = 网关没做校验，不是「没通过」 */
  spf: boolean | null;
  dkim: boolean | null;
  dmarc: boolean | null;
  spamScore: number | null;
}

/**
 * 取一封信的全文，顺手标记已读。
 *
 * `markRead: false` 给纯粹的预览用（比如管理员排查）——
 * 那种查看不该改变用户看到的未读数。
 */
export function readMessage(input: {
  userId: string;
  messageId: string;
  markRead?: boolean;
}): MailMessageDetail | null {
  const row = db
    .select({
      m: mailMessages,
      address: mailBoxes.address,
      ownerId: mailBoxes.userId,
    })
    .from(mailMessages)
    .innerJoin(mailBoxes, eq(mailBoxes.id, mailMessages.boxId))
    .where(and(eq(mailMessages.id, input.messageId), eq(mailBoxes.userId, input.userId)))
    .get();

  if (!row) return null;

  /*
   * 已经清掉正文的信不当作「存在」。
   *
   * `purged_at` 是保留期到了之后清正文留元信息的标记（见 settle.ts）。
   * 返回一封没有正文的信，用户看到的是一个空白页面，
   * 而空白页面最像「加载失败」—— 他会刷新，然后再看一次空白。
   */
  if (row.m.purgedAt) return null;

  const readAt = row.m.readAt;
  if (input.markRead !== false && readAt === null) {
    db.update(mailMessages)
      .set({ readAt: Date.now() })
      .where(eq(mailMessages.id, row.m.id))
      .run();
  }

  return {
    id: row.m.id,
    boxId: row.m.boxId,
    toAddress: row.address,
    from: row.m.fromAddr,
    fromName: row.m.fromName,
    subject: row.m.subject,
    otpCode: row.m.otpCode,
    bodyText: row.m.bodyText,
    attachments: (row.m.attachmentMeta as MailMessageDetail["attachments"] | null) ?? [],
    receivedAt: row.m.receivedAt,
    // 返回的是**这次打开之前**的值 —— 界面要靠它决定显不显示「新」
    readAt,
    size: row.m.size,
    spf: row.m.spfPass,
    dkim: row.m.dkimPass,
    dmarc: row.m.dmarcPass,
    spamScore: row.m.spamScore,
  };
}
