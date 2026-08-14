import "server-only";

import { and, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { mailBoxes, mailDomains } from "@/lib/db/schema";

import { splitAddress } from "./address-rules";
import { MAIL_BOX_ALIVE_STATUSES } from "./kinds";

/**
 * 网关判定收不收一封信要用的两份数据。
 *
 * ═════════════════════════════════════════
 * 判定必须发生在 RCPT 阶段
 * ═════════════════════════════════════════
 *
 * 也就是说：**不认识的地址要当场拒，不能收下来再退信**。
 *
 * 先收后退会让我们变成退信轰炸的帮凶 —— 垃圾邮件的发件人
 * 几乎都是伪造的，我们退回去的每一封都砸在一个无辜的邮箱上。
 * 而且这是被列进黑名单最快的一条路。
 */

export interface RoutingSnapshot {
  /** 收信的域名（A 标签），以及它开没开 catch-all */
  domains: { punycode: string; catchAll: boolean }[];
  /** 快照生成时间，网关拿它判断自己手上的那份有多旧 */
  at: number;
}

export function mailRoutingSnapshot(): RoutingSnapshot {
  const rows = db
    .select({
      punycode: mailDomains.punycode,
      catchAll: mailDomains.catchAll,
      ownerUserId: mailDomains.ownerUserId,
    })
    .from(mailDomains)
    .where(
      and(
        eq(mailDomains.enabled, true),
        /*
         * 只排 `blocked` —— 它们连 MX 都不该配。
         *
         * `admin` 的**要留在名单里**：网关靠这份快照决定域名认不认，
         * 排掉的话它会在 RCPT 阶段回 550「这个域名不在这里收信」，
         * 于是管理员在上面开的地址收不到信，而且我们也看不到试探。
         */
        ne(mailDomains.kind, "blocked"),
      ),
    )
    .all();

  return {
    domains: rows.map((r) => ({
      punycode: r.punycode,
      // 没有主人的域名开着 catch-all 也没用：信落不到任何箱子里
      catchAll: r.catchAll && Boolean(r.ownerUserId),
    })),
    at: Date.now(),
  };
}

/**
 * 这个地址现在收不收信。
 *
 * 网关在快照说不准时逐个来问 —— 主要是**刚开出来的一次性箱**：
 * 用户开完就去点「发送验证码」，等不了下一次快照刷新。
 */
export function deliverableAddress(raw: string): boolean {
  const parts = splitAddress(raw.trim().toLowerCase());
  if (!parts) return false;

  const domain = db
    .select()
    .from(mailDomains)
    .where(eq(mailDomains.punycode, parts.domain))
    .get();

  if (!domain || !domain.enabled || domain.kind === "blocked") return false;

  const exact = db
    .select({ id: mailBoxes.id })
    .from(mailBoxes)
    .where(
      and(
        eq(mailBoxes.address, `${parts.local}@${parts.domain}`),
        inArray(mailBoxes.status, MAIL_BOX_ALIVE_STATUSES),
        /*
         * 到期的不算 —— 回收任务每 5 分钟才跑一次，
         * 而一个到期的地址在这中间**不该继续收信**：
         * 它随时会被别人抢走，那时这些信就落到别人手里了。
         */
        or(isNull(mailBoxes.expiresAt), gt(mailBoxes.expiresAt, Date.now())),
      ),
    )
    .get();

  if (exact) return true;

  // 具名地址没有，看域名主人开没开 catch-all
  return domain.catchAll && Boolean(domain.ownerUserId);
}
