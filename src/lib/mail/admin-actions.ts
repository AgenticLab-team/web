"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { mailBanwords, mailBoxes, mailDomains, mailEvents } from "@/lib/db/schema";
import { notify } from "@/lib/forum/notify";

import { checkLocalPart } from "./address-rules";
import { openBurner } from "./burner";
import { isPunycodeSane, toPunycode } from "./domain-catalog";
import { MAIL_BANWORD_KINDS, MAIL_DOMAIN_KINDS, MAIL_DOMAIN_TIERS } from "./kinds";
import type { MailBanwordKind, MailDomainKind, MailDomainTier } from "./kinds";

/**
 * 邮箱后台的写操作。
 *
 * 每一个都齐三件套（ARCHITECTURE.md 四节）：
 *   `requireWritableAdmin` —— **不是** requireAdmin，后者不挡预览态，
 *      用错的后果是管理员以别人的身份写了数据，而审计记在被预览的人头上
 *   `audit(...)` —— 一个都不能漏
 *   权限点在 rbac/permissions.ts 注册且分了级
 *
 * 站长的「任意」（绕过长度、禁用词、池归属、任意到期时间）也走这里，
 * 因为**留痕这一条没有例外**。
 */

export interface MailAdminResult {
  ok: boolean;
  error?: string;
  note?: string;
}

const fail = (error: string): MailAdminResult => ({ ok: false, error });

/**
 * 批量导入域名。
 *
 * 一行一个，可以带 `域名,类别,档位` —— 域名会一直加，
 * 所以这必须是一个**能反复跑**的入口，不是一次性脚本。
 */
export async function importDomains(input: {
  text: string;
  defaultKind: MailDomainKind;
}): Promise<MailAdminResult> {
  const ctx = await requireWritableAdmin("mail.domain.write");

  const lines = input.text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  if (lines.length === 0) return fail("没有可导入的行");
  if (lines.length > 500) return fail("一次最多 500 行");

  const added: string[] = [];
  const skipped: string[] = [];
  const bad: string[] = [];

  for (const line of lines) {
    const [rawDomain, rawKind, rawTier] = line.split(",").map((s) => s?.trim());
    const domain = rawDomain?.toLowerCase();
    if (!domain || !domain.includes(".")) {
      bad.push(line);
      continue;
    }

    const punycode = toPunycode(domain);
    /*
     * 转不出合法 A 标签的**不写进去**。
     *
     * 写进去的表现是「这个域名收不到信」而没有任何报错 ——
     * 信封上是 A 标签，跟库里对不上，网关那侧直接拒，
     * 而拒的原因永远传不到我们眼前。
     */
    if (!isPunycodeSane(domain, punycode)) {
      bad.push(`${domain}（punycode 转换失败）`);
      continue;
    }

    const exists = db.select().from(mailDomains).where(eq(mailDomains.domain, domain)).get();
    if (exists) {
      skipped.push(domain);
      continue;
    }

    const kind = (MAIL_DOMAIN_KINDS as readonly string[]).includes(rawKind ?? "")
      ? (rawKind as MailDomainKind)
      : input.defaultKind;
    const tier = (MAIL_DOMAIN_TIERS as readonly string[]).includes(rawTier ?? "")
      ? (rawTier as MailDomainTier)
      : null;

    db.insert(mailDomains)
      .values({
        domain,
        punycode,
        kind,
        tier: kind === "reserved" ? tier : null,
        // 新导入的一律 pending：MX 还没配，DNS 体检跑过一轮才转 active
        status: "pending",
        allowBurner: kind === "temp",
        allowClaim: kind === "temp" || kind === "reserved" || kind === "owned",
        allowCustomLocal: kind !== "blocked",
        inRandomRotation: kind === "temp" && /^[a-z0-9.-]+$/.test(domain),
        catchAll: kind === "owned",
        createdBy: ctx.user.id,
      })
      .run();
    added.push(domain);
  }

  audit({ actorId: ctx.user.id }, {
    action: "mail.domain.write",
    targetType: "mail_domain",
    targetId: "bulk",
    targetLabel: `导入 ${added.length} 个域名`,
    after: { added, skipped, bad },
  });

  revalidatePath("/admin/mail");
  return {
    ok: true,
    note: `新增 ${added.length} 个${skipped.length ? `，${skipped.length} 个已存在` : ""}${
      bad.length ? `，${bad.length} 行没认出来：${bad.slice(0, 3).join("、")}` : ""
    }`,
  };
}

