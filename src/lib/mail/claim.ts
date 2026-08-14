import "server-only";

import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { mailBoxes, mailDomains, mailEvents, mailSlots, users } from "@/lib/db/schema";
import { grantPoints } from "@/lib/points/ledger";
import { levelOf } from "@/lib/points/rules";

import { buildAddress, checkLocalPart, MAIL_BANWORD_KINDS } from "./address-rules";
import { listBanwords } from "./admin-queries";
import { mailConfig } from "./config";
import type { MailDomainTier } from "./kinds";
import {
  canClaim,
  explainRefusal,
  renewedExpiry,
  RENT_DAYS,
  slotsFor,
  TIER_RENT,
} from "./slot-rules";

/**
 * 申领一个长期地址。
 *
 * ═════════════════════════════════════════
 * 这条路和「自有域名开别名」是两件事
 * ═════════════════════════════════════════
 *
 * 自有域名那条只有一个判据（域名是不是你的），因为域名是他买的。
 * 而公共池上的好地址是**稀缺的**：它要过三道闸（等级、槽位、年租），
 * 而三道闸各自防的东西不同 ——
 *
 *   等级  防「新号扫光靓号池」
 *   槽位  防「一个人囤一堆」
 *   年租  防「买完就再也不用，而地址永远占着」
 *
 * 少任何一道，剩下两道都拦不住那件事。
 *
 * ─────────────────────────────────────────
 * `mail_slots` 的行才是真值
 * ─────────────────────────────────────────
 *
 * 用户身上的计数是缓存，后台能重算比对（和活动名额、积分余额
 * 同一个办法，见 `SCHEMA.md` 零节）。名额算错在这种东西上是事故。
 */

export type ClaimResult =
  | { ok: true; address: string; boxId: string; expiresAt: number; paid: number }
  | { ok: false; error: string };

/** 这个人的槽位账：应该有几个、已经占了几个 */
export function slotStatus(userId: string): { total: number; used: number } {
  /*
   * ⚠️ 两列，两个意思，**不能混**：
   *
   *   `points`        可花的余额 —— 花掉会减
   *   `points_total`  累计赚到的 —— **等级按它算**，花掉不减
   *
   * 等级用余额算的话，一个人买了个 S 档地址会当场掉级，
   * 然后他连自己刚买的那一档都申领不了第二个。
   */
  const user = db
    .select({ balance: users.points, earned: users.pointsTotal })
    .from(users)
    .where(eq(users.id, userId))
    .get();

  const purchased =
    db
      .select({ n: count() })
      .from(mailSlots)
      .where(and(eq(mailSlots.userId, userId), isNull(mailSlots.revokedAt)))
      .get()?.n ?? 0;

  const level = levelOf(user?.earned ?? 0).level;

  /*
   * 已占用 = 活着的长期箱。
   *
   * 一次性箱**不占槽位** —— 那是它和长期箱最根本的差别
   * （见 `kinds.ts`）。把它算进来的话，一个人开三个一次性箱
   * 就会发现自己申领不了，而那两件事之间没有任何关系。
   */
  const used =
    db
      .select({ n: count() })
      .from(mailBoxes)
      .where(
        and(
          eq(mailBoxes.userId, userId),
          eq(mailBoxes.kind, "temp"),
          inArray(mailBoxes.status, ["active", "full", "grace"]),
        ),
      )
      .get()?.n ?? 0;

  return { total: slotsFor(level, purchased), used };
}

