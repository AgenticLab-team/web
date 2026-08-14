import "server-only";

import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  mailBanwords,
  mailBoxes,
  mailDomains,
  mailIngressLog,
  users,
} from "@/lib/db/schema";

import { MAIL_BOX_ALIVE_STATUSES } from "./kinds";
import { expiryStage, EXPIRY_STAGES } from "./expiry-rules";

/**
 * 后台要看的那几张表。读取层，时钟在这里读完传下去。
 */

export interface DomainRow {
  domain: string;
  punycode: string;
  kind: string;
  tier: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  domainExpiresAt: number | null;
  /** 还剩几天到期。null = 没登记到期日 —— 这本身就是个问题 */
  expiryDays: number | null;
  mxOk: boolean | null;
  spfOk: boolean | null;
  dmarcOk: boolean | null;
  dnsCheckedAt: number | null;
  boxCount: number;
  recentReceived: number;
  status: string;
  enabled: boolean;
  note: string | null;
  /*
   * 下面这四个是「这个域名上能做什么」—— 后台编辑器要拿它们当初值。
   *
   * 原来这张视图不带它们，因为页面是只读的、只显示不编辑。
   * 而少了初值的编辑器最坏的形态不是报错，是**它把没显示的字段
   * 按默认值写回去** —— 一次保存顺手关掉了 catchAll，而屏幕上
   * 从头到尾没出现过这个词。
   */
  allowBurner: boolean;
  allowClaim: boolean;
  allowCustomLocal: boolean;
  inRandomRotation: boolean;
  catchAll: boolean;
}

export function listDomains(now = Date.now()): DomainRow[] {
  const rows = db
    .select({
      d: mailDomains,
      ownerName: users.siteNickname,
      ownerWx: users.wxNickname,
    })
    .from(mailDomains)
    .leftJoin(users, eq(users.id, mailDomains.ownerUserId))
    .orderBy(mailDomains.kind, mailDomains.domain)
    .all();

  /*
   * 箱子数和近 7 天收信量一次查完，不在循环里逐个查。
   *
   * 100 个域名 × 2 次查询 = 200 次，而这一页每次打开都要跑 ——
   * 后台页面慢下来的典型原因就是这种「看起来只是查一下」的循环。
   */
  const boxCounts = new Map(
    db
      .select({ domain: mailBoxes.domain, n: count() })
      .from(mailBoxes)
      .where(inArray(mailBoxes.status, MAIL_BOX_ALIVE_STATUSES))
      .groupBy(mailBoxes.domain)
      .all()
      .map((r) => [r.domain, r.n]),
  );

  const received = new Map(
    db
      .select({
        // envelope_to 是 `local@punycode`，取 @ 之后那半截
        punycode: sql<string>`substr(${mailIngressLog.envelopeTo}, instr(${mailIngressLog.envelopeTo}, '@') + 1)`,
        n: count(),
      })
      .from(mailIngressLog)
      .where(
        and(
          eq(mailIngressLog.verdict, "accepted"),
          sql`${mailIngressLog.createdAt} > ${now - 7 * 86400_000}`,
        ),
      )
      .groupBy(sql`substr(${mailIngressLog.envelopeTo}, instr(${mailIngressLog.envelopeTo}, '@') + 1)`)
      .all()
      .map((r) => [r.punycode, r.n]),
  );

  return rows.map(({ d, ownerName, ownerWx }) => ({
    domain: d.domain,
    punycode: d.punycode,
    kind: d.kind,
    tier: d.tier,
    ownerUserId: d.ownerUserId,
    // 兜底到微信昵称，但**绝不退化成 wx_id** —— 那条线全站都不许破
    ownerName: ownerName ?? ownerWx ?? (d.ownerUserId ? "（未设昵称）" : null),
    domainExpiresAt: d.domainExpiresAt,
    expiryDays:
      d.domainExpiresAt === null ? null : Math.floor((d.domainExpiresAt - now) / 86400_000),
    mxOk: d.mxOk,
    spfOk: d.spfOk,
    dmarcOk: d.dmarcOk,
    dnsCheckedAt: d.dnsCheckedAt,
    boxCount: boxCounts.get(d.domain) ?? 0,
    recentReceived: received.get(d.punycode) ?? 0,
    status: d.status,
    enabled: d.enabled,
    note: d.note,
    allowBurner: d.allowBurner,
    allowClaim: d.allowClaim,
    allowCustomLocal: d.allowCustomLocal,
    inRandomRotation: d.inRandomRotation,
    catchAll: d.catchAll,
  }));
}

export interface DomainSummary {
  total: number;
  byKind: Record<string, number>;
  /** 没登记到期日的 —— 它们不会触发任何告警，是最危险的一类 */
  noExpiry: number;
  /** 已经进入告警窗口的 */
  expiringSoon: DomainRow[];
  /** DNS 三项没全绿的 */
  dnsProblems: number;
  unclaimedOwned: number;
}

