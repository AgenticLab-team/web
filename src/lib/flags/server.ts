import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { notFound } from "next/navigation";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { featureFlags, roles, userRoles } from "@/lib/db/schema";

import {
  FLAG_KEYS,
  FLAGS,
  defaultEnabled,
  evaluate,
  specOf,
  type FlagRow,
  type FlagSpec,
  type Rollout,
} from "./registry";

/**
 * 功能开关的服务端。
 *
 * ─────────────────────────────────────────
 * 拦在页面里，不只是藏导航
 * ─────────────────────────────────────────
 *
 * 只把导航项藏起来的话，地址栏里敲一下照样进得去 ——
 * 那不是开关，是把门牌摘了。所以每个被管着的页面第一行就调
 * `requireFeature()`，关掉之后是干干净净的 404。
 *
 * 给 404 而不是「此功能已关闭」：后者会告诉不该知道的人
 * 「这里本来有个东西」，而关模块的场景里，往往正是不想让人来试。
 *
 * ─────────────────────────────────────────
 * 状态码会是 200，而页面内容是 404 —— 这不是坏了
 * ─────────────────────────────────────────
 *
 * `(app)` 下有 `loading.tsx`，于是外壳会先流式发出去，
 * **响应头在 `notFound()` 抛出之前就已经写好了**。
 * proxy.ts 顶上那段注释记的是同一件事的另一半
 * （`redirect()` 在有 loading.tsx 的路由下也会退化成客户端跳转）。
 *
 * 那边能靠中间件解决，这边不能：判定要读数据库，而中间件读不到。
 *
 * 实际影响只在爬虫和监控的口径上 —— 生产上验过，关掉之后
 * 页面里**一条真实内容都不剩**（版块名、帖子标题、发帖按钮全为 0），
 * 用户看到的就是一个 404 页。保证在内容那一层，不在状态码那一层。
 */

let cache: Map<string, FlagRow> | null = null;

export function invalidateFlagCache() {
  cache = null;
}

function load(): Map<string, FlagRow> {
  if (cache) return cache;
  const rows = db
    .select({
      key: featureFlags.key,
      enabled: featureFlags.enabled,
      rollout: featureFlags.rollout,
      rolloutValue: featureFlags.rolloutValue,
    })
    .from(featureFlags)
    .all();
  cache = new Map(rows.map((r) => [r.key, { ...r, rollout: r.rollout as Rollout }]));
  return cache;
}

/** 这个人持有哪些身份组的 key —— 按身份灰度时要用 */
function roleKeysOf(userId: string | null): string[] {
  if (!userId) return [];
  return db
    .select({ key: roles.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.userId, userId), isNull(userRoles.revokedAt)))
    .all()
    .map((r) => r.key);
}

/**
 * 这个功能对这个人开着吗。
 *
 * 不传 user 就是问「对所有人开着吗」—— 只有 rollout=all 才算。
 */
export function featureEnabled(key: string, user?: CurrentUser | null): boolean {
  const row = load().get(key);
  return evaluate(row, { userId: user?.id ?? null, roleKeys: roleKeysOf(user?.id ?? null) }, key);
}

/**
 * 页面开头调这一句。关着就 404。
 *
 * **管理员也一样挡** —— 一个「只有我看得见」的关闭状态，
 * 意味着关掉之后站长自己看到的仍然是正常的，
 * 而他没法确认这一关到底生效没有。真要验，就该看到和别人一样的东西。
 */
export function requireFeature(key: string, user?: CurrentUser | null): void {
  if (!featureEnabled(key, user)) notFound();
}

export interface FlagAdminRow extends FlagSpec {
  enabled: boolean;
  rollout: Rollout;
  rolloutValue: unknown;
  updatedAt: number | null;
  updatedBy: string | null;
  /** 库里没有这一行 —— 走的是清单里的默认值 */
  missing: boolean;
}

/**
 * 后台那一页要看的全部。
 *
 * 以**清单**为准列出来，不是以库为准：库里少一行的话，
 * 按库列就会让那个开关从后台消失，而它其实正按默认值生效着。
 */
export function listFlagsForAdmin(): FlagAdminRow[] {
  const rows = db.select().from(featureFlags).all();
  const byKey = new Map(rows.map((r) => [r.key, r]));

  return FLAGS.map((spec) => {
    const row = byKey.get(spec.key);
    return {
      ...spec,
      enabled: row?.enabled ?? defaultEnabled(spec.key),
      rollout: (row?.rollout ?? "all") as Rollout,
      rolloutValue: row?.rolloutValue ?? null,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
      missing: !row,
    };
  });
}

/**
 * 库里有、清单里没有的那些。
 *
 * 它们**不生效**（判定只认清单），所以要在后台说出来 ——
 * 否则一个改过之后什么都没发生的开关会让人怀疑整个机制。
 */
export function orphanFlagKeys(): string[] {
  return db
    .select({ key: featureFlags.key })
    .from(featureFlags)
    .all()
    .map((r) => r.key)
    .filter((k) => !FLAG_KEYS.includes(k));
}

export { specOf };
