import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { mailAttachments, mailBoxes, mailMessages } from "@/lib/db/schema";

/**
 * 取一个附件的内容。
 *
 * ═════════════════════════════════════════
 * 归属校验和读信是**同一条口径**
 * ═════════════════════════════════════════
 *
 * 一次查询串起 附件 → 信 → 箱子 → 主人，查不到就当作不存在 ——
 * 和 `readMessage` 完全一样。
 *
 * 各写一遍的话，漏判的方向永远是「把别人的附件给出去」，
 * 而附件比正文更糟：正文里的验证码几分钟就失效了，
 * 而一个附件可能是一份合同、一张身份证照片。
 *
 * 「不是你的」「不存在」「没存下来」三种都返回 null，不区分 ——
 * 区分开的话，拿一串 id 挨个试就能问出「这个附件存不存在」。
 */

export interface StoredAttachment {
  filename: string;
  mime: string | null;
  size: number;
  content: Buffer;
}

export function readAttachment(input: {
  userId: string;
  attachmentId: string;
}): StoredAttachment | null {
  const row = db
    .select({
      filename: mailAttachments.filename,
      mime: mailAttachments.mime,
      size: mailAttachments.size,
      stored: mailAttachments.stored,
      content: mailAttachments.content,
    })
    .from(mailAttachments)
    .innerJoin(mailMessages, eq(mailMessages.id, mailAttachments.messageId))
    .innerJoin(mailBoxes, eq(mailBoxes.id, mailMessages.boxId))
    .where(and(eq(mailAttachments.id, input.attachmentId), eq(mailBoxes.userId, input.userId)))
    .get();

  if (!row || !row.stored || !row.content) return null;

  return {
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    content: Buffer.from(row.content as Buffer),
  };
}
