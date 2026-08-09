import "server-only";

import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";

import { db } from "@/lib/db";
import { titles, userTitles, users } from "@/lib/db/schema";
import { notify } from "@/lib/forum/notify";
import { grantPoints } from "@/lib/points/ledger";
import { achievementStats } from "@/lib/titles/queries";
import { meetsCondition, renewalExpiry, type TitleSpec } from "@/lib/titles/rules";

/**
 * 称号的结算任务。
 *
 * ─────────────────────────────────────────
 * 这一整块之前是死的
 * ─────────────────────────────────────────
 *
 * `meetsCondition`、`achievementStats`、`renewalExpiry`、`isTitleExpired`
 * 四个函数写好了、有测试、看起来很完整 —— 而**没有任何地方调用它们**。
 * 也就是说 builtin 里那五个成就称号，谁也拿不到。
 *
 * 更糟的是称号架的空状态还写着「连续打卡、在论坛发帖和回复都会解锁」——
 * 一句系统兑现不了的承诺。这个任务就是去兑现它。
 *
 * ─────────────────────────────────────────
 * 续费默认不扣钱
 * ─────────────────────────────────────────
 *
 * 租用型称号到期时**默认就是过期**，不自动扣费。
 * 一个默认开着的自动续费，会在某人早就不用这个称号的时候每月悄悄扣掉
 * 三百分 —— 而积分是这个站里唯一的硬通货，悄悄少掉的分
 * 会毁掉所有人对它的信任。
 *
 * 想续的人自己在称号架上打开开关，那时候扣费才是他要的结果。
 */

export interface SettleResult {
  /** 新授予的成就称号数 */
  granted: number;
  /** 到期摘下的 */
  expired: number;
  /** 自动续费成功的 */
  renewed: number;
  /** 想续但分不够的 */
  renewFailed: number;
  /** 发出去的到期提醒 */
  reminded: number;
  details: string[];
}

/** 提前几天提醒续费 —— 到期当天才说，人已经来不及决定了 */
export const REMIND_BEFORE_MS = 3 * 86_400_000;

// ── 成就授予 ────────────────────────────────────────────────

/**
 * 给一个人补齐他已经达成的成就称号。
 *
 * 幂等：已经持有的不重复授予（靠唯一索引兜底，但这里先查一遍
 * 是为了不产生一堆无意义的冲突写入）。
 */
