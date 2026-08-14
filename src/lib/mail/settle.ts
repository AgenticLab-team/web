import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { mailDomains } from "@/lib/db/schema";
import { notify } from "@/lib/forum/notify";
import { roles, userRoles } from "@/lib/db/schema";
import { and, isNull } from "drizzle-orm";

import { domainsNeedingExpiryNotice } from "./admin-queries";
import { reclaimExpiredBurners } from "./burner";
import { expiryLabel, expiryStage } from "./expiry-rules";

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

export interface MailSettleResult {
  /** 回收掉的一次性箱 */
  reclaimed: number;
  /** 这一轮报出去的到期告警 */
  notified: number;
  /** 报了哪些，给日志看 */
  domains: string[];
}

export function settleMail(now = Date.now()): MailSettleResult {
  const reclaimed = reclaimExpiredBurners(now);
  const due = domainsNeedingExpiryNotice(now);

  if (due.length === 0) return { reclaimed, notified: 0, domains: [] };

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
