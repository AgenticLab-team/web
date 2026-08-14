import "server-only";

import { and, count, eq, gt } from "drizzle-orm";

import { db } from "@/lib/db";
import { mailBoxes, mailDomains, mailEvents, users } from "@/lib/db/schema";
import { levelOf } from "@/lib/points/rules";

import { canForward, forwardEnvelope, explainForwardRefusal } from "./forward-rules";
import { sendMail, senderAddress, senderConfigured } from "./sender";

/**
 * 把一封刚收到的信转给主人的私人邮箱。
 *
 * ═════════════════════════════════════════
 * 它**不能拖住收信**
 * ═════════════════════════════════════════
 *
 * 收信是同步的：网关在等我们的 HTTP 响应，而它那头连着一个
 * 正在等 250 的发信服务器。转发要调一次外部 HTTPS 接口，
 * 慢的时候几秒 —— 把它塞进收信的返回路径上，
 * 结果是**发信方那边超时重投**，而我们这边每一次重投都要再转一次。
 *
 * 所以这个函数是 fire-and-forget：调用方不 await 它，
 * 它自己吞掉所有异常，只往 `mail_events` 里记一行。
 *
 * 「转发失败了没人知道」是这个选择的代价 —— 用事件表换的，
 * 而那比「收信整条链路被一个第三方接口拖垮」便宜得多。
 */
export function forwardMessage(input: {
  boxId: string;
  from: string | null;
  fromName: string | null;
  subject: string | null;
  bodyText: string | null;
}): void {
  // 没配发信就什么都不做 —— 界面上那个开关本来也不该出现
  if (!senderConfigured()) return;

  void (async () => {
    try {
      const box = db
        .select({
          id: mailBoxes.id,
          userId: mailBoxes.userId,
          address: mailBoxes.address,
          localPart: mailBoxes.localPart,
          domain: mailBoxes.domain,
          forwardEnabled: mailBoxes.forwardEnabled,
        })
        .from(mailBoxes)
        .where(eq(mailBoxes.id, input.boxId))
        .get();

      if (!box || !box.forwardEnabled) return;

      const user = db
        .select({
          email: users.email,
          verifiedAt: users.emailVerifiedAt,
          earned: users.pointsTotal,
        })
        .from(users)
        .where(eq(users.id, box.userId))
        .get();
      if (!user) return;

      /*
       * 一小时内转过几封。
       *
       * 数的是**事件**而不是信：转发失败的那几次也该算 ——
       * 被当成靶子时，失败的尝试和成功的一样在消耗我们的信誉。
       */
      const sentLastHour =
        db
          .select({ n: count() })
          .from(mailEvents)
          .where(
            and(
              eq(mailEvents.actorId, box.userId),
              eq(mailEvents.event, "forwarded"),
              gt(mailEvents.createdAt, Date.now() - 3600_000),
            ),
          )
          .get()?.n ?? 0;

      // 我们自己的域名 —— 转过去会绕回来再转一次
      const ourDomains = db
        .select({ punycode: mailDomains.punycode })
        .from(mailDomains)
        .all()
        .map((d) => d.punycode);

      const refusal = canForward({
        level: levelOf(user.earned).level,
        target: user.email,
        targetVerified: Boolean(user.verifiedAt),
        ourDomains,
        sentLastHour,
      });

      if (refusal) {
        db.insert(mailEvents)
          .values({
            boxId: box.id,
            domain: box.domain,
            event: "forward_skipped",
            actorId: box.userId,
            actorKind: "system",
            detail: { why: explainForwardRefusal(refusal), code: refusal.code },
          })
          .run();
        return;
      }

      const envelope = forwardEnvelope({
        originalFrom: input.from,
        originalFromName: input.fromName,
        toAddress: `${box.localPart}@${box.domain}`,
        subject: input.subject,
        bodyText: input.bodyText,
        mailFrom: senderAddress(),
      });

      const result = await sendMail({
        to: user.email!,
        subject: envelope.subject,
        text: envelope.text,
        replyTo: envelope.replyTo,
      });

      db.insert(mailEvents)
        .values({
          boxId: box.id,
          domain: box.domain,
          event: result.ok ? "forwarded" : "forward_failed",
          actorId: box.userId,
          actorKind: "system",
          /*
           * ⚠️ **不记转发到哪个地址**。
           *
           * 事件表是后台看得到的，而「某某的私人邮箱是什么」
           * 不是管理员该顺便知道的东西。记 ok / 为什么失败就够了。
           */
          detail: result.ok ? { id: result.id } : { error: result.error, retryable: result.retryable },
        })
        .run();
    } catch {
      /*
       * 吞掉。
       *
       * 这个函数跑在收信的返回路径**之外**，抛出去没有人接 ——
       * 在 Node 里那是一个 unhandledRejection，而它会把整个进程带下去。
       * 一封转发失败不该让站挂掉。
       */
    }
  })();
}