/** 改一个域名：类别、档位、归属、到期日、开关 */
export async function updateDomain(input: {
  domain: string;
  kind?: MailDomainKind;
  tier?: MailDomainTier | null;
  ownerUserId?: string | null;
  domainExpiresAt?: number | null;
  allowBurner?: boolean;
  allowClaim?: boolean;
  allowCustomLocal?: boolean;
  inRandomRotation?: boolean;
  catchAll?: boolean;
  enabled?: boolean;
  note?: string | null;
}): Promise<MailAdminResult> {
  const ctx = await requireWritableAdmin("mail.domain.write");

  const before = db.select().from(mailDomains).where(eq(mailDomains.domain, input.domain)).get();
  if (!before) return fail("没有这个域名");

  const patch: Partial<typeof mailDomains.$inferInsert> = { updatedAt: Date.now() };
  if (input.kind) {
    patch.kind = input.kind;
    /*
     * ★ 改成靓号池时强制关掉一次性箱。
     *
     * 这是靓号唯一真正卖的东西：你花 400 分买的地址，
     * 不会因为别人在同一个域名上注册了一百个账号而被某个网站拒收。
     * 靠管理员记得手动关掉那个开关的话，迟早有一次会忘。
     */
    if (input.kind === "reserved") patch.allowBurner = false;
    if (input.kind === "blocked") {
      patch.allowBurner = false;
      patch.allowClaim = false;
      patch.catchAll = false;
      patch.inRandomRotation = false;
    }
    if (input.kind !== "reserved") patch.tier = null;
  }
  if (input.tier !== undefined && (input.kind ?? before.kind) === "reserved") patch.tier = input.tier;
  if (input.ownerUserId !== undefined) patch.ownerUserId = input.ownerUserId;
  if (input.domainExpiresAt !== undefined) {
    patch.domainExpiresAt = input.domainExpiresAt;
    // 到期日改了就把告警档位清空，让新的日期重新走一遍 30/14/7
    patch.expiryNoticeStage = null;
  }
  if (input.allowBurner !== undefined && patch.allowBurner === undefined) {
    patch.allowBurner = input.allowBurner;
  }
  if (input.allowClaim !== undefined && patch.allowClaim === undefined) patch.allowClaim = input.allowClaim;
  if (input.allowCustomLocal !== undefined) patch.allowCustomLocal = input.allowCustomLocal;
  if (input.inRandomRotation !== undefined && patch.inRandomRotation === undefined) {
    patch.inRandomRotation = input.inRandomRotation;
  }
  if (input.catchAll !== undefined && patch.catchAll === undefined) patch.catchAll = input.catchAll;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.note !== undefined) patch.note = input.note;

  db.update(mailDomains).set(patch).where(eq(mailDomains.domain, input.domain)).run();

  db.insert(mailEvents)
    .values({
      domain: input.domain,
      event: "domain_updated",
      actorId: ctx.user.id,
      actorKind: "admin",
      detail: patch,
    })
    .run();

  audit({ actorId: ctx.user.id }, {
    action: "mail.domain.write",
    targetType: "mail_domain",
    targetId: input.domain,
    targetLabel: input.domain,
    before,
    after: patch,
  });

  revalidatePath("/admin/mail");
  return { ok: true };
}

/**
 * 收回一个地址。
 *
 * **理由必填，而且会发给当事人。**
 * 「我的邮箱怎么没了」这个问题一定会被问到，
 * 而那时唯一能给出去的答复就是这里填的这句话。
 */
export async function revokeBox(input: { id: string; reason: string }): Promise<MailAdminResult> {
  const ctx = await requireWritableAdmin("mail.box.write");

  const reason = input.reason.trim();
  if (reason.length < 4) return fail("要填收回的理由 —— 它会原样发给对方");

  const box = db.select().from(mailBoxes).where(eq(mailBoxes.id, input.id)).get();
  if (!box) return fail("没有这个地址");

  db.update(mailBoxes)
    .set({ status: "revoked", updatedAt: Date.now() })
    .where(eq(mailBoxes.id, input.id))
    .run();

  db.insert(mailEvents)
    .values({
      boxId: box.id,
      domain: box.domain,
      event: "revoked_by_admin",
      actorId: ctx.user.id,
      actorKind: "admin",
      detail: { reason },
    })
    .run();

  notify({
    userId: box.userId,
    type: "system",
    groupKey: `mail:revoked:${box.id}`,
    title: `邮箱地址 ${box.localPart}@${box.domain} 已被收回`,
    body: reason,
    link: "/mail/boxes",
  });

  audit({ actorId: ctx.user.id }, {
    action: "mail.box.write",
    targetType: "mail_box",
    targetId: box.id,
    targetLabel: `${box.localPart}@${box.domain}`,
    before: box,
    after: { status: "revoked" },
    reason,
  });

  revalidatePath("/admin/mail");
  return { ok: true, note: "已收回并通知对方" };
}