export function claimAddress(input: {
  userId: string;
  domain: string;
  localPart: string;
  now?: number;
}): ClaimResult {
  const now = input.now ?? Date.now();

  const domainRow = db
    .select()
    .from(mailDomains)
    .where(eq(mailDomains.domain, input.domain))
    .get();

  if (!domainRow) return { ok: false, error: "没有这个域名" };
  if (!domainRow.enabled || domainRow.status !== "active") {
    return { ok: false, error: "这个域名现在不开放申领" };
  }
  if (!domainRow.allowClaim) return { ok: false, error: "这个域名不接受申领" };

  const tier = (domainRow.tier ?? "b") as MailDomainTier;

  // 同上：等级看累计，付得起看余额
  const user = db
    .select({ balance: users.points, earned: users.pointsTotal })
    .from(users)
    .where(eq(users.id, input.userId))
    .get();
  if (!user) return { ok: false, error: "没有这个人" };

  const slots = slotStatus(input.userId);
  const refusal = canClaim({
    tier,
    level: levelOf(user.earned).level,
    slotsTotal: slots.total,
    slotsUsed: slots.used,
    points: user.balance,
  });
  if (refusal) return { ok: false, error: explainRefusal(refusal) };

  const verdict = checkLocalPart(input.localPart, {
    purpose: "claim",
    banwords: listBanwords().map((b) => ({
      word: b.word,
      kind: b.kind as (typeof MAIL_BANWORD_KINDS)[number],
    })),
  });
  if (!verdict.ok) return { ok: false, error: verdict.error ?? "这个前缀不行" };

  const address = buildAddress(verdict.local, domainRow.punycode);
  const taken = db
    .select({ id: mailBoxes.id })
    .from(mailBoxes)
    .where(eq(mailBoxes.address, address))
    .get();
  if (taken) return { ok: false, error: "这个地址已经有人了" };

  const rent = TIER_RENT[tier];

  /*
   * ⚠️ **先扣分，再建箱。**
   *
   * 反过来的话，扣分失败时地址已经开出去了 —— 而地址是唯一命名的，
   * 回滚意味着把一个已经显示给用户看过的地址收回去。
   *
   * 扣了分而建箱失败要好办得多：下面 catch 里冲正那一笔，
   * 而积分是可加减的东西，冲正之后账面上什么都没发生。
   *
   * ─────────────────────────────────────────
   * 幂等键里要带**时间窗**，不能只有地址
   * ─────────────────────────────────────────
   *
   * 它防的是**重复提交**：同一个人对同一个地址点两下，
   * 第二次拿到 `duplicate` 而不是再扣一次。
   *
   * 而只写 `用户:地址` 的话，它顺带变成了「这个人对这个地址
   * **一辈子只扣一次**」—— 于是长期箱到期放回池子、他再申领一次，
   * 那一次是**免费的**。年租是这套东西里唯一的周期性回收口
   * （`ECONOMY.md`），一个能被这样绕过的回收口等于没有。
   *
   * 所以键里带上天。同一天内的重复提交照样拦得住，
   * 而隔了一个租期之后的重新申领会照价收费。
   */
  const paid = grantPoints({
    userId: input.userId,
    delta: -rent,
    reason: `申领长期地址 ${verdict.local}@${domainRow.domain}（${tier.toUpperCase()} 档年租）`,
    ruleKey: "mail.claim",
    refType: "mail_address",
    refId: address,
    idempotencyKey: `mail.claim:${input.userId}:${address}:${Math.floor(now / 86_400_000)}`,
  });
  if (!paid.ok) return { ok: false, error: paid.error ?? "扣分没成功" };

  const expiresAt = now + RENT_DAYS * 86_400_000;

  try {
    const box = db
      .insert(mailBoxes)
      .values({
        userId: input.userId,
        localPart: verdict.local,
        domain: domainRow.domain,
        address,
        kind: "temp",
        custom: true,
        expiresAt,
        quotaBytes: mailConfig().boxMaxBytes,
        // 长期地址不静音 —— 和自有域名别名同一条口径
        muted: false,
        status: "active",
      })
      .returning()
      .get();

    db.insert(mailEvents)
      .values({
        boxId: box.id,
        domain: domainRow.domain,
        event: "claimed",
        actorId: input.userId,
        actorKind: "user",
        detail: { address, tier, rent, expiresAt },
      })
      .run();

    return {
      ok: true,
      address: `${verdict.local}@${domainRow.domain}`,
      boxId: box.id,
      expiresAt,
      paid: rent,
    };
  } catch {
    /*
     * 建箱失败就把那一笔退回去。
     *
     * 不退的话，用户看到的是「申领失败」+ 少了 400 分 ——
     * 而那是这套东西里最容易让人失去信任的一种失败。
     */
    if (paid.ledgerId) {
      grantPoints({
        userId: input.userId,
        delta: rent,
        reason: `申领失败，退还年租（${address}）`,
        ruleKey: "mail.claim.refund",
        refType: "mail_address",
        refId: address,
        idempotencyKey: `mail.claim.refund:${input.userId}:${address}:${Math.floor(now / 86_400_000)}`,
      });
    }
    return { ok: false, error: "开不出来，年租已经退回" };
  }
}

