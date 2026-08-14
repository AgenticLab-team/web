import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { mailDomains } from "@/lib/db/schema";

import type { MailDomainTier } from "./kinds";
import { TIER_MIN_LEVEL, TIER_RENT } from "./slot-rules";

/**
 * 现在能申领的域名，连同价格和门槛。
 *
 * ─────────────────────────────────────────
 * 价格和门槛跟着域名一起给，不让界面自己去算
 * ─────────────────────────────────────────
 *
 * 界面自己按档位查价的话，那张价目表就有了第二份 ——
 * 而这一份的分叉方向是**页面上写着 60 分，扣的时候扣 150**。
 * 那种不一致会让人觉得被坑了，而他没法证明。
 */
export function claimableDomains(): {
  domain: string;
  tier: string;
  rent: number;
  minLevel: number;
}[] {
  return db
    .select({ domain: mailDomains.domain, tier: mailDomains.tier })
    .from(mailDomains)
    .where(
      and(
        eq(mailDomains.allowClaim, true),
        eq(mailDomains.enabled, true),
        eq(mailDomains.status, "active"),
      ),
    )
    .all()
    .map((d) => {
      // 没标档位的按最便宜那一档算 —— 和 claimAddress 里同一条兜底
      const tier = (d.tier ?? "b") as MailDomainTier;
      return {
        domain: d.domain,
        tier,
        rent: TIER_RENT[tier],
        minLevel: TIER_MIN_LEVEL[tier],
      };
    })
    .sort((a, b) => a.rent - b.rent || a.domain.localeCompare(b.domain));
}