/**
 * 改到期时间 —— 站长可以填**任意**时间，包括永不过期。
 *
 * 传 null 表示永不过期。这一条没有上限校验，因为它就是站长要的
 * 「任意认领时间」；代价是每一次都留痕。
 */
export async function setBoxExpiry(input: {
  id: string;
  expiresAt: number | null;
}): Promise<MailAdminResult> {
  const ctx = await requireWritableAdmin("mail.box.write");

  const box = db.select().from(mailBoxes).where(eq(mailBoxes.id, input.id)).get();
  if (!box) return fail("没有这个地址");

  db.update(mailBoxes)
    .set({
      expiresAt: input.expiresAt,
      // 手动延期意味着它不再是过期状态
      status: box.status === "expired" || box.status === "grace" ? "active" : box.status,
      updatedAt: Date.now(),
    })
    .where(eq(mailBoxes.id, input.id))
    .run();

  audit({ actorId: ctx.user.id }, {
    action: "mail.box.write",
    targetType: "mail_box",
    targetId: box.id,
    targetLabel: `${box.localPart}@${box.domain}`,
    before: { expiresAt: box.expiresAt },
    after: { expiresAt: input.expiresAt },
  });

  revalidatePath("/admin/mail");
  return { ok: true };
}

/** 转移归属 —— 把一个地址从一个人手里转给另一个人 */
export async function transferBox(input: {
  id: string;
  toUserId: string;
  reason: string;
}): Promise<MailAdminResult> {
  const ctx = await requireWritableAdmin("mail.box.write");

  const box = db.select().from(mailBoxes).where(eq(mailBoxes.id, input.id)).get();
  if (!box) return fail("没有这个地址");
  if (box.userId === input.toUserId) return fail("它已经是这个人的了");

  db.update(mailBoxes)
    .set({ userId: input.toUserId, updatedAt: Date.now() })
    .where(eq(mailBoxes.id, input.id))
    .run();

  /*
   * 两边都通知。
   *
   * 只通知接收方的话，原主会发现自己的地址凭空消失了 ——
   * 而那正是最容易被当成 bug 来报的一种变化。
   */
  for (const [userId, title] of [
    [box.userId, `邮箱地址 ${box.localPart}@${box.domain} 已转给别人`],
    [input.toUserId, `你收到了一个邮箱地址：${box.localPart}@${box.domain}`],
  ] as const) {
    notify({
      userId,
      type: "system",
      groupKey: `mail:transfer:${box.id}:${userId}`,
      title,
      body: input.reason,
      link: "/mail/boxes",
    });
  }

  audit({ actorId: ctx.user.id }, {
    action: "mail.box.write",
    targetType: "mail_box",
    targetId: box.id,
    targetLabel: `${box.localPart}@${box.domain}`,
    before: { userId: box.userId },
    after: { userId: input.toUserId },
    reason: input.reason,
  });

  revalidatePath("/admin/mail");
  return { ok: true };
}

/**
 * 管理员在**任意**域名上开一个地址，给任意人。
 *
 * ═════════════════════════════════════════
 * 这是「管理员可以使用」那句话的落点
 * ═════════════════════════════════════════
 *
 * `admin` 那一类域名（商标近似的那 11 个）不进任何池子，
 * 普通成员一个地址都开不出来 —— 而这条路是它们唯一能被用上的入口。
 *
 * 走 `bypassLimits`：绕过最短长度、禁用词、`allowBurner` / `allowCustomLocal`
 * 和池归属。**权限判定只在这一行**（`mail.box.write`），
 * 下面那一层只认结果不再判一次 —— 判定有两处的话，
 * 松的那一处就是漏的口。
 *
 * 代价是每一次都进 audit 和 `mail_events`，actor 记站长本人。
 */
