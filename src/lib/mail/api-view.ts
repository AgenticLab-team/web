/**
 * 开放 API 的返回体形状。纯函数。
 *
 * 单独一个文件是为了让「API 到底返回什么」只有一处 ——
 * 三个路由各拼一遍的话，加一个字段就要记得改三处，
 * 而漏掉的那一处不会报错，只会让某个客户端拿不到新字段。
 *
 * 字段名用 snake_case：这一整套开放 API 都是（`created_at`），
 * 混着 camelCase 会让调用方每个字段都要猜一次。
 */

import type { BurnerMessageView, BurnerView } from "./burner";

export function burnerPayload(box: BurnerView) {
  return {
    id: box.id,
    /** 信封地址（punycode 形态）—— 拿去填注册框的就是这个 */
    address: box.address,
    /** 给人看的形态。中文域名下和 address 不同 */
    display_address: box.displayAddress,
    domain: box.domain,
    local_part: box.localPart,
    custom: box.custom,
    expires_at: box.expiresAt,
    message_count: box.messageCount,
    unread_count: box.unreadCount,
    created_at: box.createdAt,
  };
}

export function messagePayload(message: BurnerMessageView) {
  return {
    id: message.id,
    from: message.from,
    from_name: message.fromName,
    subject: message.subject,
    /**
     * ★ 直接给验证码。
     *
     * 调用方九成只要那六位数字 —— 让他们自己写正则去解 HTML 邮件
     * 是把我们已经做过一遍的事再让每个人做一遍，而且各做各的、各错各的。
     * 抽不出来时是 null，**不猜**。
     */
    otp_code: message.otpCode,
    preview: message.preview,
    received_at: message.receivedAt,
    read_at: message.readAt,
    has_attachments: message.hasAttachments,
  };
}
