import "server-only";

import { and, count, eq, gt, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  mailBlocks,
  mailBoxes,
  mailDomains,
  mailEvents,
  mailIngressLog,
  mailMessages,
  users,
} from "@/lib/db/schema";

import { splitAddress } from "./address-rules";
import { mailConfig, retentionDaysFor } from "./config";
import { extractOtp } from "./otp";
import type { MailIngressVerdict } from "./kinds";

/**
 * 收信。网关把每一封投递过来，这里决定它落到哪个箱子、或者为什么不落。
 *
 * ═════════════════════════════════════════
 * 每一次判决都写 `mail_ingress_log`，包括拒掉的
 * ═════════════════════════════════════════
 *
 * 收信这件事最常见的支持请求是「我朋友说发了，我怎么没收到」。
 * 只记成功的投递，等于只记「没有问题的那些」—— 而那句话永远答不上来。
 */

export interface InboundMessage {
  /** 网关的协议版本，见 `protocol.ts`。老网关不发这个字段 */
  protocol?: number;
  /** 信封发件人（MAIL FROM）。这个骗不了，头里的 From 可以 */
  envelopeFrom: string;
  /** 信封收件人（RCPT TO），A 标签形态 */
  envelopeTo: string;
  rfcMessageId?: string | null;
  inReplyTo?: string | null;
  from?: string | null;
  fromName?: string | null;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  size: number;
  attachments?: { filename: string; mime?: string | null; size: number }[];
  spamScore?: number | null;
  spfPass?: boolean | null;
  dkimPass?: boolean | null;
  dmarcPass?: boolean | null;
  sourceIp?: string | null;
}

export interface IngestResult {
  verdict: MailIngressVerdict;
  reason: string;
  boxId?: string;
  messageId?: string;
}

export function ingestMessage(input: InboundMessage): IngestResult {
  const config = mailConfig();
  const to = input.envelopeTo.trim().toLowerCase();

  const record = (result: IngestResult): IngestResult => {
    db.insert(mailIngressLog)
      .values({
        envelopeFrom: input.envelopeFrom,
        envelopeTo: to,
        matchedBoxId: result.boxId ?? null,
        verdict: result.verdict,
        reason: result.reason,
        size: input.size,
        sourceIp: input.sourceIp ?? null,
      })
      .run();
    return result;
  };

  const parts = splitAddress(to);
  if (!parts) return record({ verdict: "rejected", reason: "收件人地址不成形" });

  if (input.size > config.messageMaxBytes) {
    return record({
      verdict: "rejected",
      reason: `超过单封上限 ${config.messageMaxBytes} 字节`,
    });
  }

  /*
   * 域名先查。
   *
   * 按 punycode 查，因为信封上永远是 A 标签 —— 按 U 标签查的话，
   * 中文域名的每一封信都会被判成「地址不存在」，而且不会有任何报错。
   */
  const domain = db
    .select()
    .from(mailDomains)
    .where(eq(mailDomains.punycode, parts.domain))
    .get();

  if (!domain || !domain.enabled) {
    return record({ verdict: "rejected", reason: "这个域名不在池子里" });
  }
  if (domain.kind === "blocked") {
    // 封禁的域名连 MX 都不该配，走到这里说明 DNS 那边有东西没清干净
    return record({ verdict: "rejected", reason: "这个域名被封禁，不开任何邮箱" });
  }
  /*
   * `admin` 的域名**照常往下走**。
   *
   * 它和 `blocked` 的区别就在这一句：MX 配着、信收得到，
   * 只是没有人能在上面开地址（除了管理员）。
   * 于是发到 `security@某商标.icu` 的每一次投递都会在下面被判成
   * 「这个地址不存在」并**留痕** —— 而那正是配 MX 换来的东西：
   * 看得见有人在试探。
   */

  const blocked = matchBlock(input.envelopeFrom, input.from ?? null, domain.domain);
  if (blocked) return record({ verdict: "rejected", reason: `发件人在黑名单里：${blocked}` });

  // 传 punycode：日志里的 envelope_to 永远是 A 标签形态
  if (overDomainCap(domain.punycode, config.domainPerHourReceiveCap)) {
    /*
     * 域名级的洪水。**丢而不是拒** —— 拒信会退回给发件人，
     * 而字典式扫描的「发件人」多半是伪造的，退信等于替攻击者
     * 往第三方邮箱轰炸。这条是被列黑名单最快的路。
     */
    return record({ verdict: "dropped", reason: "这个域名收信过快，已限流" });
  }

  const box = findBox(parts.local, domain);
  if (!box) return record({ verdict: "rejected", reason: "这个地址不存在" });

  if (box.status === "disabled" || box.status === "revoked" || box.status === "expired") {
    return record({ verdict: "rejected", reason: `这个地址已经${box.status === "expired" ? "到期" : "停用"}了` });
  }

  if (overBoxCap(box.id, config.boxPerHourReceiveCap)) {
    return record({ verdict: "dropped", reason: "这个箱子收信过快，已暂停", boxId: box.id });
  }

  const quota = box.quotaBytes ?? config.boxMaxBytes;
  if (box.usedBytes + input.size > quota) {
    /*
     * 配额满了 —— **拒收并让用户知道**，不静默丢。
     * 静默丢的结果是他以为对方没发，而对方以为发到了。
     */
    db.update(mailBoxes)
      .set({ status: "full", updatedAt: Date.now() })
      .where(eq(mailBoxes.id, box.id))
      .run();
    return record({ verdict: "rejected", reason: "这个箱子已经满了", boxId: box.id });
  }

  const level = db
    .select({ level: users.level })
    .from(users)
    .where(eq(users.id, box.userId))
    .get()?.level ?? 1;

  const otp = extractOtp({ subject: input.subject, bodyText: input.text });
  const now = Date.now();

  try {
    const message = db.transaction((tx) => {
      const row = tx
        .insert(mailMessages)
        .values({
          boxId: box.id,
          rfcMessageId: input.rfcMessageId ?? null,
          inReplyTo: input.inReplyTo ?? null,
          envelopeFrom: input.envelopeFrom,
          fromAddr: input.from ?? input.envelopeFrom,
          fromName: input.fromName ?? null,
          toAddr: to,
          subject: input.subject ?? null,
          bodyText: input.text ?? null,
          // HTML 落文件是 P1；先只存纯文本，宁可少存也不把库撑大
          bodyHtmlPath: null,
          size: input.size,
          hasAttachments: (input.attachments?.length ?? 0) > 0,
          attachmentMeta: input.attachments?.length ? input.attachments : null,
          spamScore: input.spamScore ?? null,
          spfPass: input.spfPass ?? null,
          dkimPass: input.dkimPass ?? null,
          dmarcPass: input.dmarcPass ?? null,
          otpCode: otp.code,
          receivedAt: now,
          expiresAt: now + retentionDaysFor(level, config) * 86400_000,
        })
        .returning()
        .get();

      tx.update(mailBoxes)
        .set({
          usedBytes: sql`${mailBoxes.usedBytes} + ${input.size}`,
          messageCount: sql`${mailBoxes.messageCount} + 1`,
          unreadCount: sql`${mailBoxes.unreadCount} + 1`,
          lastReceivedAt: now,
          updatedAt: now,
        })
        .where(eq(mailBoxes.id, box.id))
        .run();

      return row;
    });

    db.insert(mailEvents)
      .values({
        boxId: box.id,
        domain: domain.domain,
        event: "received",
        actorKind: "system",
        detail: { from: input.envelopeFrom, size: input.size, otp: Boolean(otp.code) },
      })
      .run();

    return record({ verdict: "accepted", reason: "收下了", boxId: box.id, messageId: message.id });
  } catch (error) {
    /*
     * 去重：网关超时重投同一封信。
     *
     * 唯一索引是 (box_id, rfc_message_id)，撞上说明这封已经在库里了 ——
     * 这不是错误，是**重投正常工作**。报成 accepted 让网关别再重试。
     */
    if (isUniqueViolation(error)) {
      return record({ verdict: "accepted", reason: "重复投递，已存在", boxId: box.id });
    }
    throw error;
  }
}

