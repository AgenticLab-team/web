import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  activityApplications,
  mailBanwords,
  mailDomains,
  roles,
  userRoles,
  users,
} from "@/lib/db/schema";

import {
  CATALOG,
  CONFIRMED_PAIRS,
  DOMAIN_EXPIRES_AT,
  OWNER_DOMAINS,
  SUBSTITUTES,
  isPunycodeSane,
  resolveFlags,
  toPunycode,
} from "./domain-catalog";
import { explainMatch, matchDomain, type Candidate } from "./claim-matching";
import { SYSTEM_RESERVED } from "./address-rules";
import type { MailBanwordKind } from "./kinds";

/**
 * 把 100 个域名灌进库，并把有主的那些认到人头上。幂等，每次启动都跑。
 *
 * ═════════════════════════════════════════
 * 只补不改
 * ═════════════════════════════════════════
 *
 * 已经在库里的域名**一个字段都不动**。和 `DEFAULT_SETTINGS` 同一个规矩：
 * 管理员在后台把某个域名从靓号池调到一次性池，是一次有意的决定，
 * 下次重启把它改回来的话，那个后台页面就是假的。
 *
 * 唯一的例外是**归属**：`owner_user_id` 为空时会去认领一次。
 * 因为域名先进库、人后绑定账号是常态 —— 活动那批里就有人是后来才注册的。
 */

export interface DomainSeedReport {
  /** 这次新写进去几个域名 */
  domains: number;
  /** 这次认到人头上几个 */
  claimed: number;
  /** 内置禁用词补了几条 */
  banwords: number;
  /** 这次靠匹配认出来几个「看起来是给某人的」域名 */
  matched: { domain: string; userId: string; why: string }[];
  /** 补了几个域名的到期日 */
  expiryFilled: number;
  /** ⚠ punycode 转换出问题的域名 —— 一个都不该有 */
  punycodeProblems: string[];
}

export function seedMailDomains(): DomainSeedReport {
  const report: DomainSeedReport = {
    domains: 0,
    claimed: 0,
    banwords: 0,
    punycodeProblems: [],
    matched: [],
    expiryFilled: 0,
  };

  const existing = new Set(
    db.select({ domain: mailDomains.domain }).from(mailDomains).all().map((r) => r.domain),
  );

  for (const entry of CATALOG) {
    const punycode = toPunycode(entry.domain);

    /*
     * 转换出问题的**不写进去**，报上来。
     *
     * 写进去的话表现是「这个域名收不到信」而没有任何报错 ——
     * 信封上的收件人是 A 标签，跟库里对不上，网关那一侧直接拒，
     * 而拒的原因永远不会传到我们眼前。
     */
    if (!isPunycodeSane(entry.domain, punycode)) {
      report.punycodeProblems.push(`${entry.domain} → ${punycode}`);
      continue;
    }

    if (existing.has(entry.domain)) continue;

    const flags = resolveFlags(entry);
    db.insert(mailDomains)
      .values({
        domain: entry.domain,
        punycode,
        kind: entry.kind,
        tier: entry.tier ?? null,
        note: entry.note ?? null,
        allowBurner: flags.allowBurner,
        allowClaim: flags.allowClaim,
        allowCustomLocal: flags.allowCustomLocal,
        inRandomRotation: flags.inRandomRotation,
        catchAll: flags.catchAll,
        // 域名本身是买好的，但 MX 还没配 —— DNS 体检跑过一轮才转 active
        status: "pending",
        createdBy: "system",
      })
      .run();
    report.domains++;
  }

  report.claimed = claimOwners();
  report.matched = resolvePendingOwners();
  report.expiryFilled = fillExpiry();
  report.banwords = seedBanwords();
  return report;
}

/**
 * 把有主域名认到人头上。
 *
 * ─────────────────────────────────────────
 * 归属是查出来的，不是写死的
 * ─────────────────────────────────────────
 *
 * 从 `activity_applications` 里按 `normalized_key` 对应回申请人 ——
 * 写死一份「域名 → 人名」的清单，等于把一份会变的事实抄成了常量，
 * 而且**「这个域名凭什么是他的」就答不上了**。
 * 认领时把 application id 一起记进 `source_application_id`，正是为了答这句。
 *
 * 只认 `owner_user_id` 还空着的：认过一次之后，后台改归属的结果不能被覆盖。
 */
