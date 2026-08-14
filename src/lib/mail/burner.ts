import "server-only";

import { randomBytes } from "node:crypto";

import { and, count, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { mailBanwords, mailBoxes, mailDomains, mailEvents, mailMessages } from "@/lib/db/schema";

import {
  addressFits,
  buildAddress,
  checkLocalPart,
  randomLocalPart,
  type BanwordRule,
} from "./address-rules";
import { mailConfig } from "./config";
import { MAIL_BOX_ALIVE_STATUSES } from "./kinds";

/**
 * 一次性箱：开、列、销毁。
 *
 * ═════════════════════════════════════════
 * 它必须是零摩擦的
 * ═════════════════════════════════════════
 *
 * 「要收个验证码 → 先想想还剩几个槽位」的产品，用户第二次就不会来了。
 * 所以一次性箱**不占槽位**，约束只有两条：同时在手几个，以及 24 小时的寿命。
 *
 * 而那个「同时在手」的额度**必须网页和 API 共用**。分开算的话，
 * 「网页 3 个 + 每把令牌 3 个 + 令牌能建很多把」等于没有上限 ——
 * 这是限流最常见的漏法：每一处都限了，加起来没限。
 */

export interface OpenBurnerInput {
  userId: string;
  /** 自选前缀。不填就随机 */
  localPart?: string | null;
  /** 指定域名（U 标签）。不填就从随机轮换里挑 */
  domain?: string | null;
  /** 通过哪把令牌开的。网页开的为 null */
  tokenId?: string | null;
  /**
   * 站长的越权通道：绕过最短长度、禁用词、`allowCustomLocal`。
   * **调用方必须已经查过 `mail.box.write`**，这里只认结果不做判定 ——
   * 权限判定只有一处，混进这里就成了两处。
   */
  bypassLimits?: boolean;
}

export type OpenBurnerResult =
  | { ok: true; box: BurnerView }
  | { ok: false; error: string; code: BurnerErrorCode };

export type BurnerErrorCode =
  | "no_domain"
  | "bad_local"
  | "taken"
  | "concurrent_limit"
  | "rate_limit"
  | "custom_not_allowed";

export interface BurnerView {
  id: string;
  address: string;
  /** 展示用：中文域名要给人看 U 标签，信封用 A 标签 */
  displayAddress: string;
  domain: string;
  localPart: string;
  custom: boolean;
  expiresAt: number;
  messageCount: number;
  unreadCount: number;
  createdAt: number;
}

export function openBurner(input: OpenBurnerInput, attempt = 0): OpenBurnerResult {
  const config = mailConfig();
  const now = Date.now();

  if (!input.bypassLimits) {
    const concurrent = countLiveBurners(input.userId);
    if (concurrent >= config.burnerConcurrentLimit) {
      return {
        ok: false,
        code: "concurrent_limit",
        error: `同时最多 ${config.burnerConcurrentLimit} 个一次性箱。销毁一个再开，或者等它到期`,
      };
    }

    const rate = checkOpenRate(input.userId, config, now);
    if (rate) return rate;
  }

  const wanted = input.localPart?.trim();
  const domainRow = pickDomain({
    domain: input.domain ?? null,
    needsCustom: Boolean(wanted),
    bypass: Boolean(input.bypassLimits),
  });

  if (!domainRow) {
    return {
      ok: false,
      code: wanted ? "custom_not_allowed" : "no_domain",
      error: wanted
        ? "这个域名不允许自选前缀 —— 换一个域名，或者用随机地址"
        : "现在没有可用的一次性域名，管理员那边还没配好",
    };
  }

  let localPart: string;
  let custom: boolean;

  if (wanted) {
    const verdict = checkLocalPart(wanted, {
      purpose: "burner",
      banwords: input.bypassLimits ? [] : loadBanwords(),
      minLength: input.bypassLimits ? 1 : config.burnerCustomMinLength,
    });
    if (!verdict.ok) return { ok: false, code: "bad_local", error: verdict.error ?? "前缀不能用" };
    localPart = verdict.local;
    custom = true;
  } else {
    localPart = randomLocalPart((n) => randomBytes(n));
    custom = false;
  }

  const address = buildAddress(localPart, domainRow.punycode);

  /*
   * 地址总长卡在 254（RFC 5321）。
   *
   * 前缀单独看是合法的（≤64），域名单独看也是合法的，
   * **加起来仍然可能超**：中文域名的 A 标签能到 41 个字符，
   * 而 `我真的特别…想你.icu` 正好在池子里。
   *
   * 超了的后果不是报错，是**发出去的信在对方服务器上被拒**，
   * 而拒信退回给发件人，我们这边什么都看不到 ——
   * 用户只会觉得「这个地址收不到信」。所以在这里挡住。
   */
  if (!addressFits(localPart, domainRow.punycode)) {
    return {
      ok: false,
      code: "bad_local",
      error: `这个前缀配上 ${domainRow.domain} 太长了（地址上限 254 个字符），换短一点的`,
    };
  }

  const expiresAt = now + config.burnerTtlHours * 3600_000;

  /*
   * 插入即抢占。
   *
   * 地址唯一性靠**部分唯一索引**（只在还活着的箱子之间唯一），
   * 不靠先查后插 —— 抢地址天然是并发的，查完到插入之间那一瞬
   * 足够另一个请求插进来。捕获约束冲突比自己加锁简单得多，
   * 也不会漏掉「同一个人两个标签页同时点」这种最常见的情况。
   */
  try {
    const inserted = db
      .insert(mailBoxes)
      .values({
        userId: input.userId,
        localPart,
        domain: domainRow.domain,
        address,
        kind: "burner",
        custom,
        expiresAt,
        tokenId: input.tokenId ?? null,
        quotaBytes: config.boxMaxBytes,
        // 脚本收信不需要有人被叮一下；网页上用户正盯着页面看
        muted: true,
        status: "active",
      })
      .returning()
      .get();

    db.insert(mailEvents)
      .values({
        boxId: inserted.id,
        domain: domainRow.domain,
        event: "burner_created",
        actorId: input.userId,
        actorKind: input.tokenId ? "token" : "user",
        tokenId: input.tokenId ?? null,
        detail: { custom, address },
      })
      .run();

    return { ok: true, box: toView(inserted) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      if (custom) return { ok: false, code: "taken", error: "这个地址已经有人在用了，换一个" };
      /*
       * 随机撞车的概率是 32^12 分之一。重试，但**要有次数上限** ——
       * 没有上限的话，任何一个我们没想到的约束冲突都会变成无限递归，
       * 表现是这个请求把一个 CPU 核跑满然后栈溢出。
       */
      if (attempt >= 3) throw error;
      return openBurner(input, attempt + 1);
    }
    throw error;
  }
}

/** 现在还活着的一次性箱有几个。到期的不算 —— 清理是异步的，判定不能等它 */
export function countLiveBurners(userId: string): number {
  const row = db
    .select({ n: count() })
    .from(mailBoxes)
    .where(
      and(
        eq(mailBoxes.userId, userId),
        eq(mailBoxes.kind, "burner"),
        inArray(mailBoxes.status, ["active", "full"]),
        gt(mailBoxes.expiresAt, Date.now()),
      ),
    )
    .get();
  return row?.n ?? 0;
}

/**
 * 开箱频率。
 *
 * ─────────────────────────────────────────
 * 卡开箱，不卡读信
 * ─────────────────────────────────────────
 *
 * 开箱消耗的是**全站共有的东西** —— 池域名的命名空间，
 * 以及那个域名的声誉。读信只消耗我们自己的 CPU。
 * 用同一个数字管两者的结果，要么是脚本根本没法用，
 * 要么是有人一晚上开出一万个地址。
 *
 * 数的是 `mail_events` 而不是现存的箱子：销毁掉的也要算，
 * 否则「开了就删、开了就删」能绕过任何上限。
 */
function checkOpenRate(
  userId: string,
  config: ReturnType<typeof mailConfig>,
  now: number,
): OpenBurnerResult | null {
  const since = (ms: number) =>
    db
      .select({ n: count() })
      .from(mailEvents)
      .where(
        and(
          eq(mailEvents.event, "burner_created"),
          eq(mailEvents.actorId, userId),
          gt(mailEvents.createdAt, now - ms),
        ),
      )
      .get()?.n ?? 0;

  if (since(3600_000) >= config.burnerPerHour) {
    return { ok: false, code: "rate_limit", error: `每小时最多开 ${config.burnerPerHour} 个，等一会儿` };
  }
  if (since(86400_000) >= config.burnerPerDay) {
    return { ok: false, code: "rate_limit", error: `今天已经开了 ${config.burnerPerDay} 个，明天再来` };
  }
  return null;
}

/**
 * 挑一个域名。
 *
 * 指定了就用指定的（但要过开关检查）；没指定就从**随机轮换**里挑。
 * 轮换里默认不放中文域名 —— 很多网站的注册表单直接拒收 IDN 邮箱，
 * 而一次性箱的全部用途就是去那些表单里注册。
 */
function pickDomain(options: { domain: string | null; needsCustom: boolean; bypass: boolean }) {
  if (options.domain) {
    const row = db
      .select()
      .from(mailDomains)
      .where(eq(mailDomains.domain, options.domain))
      .get();
    if (!row || !row.enabled) return null;
    if (!options.bypass) {
      if (!row.allowBurner) return null;
      if (options.needsCustom && !row.allowCustomLocal) return null;
    }
    return row;
  }

  const pool = db
    .select()
    .from(mailDomains)
    .where(
      and(
        eq(mailDomains.allowBurner, true),
        eq(mailDomains.enabled, true),
        eq(mailDomains.inRandomRotation, true),
        options.needsCustom ? eq(mailDomains.allowCustomLocal, true) : undefined,
      ),
    )
    .all();

  if (pool.length === 0) return null;
  return pool[randomBytes(1)[0] % pool.length];
}

/** 禁用词表。每次开箱读一遍 —— 表很小，而缓存一份意味着后台改完不立刻生效 */
function loadBanwords(): BanwordRule[] {
  return db
    .select({
      word: mailBanwords.word,
      kind: mailBanwords.kind,
      enabled: mailBanwords.enabled,
      reason: mailBanwords.reason,
    })
    .from(mailBanwords)
    .where(eq(mailBanwords.enabled, true))
    .all();
}

export interface ListBurnersOptions {
  userId: string;
  /**
   * 只列这把令牌自己开的。
   *
   * ★ `mail:burner` 那个 scope 的作用域收窄就靠这一条：
   * 一把泄漏的令牌的爆炸半径，是它自己造出来的那几个地址，
   * 而不是这个人的全部一次性箱。
   */
  tokenId?: string | null;
}

export function listBurners(options: ListBurnersOptions): BurnerView[] {
  const rows = db
    .select()
    .from(mailBoxes)
    .where(
      and(
        eq(mailBoxes.userId, options.userId),
        eq(mailBoxes.kind, "burner"),
        inArray(mailBoxes.status, MAIL_BOX_ALIVE_STATUSES),
        gt(mailBoxes.expiresAt, Date.now()),
        options.tokenId ? eq(mailBoxes.tokenId, options.tokenId) : undefined,
      ),
    )
    .orderBy(desc(mailBoxes.createdAt))
    .all();

  return rows.map(toView);
}

/**
 * 拿一个箱子，并确认它归这个人（以及这把令牌）。
 *
 * 归属检查放在**取数据这一层**，不放在调用方 ——
 * 放在调用方的话，每加一个接口就是一次漏掉它的机会，
 * 而漏掉的那一次是「别人能读你的验证码」。
 */
export function getOwnedBurner(
  id: string,
  options: { userId: string; tokenId?: string | null },
) {
  return db
    .select()
    .from(mailBoxes)
    .where(
      and(
        eq(mailBoxes.id, id),
        eq(mailBoxes.userId, options.userId),
        eq(mailBoxes.kind, "burner"),
        options.tokenId ? eq(mailBoxes.tokenId, options.tokenId) : undefined,
      ),
    )
    .get();
}

/**
 * 提前销毁 ——「用完就扔」的那个扔。
 *
 * 标成 `revoked` 而不是删行：`mail_messages` 和 `mail_events` 还引用着它，
 * 删了那些记录就成了孤儿，而「这个地址是谁开的」正是出事那天要问的。
 * 部分唯一索引把 `revoked` 排除在外，所以地址立刻可以重新发出去。
 */
export function destroyBurner(id: string, options: { userId: string; tokenId?: string | null }) {
  const box = getOwnedBurner(id, options);
  if (!box) return false;

  db.transaction((tx) => {
    tx.update(mailBoxes)
      .set({ status: "revoked", updatedAt: Date.now() })
      .where(eq(mailBoxes.id, id))
      .run();
    // 正文跟着走 —— 留着一个没人能打开的箱子里的邮件没有意义，只占盘
    tx.delete(mailMessages).where(eq(mailMessages.boxId, id)).run();
    tx.insert(mailEvents)
      .values({
        boxId: id,
        domain: box.domain,
        event: "burner_destroyed",
        actorId: options.userId,
        actorKind: options.tokenId ? "token" : "user",
        tokenId: options.tokenId ?? null,
      })
      .run();
  });

  return true;
}

export interface BurnerMessageView {
  id: string;
  from: string | null;
  fromName: string | null;
  subject: string | null;
  /** 抽出来的验证码。抽不出来是 null —— 不猜 */
  otpCode: string | null;
  preview: string | null;
  receivedAt: number;
  readAt: number | null;
  hasAttachments: boolean;
}

export function listBurnerMessages(boxId: string, options: { since?: number } = {}) {
  const rows = db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.boxId, boxId),
        isNull(mailMessages.purgedAt),
        options.since ? gt(mailMessages.receivedAt, options.since) : undefined,
      ),
    )
    .orderBy(desc(mailMessages.receivedAt))
    .all();

  return rows.map(
    (m): BurnerMessageView => ({
      id: m.id,
      from: m.fromAddr,
      fromName: m.fromName,
      subject: m.subject,
      otpCode: m.otpCode,
      preview: m.bodyText ? m.bodyText.slice(0, 200) : null,
      receivedAt: m.receivedAt,
      readAt: m.readAt,
      hasAttachments: m.hasAttachments,
    }),
  );
}

