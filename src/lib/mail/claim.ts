import "server-only";

import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { mailBoxes, mailDomains, mailEvents, mailSlots, users } from "@/lib/db/schema";
import { grantPoints } from "@/lib/points/ledger";
import { levelOf } from "@/lib/points/rules";

import { buildAddress, checkLocalPart, MAIL_BANWORD_KINDS } from "./address-rules";
import { listBanwords } from "./admin-queries";
import { mailConfig } from "./config";
import { CLAIMABLE_DOMAIN_KINDS } from "./kinds";
import type { MailDomainTier } from "./kinds";
import {
  canClaim,
  explainRefusal,
  PURCHASED_SLOT_CAP,
  SLOT_PRICE,
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
  /*
   * ★ 两道闸，因为它们防的不是同一件事。
   *
   * `allow_claim` 是管理员的开关（这个域名现在放不放出来）。
   * `kind` 是域名的**身份**：`owned` 是有主的，只有主人能在上面开地址
   * （走 `openAlias`）；`temp` 是一次性箱池。
   *
   * 只看开关的话，一个 `owned` 域名被误标成 allow_claim 就等于
   * 把别人的域名放上了货架 —— 而列表那边（`claimableDomains`）
   * 已经过滤过一次了，这里再挡一次是因为**列表和申领是两条路**：
   * 申领只要一个域名名字，不必先从列表里点。
   */
  if (!CLAIMABLE_DOMAIN_KINDS.includes(domainRow.kind as (typeof CLAIMABLE_DOMAIN_KINDS)[number])) {
    return { ok: false, error: "这个域名不在公共申领池里" };
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
    .select({
      id: mailBoxes.id,
      userId: mailBoxes.userId,
      status: mailBoxes.status,
      redeemUntil: mailBoxes.redeemUntil,
    })
    .from(mailBoxes)
    .where(eq(mailBoxes.address, address))
    .get();

  /*
   * ─────────────────────────────────────────
   * 赎回期：原主有 7 天优先权
   * ─────────────────────────────────────────
   *
   * 这一段是三种情况，而它们的答案都不一样：
   *
   *   ① 还在用          谁都拿不到
   *   ② 赎回期 + 是原主   **原价拿回**，走下面那条正常路
   *   ③ 赎回期 + 是别人   拿不到，但要说清楚**什么时候能拿**
   *
   * ③ 那句话要给日期。只说「暂时不能申领」的话，他只能每天来试一次 ——
   * 而这个地址他可能已经等了一个月。
   */
  const redeemable =
    taken && taken.status === "expired" && (taken.redeemUntil ?? 0) > now;

  if (taken && !redeemable) return { ok: false, error: "这个地址已经有人了" };
  if (taken && redeemable && taken.userId !== input.userId) {
    const when = new Date(taken.redeemUntil!).toLocaleDateString("zh-CN");
    return { ok: false, error: `原主人还有优先权，${when} 之后才放开` };
  }

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
    /*
     * 赎回走 `update` —— 那一行还在（`status: expired`），
     * 而 `address` 上有唯一索引，insert 会直接撞上去。
     */
    const box = taken
      ? db
          .update(mailBoxes)
          .set({
            status: "active",
            expiresAt,
            redeemUntil: null,
            graceUntil: null,
            updatedAt: now,
          })
          .where(eq(mailBoxes.id, taken.id))
          .returning()
          .get()
      : db
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

export interface ClaimedView {
  id: string;
  address: string;
  domain: string;
  tier: string;
  /** 续一年要多少分 —— 跟着地址一起给，不让界面自己按档位查价 */
  rent: number;
  expiresAt: number | null;
  /**
   * 还剩几天到期。**在服务端算好**，不让组件自己减。
   *
   * 组件里 `Date.now()` 会被 lint 拦（规则是对的：渲染期读时钟意味着
   * 同一次渲染的两处可能拿到不同的「现在」），而更实际的问题是
   * 一个客户端组件里的「今天」跟着用户的机器走 ——
   * 他把系统时间调快一天，页面上就会显示地址明天到期。
   */
  daysLeft: number | null;
  /** 在宽限期里时它到哪天。null = 不在宽限期 */
  graceUntil: number | null;
  /** 宽限期还剩几天。同上，服务端算 */
  graceDaysLeft: number | null;
  status: string;
  messageCount: number;
  unreadCount: number;
}

/**
 * 我申领来的长期地址。
 *
 * ─────────────────────────────────────────
 * 它以前根本没有列表
 * ─────────────────────────────────────────
 *
 * `listAliases` 只查 `alias`（自有域名那种），`listBurners` 只查
 * `burner` —— 而申领来的是 `temp`。也就是说申领成功之后，
 * **那个地址在界面上一处都不出现**：花了 400 分，然后它消失了。
 *
 * 快到期的排在前面：这一栏唯一会让人后悔的事就是错过续期。
 */
export function listClaimed(userId: string, now = Date.now()): ClaimedView[] {
  const rows = db
    .select({ b: mailBoxes, tier: mailDomains.tier })
    .from(mailBoxes)
    .leftJoin(mailDomains, eq(mailDomains.domain, mailBoxes.domain))
    .where(
      and(
        eq(mailBoxes.userId, userId),
        eq(mailBoxes.kind, "temp"),
        inArray(mailBoxes.status, ["active", "full", "grace"]),
      ),
    )
    .all();

  return rows
    .map(({ b, tier }) => {
      const t = (tier ?? "b") as MailDomainTier;
      return {
        id: b.id,
        address: `${b.localPart}@${b.domain}`,
        domain: b.domain,
        tier: t,
        rent: TIER_RENT[t],
        expiresAt: b.expiresAt,
        daysLeft: b.expiresAt === null ? null : Math.ceil((b.expiresAt - now) / 86_400_000),
        graceUntil: b.graceUntil,
        graceDaysLeft:
          b.graceUntil === null ? null : Math.max(0, Math.ceil((b.graceUntil - now) / 86_400_000)),
        status: b.status,
        messageCount: b.messageCount,
        unreadCount: b.unreadCount,
      };
    })
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
}

/**
 * 买一个额外槽位。
 *
 * ═════════════════════════════════════════
 * 它是**一次性**的，而地址的年租是周期性的
 * ═════════════════════════════════════════
 *
 * 这个区别要紧：一次性商品买完回收就归零，所以它不能是唯一的
 * 花分出口（`ECONOMY.md` 那条）。槽位买的是「能同时拥有几个地址」，
 * 而每个地址自己还在按年扣租 —— 两者叠起来才是完整的回收。
 *
 * ─────────────────────────────────────────
 * 上限 3 个，而且这个上限本身就是设计
 * ─────────────────────────────────────────
 *
 * 没有上限的话，「钱能买断」——一个攒够分的人可以把好前缀囤成资产，
 * 而那正是 `LEVEL_SLOT_CAP` 那条要防的同一件事，只是换了条路进来。
 */
export function buySlot(input: {
  userId: string;
  now?: number;
}): { ok: true; total: number; paid: number } | { ok: false; error: string } {
  const now = input.now ?? Date.now();

  const owned =
    db
      .select({ n: count() })
      .from(mailSlots)
      .where(and(eq(mailSlots.userId, input.userId), isNull(mailSlots.revokedAt)))
      .get()?.n ?? 0;

  if (owned >= PURCHASED_SLOT_CAP) {
    return { ok: false, error: `最多买 ${PURCHASED_SLOT_CAP} 个。再要就只能升级 —— 每升一级多一个（L5 封顶）` };
  }

  const user = db
    .select({ balance: users.points })
    .from(users)
    .where(eq(users.id, input.userId))
    .get();
  if (!user) return { ok: false, error: "没有这个人" };
  if (user.balance < SLOT_PRICE) {
    return {
      ok: false,
      error: `一个槽位 ${SLOT_PRICE} 分，你有 ${user.balance} 分 —— 还差 ${SLOT_PRICE - user.balance}`,
    };
  }

  /*
   * 幂等键带上**这是第几个**。
   *
   * 同一个人连点两下只会买到一个（两次算出来的序号相同）；
   * 而他真的想买第二个时序号变了，照价收费。
   *
   * 用序号而不是时间戳：时间戳会让「连点两下」在跨秒时变成两笔。
   */
  const paid = grantPoints({
    userId: input.userId,
    delta: -SLOT_PRICE,
    reason: `买邮箱槽位（第 ${owned + 1} 个）`,
    ruleKey: "mail.slot",
    refType: "mail_slot",
    refId: `${input.userId}:${owned + 1}`,
    idempotencyKey: `mail.slot:${input.userId}:${owned + 1}`,
  });
  if (!paid.ok) return { ok: false, error: paid.error ?? "扣分没成功" };

  /*
   * ⚠️ 幂等键挡下的那次**不能再插一行槽位**。
   *
   * `grantPoints` 对重复的键返回 `{ ok: true, duplicate: true }` ——
   * 它是「这笔账已经记过了」，不是「又记了一笔」。
   * 不看这个标志的话，连点两下会扣一次分、拿到两个槽位。
   */
  if (paid.duplicate) return { ok: true, total: owned, paid: 0 };

  db.insert(mailSlots)
    .values({
      userId: input.userId,
      source: "purchase",
      ledgerId: paid.ledgerId ?? null,
      createdAt: now,
    })
    .run();

  return { ok: true, total: owned + 1, paid: SLOT_PRICE };
}
