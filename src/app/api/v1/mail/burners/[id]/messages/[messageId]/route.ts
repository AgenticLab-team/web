import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { readMessage } from "@/lib/mail/message";

export const dynamic = "force-dynamic";

/**
 * 读一封信的全文。
 *
 * ─────────────────────────────────────────
 * 它和列表那条的分工
 * ─────────────────────────────────────────
 *
 * 列表只给 `preview` 和抽好的验证码 —— 那是为了「轮询等码」这个
 * 用法：脚本每隔几秒拉一次，正文全带上会让每次轮询都拖着几十 KB。
 *
 * 而抽不出验证码的时候（`extractOtp` 宁可不抽也不猜），
 * 脚本得有办法把整封信拿出来自己看。这条就是那个办法。
 *
 * ⚠ 和网页那边共用 `readMessage`，所以**归属校验只有一份**：
 * 「这封信是不是你的」错一次的后果是别人的验证码。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  const auth = await authenticate(request, ["mail:burner"]);
  if (!auth.ok) return auth.response;

  const { id, messageId } = await params;

  const message = readMessage({ userId: auth.caller.user.id, messageId });

  /*
   * 「不是你的」「不存在」「不在这个箱子里」全部回同一个 404。
   *
   * 分开说的话，这条接口就成了一个探针：拿一串 id 挨个试，
   * 靠 403 和 404 的差别就能问出「这个 id 存不存在」。
   */
  if (!message || message.boxId !== id) {
    return apiError(404, "not_found", "没有这封信");
  }

  return NextResponse.json({
    id: message.id,
    box_id: message.boxId,
    to: message.toAddress,
    from: message.from,
    from_name: message.fromName,
    subject: message.subject,
    otp_code: message.otpCode,
    /** 纯文本正文。HTML 那一份不留存，见 lib/mail/message.ts */
    body_text: message.bodyText,
    attachments: message.attachments,
    received_at: message.receivedAt,
    /** 这次读**之前**的已读时间。null = 这是第一次打开 */
    read_at: message.readAt,
    size: message.size,
    auth: { spf: message.spf, dkim: message.dkim, dmarc: message.dmarc },
  });
}
