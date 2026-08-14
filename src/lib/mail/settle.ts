import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { mailBoxes, mailDomains, mailEvents, mailMessages } from "@/lib/db/schema";
import { notify } from "@/lib/forum/notify";
import { roles, userRoles } from "@/lib/db/schema";
import { and, isNotNull, isNull, lt } from "drizzle-orm";

import { domainsNeedingExpiryNotice } from "./admin-queries";
import { reclaimExpiredBurners } from "./burner";
import { expiryLabel, expiryStage } from "./expiry-rules";
import { GRACE_DAYS, REDEEM_DAYS } from "./slot-rules";

/**
 * 邮箱这一块在 health 那一轮里要做的事。
 *
 * 两件：**回收到期的一次性箱**，以及**把快到期的域名报出来**。
 *
 * ═════════════════════════════════════════
 * 域名到期告警比功能本身还急
 * ═════════════════════════════════════════
 *
 * 磁盘满了有告警，同步失败有告警，服务挂了有 502。
 * 而一个域名过期之后，挂在它上面的**所有邮箱同时消失**，
 * 表现只有一个：邮件不再来了。没有报错、没有 5xx，
 * 用户那边也不会立刻发现 —— 他只会以为最近没人给他发信。
 *
 * 100 个域名分散在不同的注册时间上，靠人记是记不住的。
 */

/**
 * 长期箱到期 → 进宽限期 → 宽限期满 → 真的放回池子。
 *
 * ═════════════════════════════════════════
 * 邮箱的宽限期是**必需的**，不是体贴
 * ═════════════════════════════════════════
 *
 * 称号到期只是不能佩戴；而邮箱到期被别人抢走的话，
 * **别人会开始收到本该给你的邮件**。那不是「失去一个装饰」，
 * 是一条还在被使用的身份线被接管 —— 而当事人可能是因为忙了两周
 * 没上站，或者只是没看见那条提醒。
 *
 * 所以到期只做一件事：改状态、记下宽限期到哪天。地址仍然是他的、
 * 信照收，只是别人抢不走。30 天内补交年租原样恢复
 * （`renewClaim` 会把状态改回 active）。
 */
function settleLongTermBoxes(now: number): { grace: number; released: number; redeemable: number } {
  /*
   * ① 到期的进宽限期。
   *
   * 只挑 `active` 的：已经在宽限期里的不该被重新计一次，
   * 否则它的宽限期会每天往后延一天 —— 永远不会真正到期。
   */
  const expiring = db
    .select({ id: mailBoxes.id, domain: mailBoxes.domain, userId: mailBoxes.userId })
    .from(mailBoxes)
    .where(
      and(
        eq(mailBoxes.kind, "temp"),
        eq(mailBoxes.status, "active"),
        isNotNull(mailBoxes.expiresAt),
        lt(mailBoxes.expiresAt, now),
      ),
    )
    .all();

  for (const box of expiring) {
    db.update(mailBoxes)
      .set({ status: "grace", graceUntil: now + GRACE_DAYS * 86_400_000, updatedAt: now })
      .where(eq(mailBoxes.id, box.id))
      .run();

    db.insert(mailEvents)
      .values({
        boxId: box.id,
        domain: box.domain,
        event: "grace_started",
        actorKind: "system",
        detail: { until: now + GRACE_DAYS * 86_400_000 },
      })
      .run();

    /*
     * 提醒本人。**这是整条链路上唯一一次他能自己救回来的机会** ——
     * 不提醒的话，他会在 30 天后发现地址没了，而那时候已经晚了。
     */
    notify({
      userId: box.userId,
      type: "system",
      groupKey: `mail:grace:${box.id}`,
      title: "你的长期邮箱到期了",
      body: `${GRACE_DAYS} 天内续费的话地址原样保留，信也照收。过了就会放回池子，别人可以申领 —— 而那之后寄给这个地址的信会进别人的箱子。`,
      link: "/mail/burner",
    });
  }

  /*
   * ② 宽限期满 → **进赎回期**，不是直接放回池子。
   *
   * ─────────────────────────────────────────
   * 两个窗口，两件不同的事
   * ─────────────────────────────────────────
   *
   *   宽限期（30 天）  地址**仍然是他的**，信照收，别人抢不走
   *   赎回期（7 天）   地址**已经不是他的了**，但别人也还拿不到 ——
   *                    他有优先权，原价拿回
   *
   * 信在这一步就删掉：赎回回来的是**地址**，不是历史。
   * 留着的话，一个已经不属于任何人的地址下面挂着旧邮件，
   * 而万一最后是别人拿到了它，那些信就到了别人手里。
   */
  const toRedeem = db
    .select({ id: mailBoxes.id, domain: mailBoxes.domain, userId: mailBoxes.userId })
    .from(mailBoxes)
    .where(
      and(
        eq(mailBoxes.kind, "temp"),
        eq(mailBoxes.status, "grace"),
        isNotNull(mailBoxes.graceUntil),
        lt(mailBoxes.graceUntil, now),
      ),
    )
    .all();

  for (const box of toRedeem) {
    db.delete(mailMessages).where(eq(mailMessages.boxId, box.id)).run();
    db.update(mailBoxes)
      .set({
        status: "expired",
        graceUntil: null,
        redeemUntil: now + REDEEM_DAYS * 86_400_000,
        updatedAt: now,
      })
      .where(eq(mailBoxes.id, box.id))
      .run();

    db.insert(mailEvents)
      .values({
        boxId: box.id,
        domain: box.domain,
        event: "redeem_window",
        actorKind: "system",
        detail: { until: now + REDEEM_DAYS * 86_400_000 },
      })
      .run();

    notify({
      userId: box.userId,
      type: "system",
      groupKey: `mail:redeem:${box.id}`,
      title: "邮箱地址已经放开了",
      body: `你还有 ${REDEEM_DAYS} 天优先权，原价就能拿回来。过了这几天别人就可以申领它。`,
      link: "/mail/burner",
    });
  }

  /*
   * ③ 赎回期也过了 → 真的删行。
   *
   * **删行**，不是改状态：地址的唯一性靠 `mail_boxes.address` 上那个
   * 唯一索引保证，留着行的话别人根本申领不了 —— 而「放回池子」
   * 这句话的全部意思就是别人能拿到它。
   */
  const dead = db
    .select({ id: mailBoxes.id, domain: mailBoxes.domain })
    .from(mailBoxes)
    .where(
      and(
        eq(mailBoxes.kind, "temp"),
        eq(mailBoxes.status, "expired"),
        isNotNull(mailBoxes.redeemUntil),
        lt(mailBoxes.redeemUntil, now),
      ),
    )
    .all();

  for (const box of dead) {
    db.delete(mailMessages).where(eq(mailMessages.boxId, box.id)).run();
    db.delete(mailBoxes).where(eq(mailBoxes.id, box.id)).run();
    db.insert(mailEvents)
      .values({ boxId: box.id, domain: box.domain, event: "released", actorKind: "system" })
      .run();
  }

  return { grace: expiring.length, released: dead.length, redeemable: toRedeem.length };
}