/**
 * 续一年。
 *
 * ═════════════════════════════════════════
 * 从**原到期日**顺延，不是从今天
 * ═════════════════════════════════════════
 *
 * 从今天算的话是在惩罚提前付钱的人：早交一天就少一天。
 * 已经过期（在宽限期里）的从今天算 —— 那段时间它本来就没在服务。
 * 这条判断在 `slot-rules.ts` 里（`renewedExpiry`），因为它是纯算术，
 * 而纯算术要能被单独测。
 *
 * ─────────────────────────────────────────
 * 续期不查等级，也不查槽位
 * ─────────────────────────────────────────
 *
 * 那两道闸防的是「拿到新地址」。而这个地址**已经是他的了** ——
 * 因为掉了一级就续不了费、然后地址被别人抢走，
 * 是这套规则能造出的最糟的一种结果。
 *
 * 只查两件事：这箱子是不是他的、分够不够。
 */
export function renewClaim(input: {
  userId: string;
  boxId: string;
  now?: number;
}): { ok: true; expiresAt: number; paid: number } | { ok: false; error: string } {
  const now = input.now ?? Date.now();

  const box = db
    .select({
      id: mailBoxes.id,
      userId: mailBoxes.userId,
      kind: mailBoxes.kind,
      domain: mailBoxes.domain,
      localPart: mailBoxes.localPart,
      expiresAt: mailBoxes.expiresAt,
      status: mailBoxes.status,
    })
    .from(mailBoxes)
    .where(eq(mailBoxes.id, input.boxId))
    .get();

  // 「不是你的」和「不存在」同一句话 —— 否则它是个存在性探针
  if (!box || box.userId !== input.userId) return { ok: false, error: "没有这个地址" };
  if (box.kind !== "temp") return { ok: false, error: "这个地址不用续期" };

  const domainRow = db
    .select({ tier: mailDomains.tier })
    .from(mailDomains)
    .where(eq(mailDomains.domain, box.domain))
    .get();
  const tier = (domainRow?.tier ?? "b") as MailDomainTier;
  const rent = TIER_RENT[tier];

  const user = db
    .select({ balance: users.points })
    .from(users)
    .where(eq(users.id, input.userId))
    .get();
  if (!user) return { ok: false, error: "没有这个人" };
  if (user.balance < rent) {
    return { ok: false, error: `续一年要 ${rent} 分，你有 ${user.balance} 分 —— 还差 ${rent - user.balance}` };
  }

  const expiresAt = renewedExpiry(box.expiresAt ?? now, now);

  /*
   * 幂等键带上**新的到期日**。
   *
   * 这样同一次续费点两下只扣一次（两次算出来的到期日相同），
   * 而明年再续时键不一样，照价收费 —— 和称号那边同一个办法。
   */
  const paid = grantPoints({
    userId: input.userId,
    delta: -rent,
    reason: `续期 ${box.localPart}@${box.domain} 到 ${new Date(expiresAt).toISOString().slice(0, 10)}`,
    ruleKey: "mail.renew",
    refType: "mail_box",
    refId: box.id,
    idempotencyKey: `mail.renew:${box.id}:${expiresAt}`,
  });
  if (!paid.ok) return { ok: false, error: paid.error ?? "扣分没成功" };

  db.update(mailBoxes)
    .set({
      expiresAt,
      renewedAt: now,
      // 续过几次。用 sql 自增而不是读出来加一 —— 两次并发续期会互相覆盖
      renewCount: sql`${mailBoxes.renewCount} + 1`,
      // 宽限期里续上的要回到 active，否则它还是一副「快没了」的样子
      status: "active",
      graceUntil: null,
      updatedAt: now,
    })
    .where(eq(mailBoxes.id, box.id))
    .run();

  db.insert(mailEvents)
    .values({
      boxId: box.id,
      domain: box.domain,
      event: "renewed",
      actorId: input.userId,
      actorKind: "user",
      detail: { rent, expiresAt, from: box.expiresAt },
    })
    .run();

  return { ok: true, expiresAt, paid: rent };
}