export function grantAchievementsFor(userId: string, now = Date.now()): string[] {
  const specs = db
    .select()
    .from(titles)
    .where(and(eq(titles.source, "achievement"), eq(titles.enabled, true)))
    .all();
  if (specs.length === 0) return [];

  const held = new Set(
    db
      .select({ titleId: userTitles.titleId })
      .from(userTitles)
      .where(and(eq(userTitles.userId, userId), isNull(userTitles.revokedAt)))
      .all()
      .map((r) => r.titleId),
  );

  const pending = specs.filter((spec) => !held.has(spec.id));
  if (pending.length === 0) return [];

  // 统计一次就够 —— 每个称号查一遍是这一段最容易写出的 N+1
  const stats = achievementStats(userId);
  const granted: string[] = [];

  for (const spec of pending) {
    if (!meetsCondition(spec as unknown as TitleSpec & { conditionKind: string | null; conditionValue: number | null }, stats)) {
      continue;
    }

    const inserted = db
      .insert(userTitles)
      .values({
        userId,
        titleId: spec.id,
        source: "achievement",
        grantReason: `达成条件：${spec.conditionKind} ≥ ${spec.conditionValue}`,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();

    if (inserted.changes === 0) continue;
    granted.push(spec.name);

    /*
     * 拿到成就要有人告诉他。
     * 一个悄悄出现在个人页里的称号，等于没有发生过 ——
     * 而成就的全部作用就是被看见的那一刻。
     */
    notify({
      userId,
      type: "system",
      groupKey: `title:${spec.id}`,
      title: `解锁称号「${spec.name}」`,
      body: spec.description ?? undefined,
      link: "/me",
      refType: "title",
      refId: spec.id,
    });
  }

  return granted;
}

// ── 到期与续费 ──────────────────────────────────────────────

interface ExpiringRow {
  id: string;
  userId: string;
  titleId: string;
  expiresAt: number | null;
  autoRenew: boolean;
  renewNotifiedAt: number | null;
  activeTitleId: string | null;
  points: number;
  titleName: string;
  price: number | null;
  rentDays: number | null;
}

function expiringRows(before: number): ExpiringRow[] {
  return db
    .select({
      id: userTitles.id,
      userId: userTitles.userId,
      titleId: userTitles.titleId,
      expiresAt: userTitles.expiresAt,
      autoRenew: userTitles.autoRenew,
      renewNotifiedAt: userTitles.renewNotifiedAt,
      activeTitleId: users.activeTitleId,
      points: users.points,
      titleName: titles.name,
      price: titles.price,
      rentDays: titles.rentDays,
    })
    .from(userTitles)
    .innerJoin(users, eq(users.id, userTitles.userId))
    .innerJoin(titles, eq(titles.id, userTitles.titleId))
    .where(
      and(
        isNull(userTitles.revokedAt),
        isNotNull(userTitles.expiresAt),
        lte(userTitles.expiresAt, before),
      ),
    )
    .all();
}

export function settleTitles(now = Date.now()): SettleResult {
  const result: SettleResult = {
    granted: 0,
    expired: 0,
    renewed: 0,
    renewFailed: 0,
    reminded: 0,
    details: [],
  };

  // ① 快到期的先提醒 —— 到期当天才说，人已经来不及决定了
  for (const row of expiringRows(now + REMIND_BEFORE_MS)) {
    if (row.expiresAt !== null && row.expiresAt <= now) continue; // 已经过期的走下面
    if (row.renewNotifiedAt !== null) continue;

    const days = Math.max(1, Math.ceil(((row.expiresAt ?? now) - now) / 86_400_000));
    notify({
      userId: row.userId,
      type: "system",
      groupKey: `title-expiry:${row.id}`,
      title: `称号「${row.titleName}」${days} 天后到期`,
      body: row.autoRenew
        ? `到期会自动续费 ${row.price ?? 0} 分`
        : `到期后会自动摘下。想留着的话去个人页打开自动续费`,
      link: "/me",
      refType: "title",
      refId: row.titleId,
    });

    db.update(userTitles)
      .set({ renewNotifiedAt: now })
      .where(eq(userTitles.id, row.id))
      .run();
    result.reminded++;
  }

  // ② 已经到期的
  for (const row of expiringRows(now)) {
    if (row.autoRenew && row.price !== null && row.rentDays !== null) {
      const charged = tryRenew(row, now);
      if (charged) {
        result.renewed++;
        result.details.push(`续费「${row.titleName}」-${row.price} 分`);
        continue;
      }
      result.renewFailed++;
      result.details.push(`「${row.titleName}」续费失败：分不够`);
    }

    expireOne(row);
    result.expired++;
  }

  return result;
}

function tryRenew(row: ExpiringRow, now: number): boolean {
  if (row.price === null) return false;
  /*
   * 余额不够就**不扣**，让它过期。
   * 扣成负数看起来只是个数字，实际上是让人背上一笔他没同意的债 ——
   * 而下一次签到拿到的分会先去还这笔债，他会以为签到没生效。
   */
  if (row.points < row.price) return false;

  const grant = grantPoints({
    userId: row.userId,
    delta: -row.price,
    ruleKey: "title.renew",
    reason: `自动续费称号「${row.titleName}」`,
    refType: "title",
    refId: row.titleId,
    idempotencyKey: `title-renew:${row.id}:${row.expiresAt}`,
  });
  if (!grant.ok) return false;

  db.update(userTitles)
    .set({
      expiresAt: renewalExpiry(row.expiresAt, { rentDays: row.rentDays } as TitleSpec, now),
      renewNotifiedAt: null,
    })
    .where(eq(userTitles.id, row.id))
    .run();

  notify({
    userId: row.userId,
    type: "system",
    groupKey: `title-renewed:${row.id}:${row.expiresAt}`,
    title: `称号「${row.titleName}」已自动续费`,
    body: `扣了 ${row.price} 分。不想续了可以在个人页关掉自动续费`,
    link: "/me",
    refType: "title",
    refId: row.titleId,
  });
  return true;
}

function expireOne(row: ExpiringRow): void {
  /*
   * 过期不删记录，只是不再 active（isTitleActive 已经按 expiresAt 判）。
   * 「我曾经拿到过」也是履历 —— 直接删掉会让人以为系统弄丢了自己的东西。
   *
   * 但**佩戴中的要摘下来**：一个已经过期却还挂在名字后面的称号，
   * 是在对所有看到它的人说谎。
   */
  if (row.activeTitleId === row.titleId) {
    db.update(users)
      .set({ activeTitleId: null })
      .where(eq(users.id, row.userId))
      .run();
  }

  notify({
    userId: row.userId,
    type: "system",
    groupKey: `title-expired:${row.id}`,
    title: `称号「${row.titleName}」已到期`,
    body:
      row.autoRenew && row.price !== null
        ? `想自动续费但积分不够（需要 ${row.price} 分），已摘下`
        : "已从名字后面摘下。记录还留着，随时可以再拿一次",
    link: "/me",
    refType: "title",
    refId: row.titleId,
  });
}

// ── 全量结算 ────────────────────────────────────────────────

/**
 * 跑一轮完整结算。
 *
 * 成就只扫**最近活跃过的人**：全站扫一遍在两万人的时候要跑很久，
 * 而一个三个月没来的人这段时间里不可能新达成任何条件。
 */
export function settleAll(options: { now?: number; activeSince?: number } = {}): SettleResult {
  const now = options.now ?? Date.now();
  const activeSince = options.activeSince ?? now - 30 * 86_400_000;

  const result = settleTitles(now);

  const candidates = db
    .select({ id: users.id, lastActiveAt: users.lastActiveAt })
    .from(users)
    .where(eq(users.status, "active"))
    .all()
    .filter((u) => (u.lastActiveAt ?? 0) >= activeSince);

  for (const user of candidates) {
    const granted = grantAchievementsFor(user.id, now);
    result.granted += granted.length;
    for (const name of granted) result.details.push(`授予「${name}」`);
  }

  return result;
}