export interface MailSettleResult {
  /** 这一轮有几个长期箱进了宽限期 */
  grace?: number;
  /** 有几个宽限期满、进了原主的 7 天赎回期 */
  redeemable?: number;
  /** 有几个赎回期也过了、真的放回池子 */
  released?: number;
  /** 回收掉的一次性箱 */
  reclaimed: number;
  /** 这一轮报出去的到期告警 */
  notified: number;
  /** 报了哪些，给日志看 */
  domains: string[];
}

export function settleMail(now = Date.now()): MailSettleResult {
  const reclaimed = reclaimExpiredBurners(now);
  const longTerm = settleLongTermBoxes(now);
  const due = domainsNeedingExpiryNotice(now);

  if (due.length === 0) return { reclaimed, notified: 0, domains: [], ...longTerm };

  /*
   * 报给谁：站长和管理员。
   *
   * **不报给域名主人** —— 域名是站里买的、站里续费的，
   * 告诉他「你的域名 7 天后过期」只会让他去找站长，
   * 而站长本来就该是第一个知道的人。
   */
  const admins = db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(isNull(userRoles.revokedAt), eq(roles.key, "owner")))
    .all()
    .map((r) => r.userId);

  const domains: string[] = [];

  for (const item of due) {
    const stage = expiryStage(item.days);
    if (stage === null) continue;

    for (const userId of admins) {
      notify({
        userId,
        type: "system",
        /*
         * 聚合键带上档位：30 天那条和 7 天那条是**两件不同的事**，
         * 合并成一条的话，7 天那次只会让 30 天那条的计数 +1，
         * 而人早就把它划掉了。
         */
        groupKey: `mail:domain-expiry:${item.domain}:${stage}`,
        title: `域名 ${item.domain} ${expiryLabel(item.days)}`,
        body:
          "域名过期之后，挂在它上面的所有邮箱会同时消失，而且没有任何征兆 —— 邮件只是不再来了。",
        link: "/admin/mail",
      });
    }

    // 记下报到哪一档了，下一轮不再重复报同一档
    db.update(mailDomains)
      .set({ expiryNoticeStage: stage })
      .where(eq(mailDomains.domain, item.domain))
      .run();

    domains.push(`${item.domain}(${item.days}天)`);
  }

  return { reclaimed, notified: domains.length, domains };
}