export async function openBoxForUser(input: {
  domain: string;
  localPart: string;
  /** 开给谁。不填就是开给自己 */
  userId?: string;
  reason: string;
}): Promise<MailAdminResult> {
  const ctx = await requireWritableAdmin("mail.box.write");

  const reason = input.reason.trim();
  if (reason.length < 4) return fail("要填理由 —— 这是一次越权操作，得说清楚为什么");

  const domain = db.select().from(mailDomains).where(eq(mailDomains.domain, input.domain)).get();
  if (!domain) return fail("没有这个域名");
  if (domain.kind === "blocked") {
    /*
     * `blocked` 是唯一一条**连管理员也绕不过**的。
     *
     * 它的定义就是「连 MX 都不配」—— 在上面开地址等于开了一个
     * 永远收不到信的地址，而那比开不出来更让人困惑。
     * 真要用就先把它改成 `admin`（那一步也留痕）。
     */
    return fail(`${input.domain} 是封禁域名，连 MX 都没配 —— 要用先把它改成「管理员专用」`);
  }

  const target = input.userId ?? ctx.user.id;

  const result = openBurner({
    userId: target,
    domain: input.domain,
    localPart: input.localPart,
    bypassLimits: true,
  });

  if (!result.ok) return fail(result.error);

  db.insert(mailEvents)
    .values({
      boxId: result.box.id,
      domain: input.domain,
      event: "opened_by_admin",
      actorId: ctx.user.id,
      actorKind: "admin",
      detail: { forUser: target, address: result.box.address, reason },
    })
    .run();

  audit({ actorId: ctx.user.id }, {
    action: "mail.box.write",
    targetType: "mail_box",
    targetId: result.box.id,
    targetLabel: result.box.displayAddress,
    after: { forUser: target, domain: input.domain, bypass: true },
    reason,
  });

  revalidatePath("/admin/mail");
  return { ok: true, note: `开好了：${result.box.displayAddress}` };
}

/** 加一条禁用词 */
export async function addBanword(input: {
  word: string;
  kind: MailBanwordKind;
  reason?: string;
}): Promise<MailAdminResult> {
  const ctx = await requireWritableAdmin("mail.banword");

  const word = input.word.trim().toLowerCase();
  if (!word) return fail("词不能为空");
  if (!(MAIL_BANWORD_KINDS as readonly string[]).includes(input.kind)) return fail("匹配方式不对");

  /*
   * 正则先编译一次再存。
   *
   * 写坏的正则在判定那一层是「当没命中」（不能让一条坏规则
   * 把所有人开箱的路堵死），也就是说它**不会报错，只会静默失效** ——
   * 所以拦截必须发生在存进去的这一刻。
   */
  if (input.kind === "regex") {
    try {
      new RegExp(input.word);
    } catch (error) {
      return fail(`正则写坏了：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const exists = db.select().from(mailBanwords).where(eq(mailBanwords.word, word)).get();
  if (exists && exists.kind === input.kind) return fail("这条已经有了");

  db.insert(mailBanwords)
    .values({ word, kind: input.kind, reason: input.reason ?? null, createdBy: ctx.user.id })
    .run();

  audit({ actorId: ctx.user.id }, {
    action: "mail.banword",
    targetType: "mail_banword",
    targetId: word,
    targetLabel: `${input.kind}:${word}`,
    after: { word, kind: input.kind, reason: input.reason },
  });

  revalidatePath("/admin/mail");
  return { ok: true };
}

/** 删一条禁用词。内置的那两条删不掉 */
export async function removeBanword(input: { id: string }): Promise<MailAdminResult> {
  const ctx = await requireWritableAdmin("mail.banword");

  const row = db.select().from(mailBanwords).where(eq(mailBanwords.id, input.id)).get();
  if (!row) return fail("没有这一条");
  if (row.builtin) {
    /*
     * postmaster / abuse 删不掉。
     *
     * RFC 5321 要求域名能收 postmaster；abuse 是收
     * 「你们家域名在发垃圾邮件」这种投诉的唯一通道。
     * 发给用户的话，我们会在完全不知情的情况下被投诉、被拉黑。
     */
    return fail(`${row.word} 是系统保留的 —— 投诉和退信要走这个地址，发给用户的话我们会不知不觉被拉黑`);
  }

  db.delete(mailBanwords).where(eq(mailBanwords.id, input.id)).run();

  audit({ actorId: ctx.user.id }, {
    action: "mail.banword",
    targetType: "mail_banword",
    targetId: row.word,
    targetLabel: `${row.kind}:${row.word}`,
    before: row,
  });

  revalidatePath("/admin/mail");
  return { ok: true };
}

/**
 * 试一个前缀会不会被挡。
 *
 * 后台加完词之后最想做的事就是「那 xxx 现在还能用吗」，
 * 而没有这个的话只能去开一个真箱子来试。
 */
export async function testLocalPart(input: { local: string }): Promise<MailAdminResult> {
  await requireWritableAdmin("mail.banword");

  const banwords = db.select().from(mailBanwords).where(eq(mailBanwords.enabled, true)).all();
  const verdict = checkLocalPart(input.local, { purpose: "claim", banwords });

  return verdict.ok
    ? { ok: true, note: `${verdict.local} 可以用` }
    : { ok: true, note: `挡下了：${verdict.error}` };
}