function claimOwners(): number {
  const unclaimed = db
    .select({ domain: mailDomains.domain })
    .from(mailDomains)
    .where(and(eq(mailDomains.kind, "owned"), isNull(mailDomains.ownerUserId)))
    .all();

  if (unclaimed.length === 0) return 0;

  const applications = db
    .select({
      id: activityApplications.id,
      userId: activityApplications.userId,
      key: activityApplications.normalizedKey,
    })
    .from(activityApplications)
    .where(eq(activityApplications.status, "submitted"))
    .all();

  const byKey = new Map<string, { id: string; userId: string }>();
  for (const app of applications) {
    if (app.key) byKey.set(app.key, { id: app.id, userId: app.userId });
  }

  /*
   * 抢注失败之后另买的替代品。
   *
   * 那位登记的是 niuniu.icu，而它 2023 年就被别人注册了（RDAP 查得到）。
   * 站长另买了 niuniu869.icu —— 认领时要能从**当初登记的那个名字**
   * 找到人，否则他手里那张空头支票永远兑不了。
   */
  for (const [failed, replacement] of Object.entries(SUBSTITUTES)) {
    const app = byKey.get(failed);
    if (app) byKey.set(replacement, app);
  }

  const siteOwnerId = findSiteOwner();
  let claimed = 0;

  for (const { domain } of unclaimed) {
    let userId: string | null = null;
    let applicationId: string | null = null;

    if ((OWNER_DOMAINS as readonly string[]).includes(domain)) {
      userId = siteOwnerId;
    } else {
      const app = byKey.get(domain);
      if (app) {
        userId = app.userId;
        applicationId = app.id;
      }
    }

    if (!userId) continue;

    db.update(mailDomains)
      .set({ ownerUserId: userId, sourceApplicationId: applicationId, updatedAt: Date.now() })
      .where(eq(mailDomains.domain, domain))
      .run();
    claimed++;
  }

  return claimed;
}

/**
 * 那 22 个「看起来是给某个人的」域名，逐个跑一遍匹配。
 *
 * ═════════════════════════════════════════
 * 匹配上就转成 owned，匹配不上就留在原地
 * ═════════════════════════════════════════
 *
 * 站长的规矩是「有类似的就归给那个用户，没有就扔到公共池」。
 * 这里把它实现成一个**保守的**匹配（见 `claim-matching.ts`）——
 * 判错的代价不对称：判不出来只是一次沟通，
 * 判错了是把 A 的域名发给了 B，而 B 一旦拿它注册了什么就收不回来。
 *
 * 只处理**还没有主人**的：认过一次之后，后台改的结果不能被覆盖。
 */
function resolvePendingOwners(): { domain: string; userId: string; why: string }[] {
  const pending = CATALOG.filter((e) => e.pendingOwner).map((e) => e.domain);
  if (pending.length === 0) return [];

  const rows = db
    .select({ domain: mailDomains.domain, ownerUserId: mailDomains.ownerUserId })
    .from(mailDomains)
    .where(inArray(mailDomains.domain, pending))
    .all()
    .filter((r) => !r.ownerUserId);

  if (rows.length === 0) return [];

  const candidates = buildCandidates();
  const confirmed = confirmedOwners();
  const done: { domain: string; userId: string; why: string }[] = [];

  for (const row of rows) {
    /*
     * 人工确认的先看 —— 它们正是匹配器**有道理地**挡下来的那几个
     * （核心串太短、或者改了中间的字母）。规则不放松，人工的走这条路。
     */
    const manual = confirmed.get(row.domain);
    const hit = manual ? null : matchDomain(row.domain, candidates);
    if (!manual && !hit) continue;

    const why = manual ? manual.why : explainMatch(hit!);
    const userId = manual ? manual.userId : hit!.userId;
    db.update(mailDomains)
      .set({
        kind: "owned",
        tier: null,
        // 自有域名那条路的意义就是 catch-all，认到人就该开着
        catchAll: true,
        allowBurner: false,
        allowClaim: true,
        ownerUserId: userId,
        note: why,
        updatedAt: Date.now(),
      })
      .where(eq(mailDomains.domain, row.domain))
      .run();

    done.push({ domain: row.domain, userId, why });
  }

  return done;
}

/**
 * 把站长人工确认的配对翻译成「域名 → 人」。
 *
 * 人是**从库里查的**（谁拥有配对的那个域名），不是写死的 ——
 * 所以那个人改昵称、换账号都不影响，而且「凭什么是他的」照样答得上。
 *
 * 配对的那个域名还没有主人时**跳过**：宁可这一轮不认，
 * 下一轮（那个人绑定账号之后）自然会认上。
 */
function confirmedOwners(): Map<string, { userId: string; why: string }> {
  const out = new Map<string, { userId: string; why: string }>();
  const pairs = Object.entries(CONFIRMED_PAIRS);
  if (pairs.length === 0) return out;

  const owners = new Map(
    db
      .select({ domain: mailDomains.domain, owner: mailDomains.ownerUserId })
      .from(mailDomains)
      .where(inArray(mailDomains.domain, pairs.map(([, paired]) => paired)))
      .all()
      .filter((r) => r.owner)
      .map((r) => [r.domain, r.owner as string]),
  );

  for (const [domain, paired] of pairs) {
    const owner = owners.get(paired);
    if (owner) out.set(domain, { userId: owner, why: `站长确认：和「${paired}」是同一个人的` });
  }

  return out;
}

