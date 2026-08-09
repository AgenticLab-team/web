import "server-only";

import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { processLeases } from "@/lib/db/schema";

/**
 * 「这件事此刻归谁跑」。
 *
 * ─────────────────────────────────────────
 * 蓝绿部署会让两个实例同时活着
 * ─────────────────────────────────────────
 *
 * 为了能瞬间回切，切换之后老的那一边**不停**。于是同一时刻有两个
 * 进程连着同一个库，而通知轮询器是每个进程各起一个的。
 *
 * 轮询本身只读，重复跑不要紧。要紧的是它后面挂着的**推送派发**：
 * 派发状态全在内存里（每个用户攒了几条、上次发在什么时候），
 * 两个进程各攒各的 —— **同一条通知会被推两遍**。
 *
 * ─────────────────────────────────────────
 * 为什么是租约
 * ─────────────────────────────────────────
 *
 * 另一条路是「让待机那边别跑」，但那要让进程知道自己是不是待机的 ——
 * 而那个答案在 nginx 的配置文件里，应用不该去读它，
 * 更不该在 nginx 改了之后还以为自己是主。
 *
 * 租约不需要任何人告诉它谁是主：**抢到的就跑，抢不到的就歇着**。
 * 持有者死了之后租约过期，另一边自动接手。
 * 部署、崩溃、手动重启、机器重启，走的都是同一条路。
 */

/**
 * 这个进程的标识。
 *
 * **不用 pid**：pid 会被系统回收，一个刚起来的进程完全可能拿到
 * 上一个死掉的进程的号 —— 那样它会「继承」一份不属于它的租约，
 * 而这正是租约要防的事。
 */
const HOLDER = `${process.pid}-${randomBytes(6).toString("hex")}`;

export function holderId(): string {
  return HOLDER;
}

/**
 * 抢一次租约（或者续一次）。
 *
 * ─────────────────────────────────────────
 * 抢和续是**同一条语句**
 * ─────────────────────────────────────────
 *
 * 分成「先查再写」两步的话，两个进程可能同时查到「过期了」，
 * 然后都去写 —— 两个都以为自己抢到了。这种竞态在测试里几乎撞不出来，
 * 而线上正好在部署那一刻（两个实例都在跑）最容易发生。
 *
 * 这条 upsert 的 WHERE 让 SQLite 在同一次写锁里做完判断：
 * 只有「没人持有 / 已经过期 / 本来就是我」三种情况才改得动，
 * 改不动就是 `changes === 0`，也就是没抢到。
 */
export function acquireLease(name: string, ttlMs: number, now = Date.now()): boolean {
  const expiresAt = now + ttlMs;
  const result = db
    .insert(processLeases)
    .values({ name, holder: HOLDER, expiresAt, updatedAt: now })
    .onConflictDoUpdate({
      target: processLeases.name,
      set: { holder: HOLDER, expiresAt, updatedAt: now },
      where: sql`${processLeases.expiresAt} <= ${now} OR ${processLeases.holder} = ${HOLDER}`,
    })
    .run();

  return result.changes > 0;
}

/**
 * 主动放手。
 *
 * 进程正常退出时叫一下，另一边就不用等租约过期 ——
 * 一次部署省下的这十几秒，正好是推送最不该停的那十几秒。
 *
 * **只删自己的**：删别人的等于把主权抢过来又扔掉。
 */
export function releaseLease(name: string): void {
  db.delete(processLeases)
    .where(sql`${processLeases.name} = ${name} AND ${processLeases.holder} = ${HOLDER}`)
    .run();
}

/** 现在谁持有 —— 后台要能回答「推送是哪个实例在发」 */
export function leaseHolder(name: string, now = Date.now()): string | null {
  const row = db
    .select()
    .from(processLeases)
    .where(sql`${processLeases.name} = ${name} AND ${processLeases.expiresAt} > ${now}`)
    .get();
  return row?.holder ?? null;
}

/** 通知轮询器的租约名 */
export const NOTIFICATIONS_LEASE = "notifications";

/**
 * 租约有效期。
 *
 * 轮询是 3 秒一轮，所以每一轮都会续一次 —— 15 秒意味着要连续
 * **五轮**都没续上才会被别人抢走。一次 GC 停顿或者一次慢查询
 * 不至于让主权来回跳，而真的死掉时另一边最多等 15 秒接手。
 */
export const LEASE_TTL_MS = 15_000;