/**
 * 这个前缀落到哪个箱子。
 *
 * 两步：先找具名地址，找不到再看 catch-all。
 * 顺序不能反 —— 具名别名的存在意义就是**能单独静音、单独停用**，
 * 先撞 catch-all 的话那些设置全都不生效。
 */
function findBox(local: string, domain: typeof mailDomains.$inferSelect) {
  const exact = db
    .select()
    .from(mailBoxes)
    .where(
      and(
        eq(mailBoxes.address, `${local}@${domain.punycode}`),
        inArray(mailBoxes.status, ["active", "full", "grace", "disabled"]),
      ),
    )
    .get();
  if (exact) return exact;

  if (!domain.catchAll || !domain.ownerUserId) return null;

  /*
   * catch-all：落进这个域名主人的那个总箱。
   *
   * 找不到总箱时返回 null 而不是现建一个 —— 收信这条路上建箱
   * 意味着一次字典扫描能凭空造出几万个箱子。总箱在域名认领时建。
   */
  return db
    .select()
    .from(mailBoxes)
    .where(
      and(
        eq(mailBoxes.domain, domain.domain),
        eq(mailBoxes.userId, domain.ownerUserId),
        eq(mailBoxes.kind, "alias"),
        inArray(mailBoxes.status, ["active", "full"]),
      ),
    )
    .get();
}

function matchBlock(envelopeFrom: string, headerFrom: string | null, domain: string): string | null {
  const rules = db
    .select()
    .from(mailBlocks)
    .where(
      sql`${mailBlocks.scope} = 'global' OR (${mailBlocks.scope} = 'domain' AND ${mailBlocks.target} = ${domain})`,
    )
    .all();

  const sender = envelopeFrom.toLowerCase();
  const senderDomain = splitAddress(sender)?.domain ?? "";
  const header = headerFrom?.toLowerCase() ?? "";

  for (const rule of rules) {
    const pattern = rule.pattern.toLowerCase();
    if (rule.matchKind === "sender" && (sender === pattern || header === pattern)) return rule.pattern;
    if (rule.matchKind === "sender_domain" && senderDomain === pattern) return rule.pattern;
  }
  return null;
}

function overBoxCap(boxId: string, cap: number): boolean {
  const n =
    db
      .select({ n: count() })
      .from(mailMessages)
      .where(and(eq(mailMessages.boxId, boxId), gt(mailMessages.receivedAt, Date.now() - 3600_000)))
      .get()?.n ?? 0;
  return n >= cap;
}

function overDomainCap(punycode: string, cap: number): boolean {
  const n =
    db
      .select({ n: count() })
      .from(mailIngressLog)
      .where(
        and(
          eq(mailIngressLog.verdict, "accepted"),
          sql`${mailIngressLog.envelopeTo} LIKE ${"%@" + punycode}`,
          gt(mailIngressLog.createdAt, Date.now() - 3600_000),
        ),
      )
      .get()?.n ?? 0;
  return n >= cap;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code: unknown }).code).startsWith("SQLITE_CONSTRAINT")
  );
}