export function domainSummary(rows: DomainRow[]): DomainSummary {
  const byKind: Record<string, number> = {};
  for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

  return {
    total: rows.length,
    byKind,
    noExpiry: rows.filter((r) => r.domainExpiresAt === null).length,
    expiringSoon: rows
      .filter((r) => expiryStage(r.expiryDays) !== null)
      .sort((a, b) => (a.expiryDays ?? 0) - (b.expiryDays ?? 0)),
    /*
     * `admin` 那一类**要算进来** —— 它们配了 MX，正是靠收信
     * 才看得见有人在试探。只有 `blocked` 是真的不配记录。
     */
    dnsProblems: rows.filter(
      (r) => r.kind !== "blocked" && (r.mxOk !== true || r.spfOk !== true || r.dmarcOk !== true),
    ).length,
    unclaimedOwned: rows.filter((r) => r.kind === "owned" && !r.ownerUserId).length,
  };
}

export interface BoxRow {
  id: string;
  address: string;
  displayAddress: string;
  kind: string;
  ownerName: string | null;
  ownerUserId: string;
  expiresAt: number | null;
  messageCount: number;
  usedBytes: number;
  status: string;
  createdAt: number;
}

/** 地址表。**只有元数据** —— 主题和正文要 `mail.content.read`，见 MAIL.md 11.4 */
export function listBoxes(options: { limit?: number; userId?: string; domain?: string } = {}) {
  return db
    .select({
      b: mailBoxes,
      ownerName: users.siteNickname,
      ownerWx: users.wxNickname,
    })
    .from(mailBoxes)
    .leftJoin(users, eq(users.id, mailBoxes.userId))
    .where(
      and(
        options.userId ? eq(mailBoxes.userId, options.userId) : undefined,
        options.domain ? eq(mailBoxes.domain, options.domain) : undefined,
      ),
    )
    .orderBy(desc(mailBoxes.createdAt))
    .limit(options.limit ?? 100)
    .all()
    .map(
      ({ b, ownerName, ownerWx }): BoxRow => ({
        id: b.id,
        address: b.address,
        displayAddress: `${b.localPart}@${b.domain}`,
        kind: b.kind,
        ownerUserId: b.userId,
        ownerName: ownerName ?? ownerWx ?? "（未设昵称）",
        expiresAt: b.expiresAt,
        messageCount: b.messageCount,
        usedBytes: b.usedBytes,
        status: b.status,
        createdAt: b.createdAt,
      }),
    );
}

/** 被拒的投递。「我朋友说发了我没收到」唯一查得动的地方 */
export function recentRejections(limit = 50) {
  return db
    .select()
    .from(mailIngressLog)
    .where(inArray(mailIngressLog.verdict, ["rejected", "dropped", "quarantined"]))
    .orderBy(desc(mailIngressLog.createdAt))
    .limit(limit)
    .all();
}

export function listBanwords() {
  return db.select().from(mailBanwords).orderBy(mailBanwords.kind, mailBanwords.word).all();
}

/** 导出用：域名 → 归属 → 到期 → 类别。回答「这个域名是谁的」 */
export function exportDomains(rows: DomainRow[]): string {
  // BOM —— 不带的话 Excel 打开中文域名那几行是乱码，而没有人会来报这个
  const head = "﻿domain,punycode,kind,tier,owner,expires_at,mx,spf,dmarc,boxes,note";
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) =>
    [
      r.domain,
      r.punycode,
      r.kind,
      r.tier ?? "",
      r.ownerName ?? "",
      r.domainExpiresAt ? new Date(r.domainExpiresAt).toISOString().slice(0, 10) : "",
      r.mxOk === null ? "?" : r.mxOk ? "ok" : "bad",
      r.spfOk === null ? "?" : r.spfOk ? "ok" : "bad",
      r.dmarcOk === null ? "?" : r.dmarcOk ? "ok" : "bad",
      r.boxCount,
      r.note ?? "",
    ]
      .map(esc)
      .join(","),
  );
  return [head, ...body].join("\n");
}

/** 到期告警要报的那些。挂在 health 那一轮 */
export function domainsNeedingExpiryNotice(now = Date.now()) {
  return db
    .select()
    .from(mailDomains)
    .where(and(isNotNull(mailDomains.domainExpiresAt), eq(mailDomains.enabled, true)))
    .all()
    .map((d) => ({
      domain: d.domain,
      days: Math.floor(((d.domainExpiresAt ?? 0) - now) / 86400_000),
      lastStage: d.expiryNoticeStage,
    }))
    .filter((d) => {
      const stage = expiryStage(d.days);
      if (stage === null) return false;
      // 每个档位只报一次 —— 不然每 5 分钟一条，一周之后没人再看告警
      return d.lastStage === null || stage < d.lastStage;
    });
}

export { EXPIRY_STAGES };

/**
 * 能被指定为域名主人的人。
 *
 * ─────────────────────────────────────────
 * 只列绑了微信的
 * ─────────────────────────────────────────
 *
 * 域名归属是**认到人**的事：一个域名归了某个只有站内账号、
 * 没有微信身份的人，出问题时联系不上他。而这个站的身份根在群里。
 *
 * 名字兜底到微信昵称，但**绝不退化成 wx_id** —— 那条线全站都不许破。
 */
export function domainOwnerCandidates(limit = 500): { id: string; name: string }[] {
  return db
    .select({ id: users.id, site: users.siteNickname, wx: users.wxNickname })
    .from(users)
    .where(and(isNotNull(users.wxId), eq(users.status, "active")))
    .limit(limit)
    .all()
    .map((u) => ({ id: u.id, name: (u.site || u.wx || "（未设昵称）").trim() }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
}