/**
 * 拿来比对的那些串：所有人的昵称/用户名，加上已经认领过的域名。
 *
 * 已认领域名是**最强的一类证据** —— `ashipowner` 对上 `shipowner`
 * 这种「同一个人的第二个域名」，靠昵称是对不上的。
 */
function buildCandidates(): Candidate[] {
  const out: Candidate[] = [];

  for (const u of db
    .select({ id: users.id, nick: users.wxNickname, site: users.siteNickname, name: users.username })
    .from(users)
    .where(eq(users.status, "active"))
    .all()) {
    for (const handle of [u.site, u.nick, u.name]) {
      if (handle) out.push({ userId: u.id, handle, source: "nickname" });
    }
  }

  for (const d of db
    .select({ domain: mailDomains.domain, owner: mailDomains.ownerUserId })
    .from(mailDomains)
    .where(eq(mailDomains.kind, "owned"))
    .all()) {
    if (d.owner) {
      out.push({ userId: d.owner, handle: d.domain.replace(/\.[a-z]+$/, ""), source: "claimed-domain" });
    }
  }

  return out;
}

/**
 * 补到期日。
 *
 * 这是**填空，不是覆盖**：只动 `domain_expires_at` 还是 null 的行 ——
 * 后台改过的日期不能被下次启动重置。
 *
 * 为什么急着填：空的到期日**不会触发任何告警**，
 * 也就是说没填的那些比快到期的还危险 —— 会在完全没有预警的情况下过期，
 * 然后挂在上面的所有邮箱一起消失。
 */
function fillExpiry(): number {
  return db
    .update(mailDomains)
    .set({ domainExpiresAt: DOMAIN_EXPIRES_AT, updatedAt: Date.now() })
    .where(isNull(mailDomains.domainExpiresAt))
    .run().changes;
}

/**
 * 站长是谁。
 *
 * 按 `owner` 身份组查，不写 ID —— 换机器、换环境时写死的 ID
 * 会认领到一个不存在的人身上，而那个域名从此没有主人也没有报错。
 * 查不到就返回 null：**宁可不认领，也不能认错**。
 */
function findSiteOwner(): string | null {
  const row = db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(roles.key, "owner"), isNull(userRoles.revokedAt)))
    .limit(1)
    .get();
  return row?.userId ?? null;
}

/**
 * 内置禁用词。
 *
 * 只补不改，而且 `builtin` 的那几条后台删不掉 ——
 * `postmaster` 和 `abuse` 是 RFC 要求域名能收的地址，
 * 也是收「你们家域名在发垃圾邮件」这种投诉的唯一通道。
 * 发给用户的话，我们会在完全不知情的情况下被投诉、被拉黑。
 */
const BUILTIN_BANWORDS: readonly { word: string; kind: MailBanwordKind; reason: string }[] = [
  ...SYSTEM_RESERVED.map(
    (word) => ({ word, kind: "exact" as const, reason: "RFC 要求保留，投诉走这里" }),
  ),
  { word: "admin", kind: "exact", reason: "会让收信人误判身份" },
  { word: "administrator", kind: "exact", reason: "会让收信人误判身份" },
  { word: "root", kind: "exact", reason: "会让收信人误判身份" },
  { word: "security", kind: "exact", reason: "会让收信人误判身份" },
  { word: "support", kind: "exact", reason: "会让收信人误判身份" },
  { word: "billing", kind: "exact", reason: "会让收信人误判身份" },
  { word: "payment", kind: "exact", reason: "会让收信人误判身份" },
  { word: "noreply", kind: "prefix", reason: "会让收信人误判身份" },
  { word: "no-reply", kind: "prefix", reason: "会让收信人误判身份" },
  { word: "webmaster", kind: "exact", reason: "会让收信人误判身份" },
  { word: "hostmaster", kind: "exact", reason: "RFC 2142 列的角色地址" },
  { word: "dmarc", kind: "prefix", reason: "DMARC 报告要寄到这里" },
  { word: "agenticlab", kind: "contains", reason: "站点自己的名字" },
];

function seedBanwords(): number {
  const existing = new Set(
    db
      .select({ word: mailBanwords.word, kind: mailBanwords.kind })
      .from(mailBanwords)
      .all()
      .map((r) => `${r.word}:${r.kind}`),
  );

  let added = 0;
  for (const rule of BUILTIN_BANWORDS) {
    if (existing.has(`${rule.word}:${rule.kind}`)) continue;
    db.insert(mailBanwords)
      .values({
        word: rule.word,
        kind: rule.kind,
        reason: rule.reason,
        // 系统内置的删不掉 —— 见上面那段
        builtin: (SYSTEM_RESERVED as readonly string[]).includes(rule.word),
        createdBy: "system",
      })
      .run();
    added++;
  }
  return added;
}