/**
 * 到期回收。挂在 health 那一轮里。
 *
 * 一次性箱**直接销毁，没有宽限期** —— 一次性就是一次性。
 * 长期箱那套宽限期是另一条路（MAIL.md 4.2）。
 */
export function reclaimExpiredBurners(now = Date.now()): number {
  const expired = db
    .select({ id: mailBoxes.id })
    .from(mailBoxes)
    .where(
      and(
        eq(mailBoxes.kind, "burner"),
        inArray(mailBoxes.status, ["active", "full"]),
        sql`${mailBoxes.expiresAt} IS NOT NULL AND ${mailBoxes.expiresAt} <= ${now}`,
      ),
    )
    .all();

  if (expired.length === 0) return 0;
  const ids = expired.map((r) => r.id);

  db.transaction((tx) => {
    tx.update(mailBoxes)
      .set({ status: "expired", updatedAt: now })
      .where(inArray(mailBoxes.id, ids))
      .run();
    tx.delete(mailMessages).where(inArray(mailMessages.boxId, ids)).run();
  });

  return ids.length;
}

function toView(row: typeof mailBoxes.$inferSelect): BurnerView {
  return {
    id: row.id,
    address: row.address,
    displayAddress: `${row.localPart}@${row.domain}`,
    domain: row.domain,
    localPart: row.localPart,
    custom: row.custom,
    expiresAt: row.expiresAt ?? 0,
    messageCount: row.messageCount,
    unreadCount: row.unreadCount,
    createdAt: row.createdAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code: unknown }).code).startsWith("SQLITE_CONSTRAINT")
  );
}
