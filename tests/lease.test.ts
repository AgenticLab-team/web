import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { stripComments as strip } from "./_source";

/**
 * 进程租约。
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
 * 线上现在没配 VAPID，所以今天推不出去。这是个定时炸弹，
 * 不是眼前的故障 —— 但它会在「刚配好推送、正高兴」的那一刻炸。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("真库", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "al-lease-"));
  process.env.DB_PATH = join(tmp, "test.db");
  process.env.NEKOBOT_API_KEY = "nk_test";

  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const lease = await import("@/lib/runtime/lease");

  after(() => rmSync(tmp, { recursive: true, force: true }));

  const NOW = 1_800_000_000_000;
  const reset = () => dbm.db.delete(schema.processLeases).run();

  /**
   * 冒充「另一个进程」。
   *
   * 真起第二个 Node 进程来测太重，而这里要验的是**同一个库上的竞态**——
   * 直接写一行别人持有的租约，效果一样。
   */
  const otherHolds = (name: string, until: number) =>
    dbm.db
      .insert(schema.processLeases)
      .values({ name, holder: "另一个进程", expiresAt: until, updatedAt: NOW })
      .onConflictDoUpdate({
        target: schema.processLeases.name,
        set: { holder: "另一个进程", expiresAt: until },
      })
      .run();

  it("没人持有时抢得到", () => {
    reset();
    assert.equal(lease.acquireLease("x", 15_000, NOW), true);
  });

  it("**别人正持有时抢不到**", () => {
    reset();
    otherHolds("x", NOW + 10_000);
    assert.equal(lease.acquireLease("x", 15_000, NOW), false);
  });

  it("别人的租约过期之后抢得到", () => {
    reset();
    otherHolds("x", NOW - 1);
    assert.equal(lease.acquireLease("x", 15_000, NOW), true);
    assert.equal(lease.leaseHolder("x", NOW), lease.holderId());
  });

  it("**自己持有时续得上** —— 抢和续是同一条语句", () => {
    reset();
    assert.equal(lease.acquireLease("x", 15_000, NOW), true);
    assert.equal(lease.acquireLease("x", 15_000, NOW + 1_000), true, "自己续不上就等于每轮都在丢主权");
  });

  it("续约真的把到期时间往后推了", () => {
    reset();
    lease.acquireLease("x", 15_000, NOW);
    lease.acquireLease("x", 15_000, NOW + 10_000);
    // 原来的到期是 NOW+15000，续过之后应该活到 NOW+25000
    assert.equal(lease.leaseHolder("x", NOW + 20_000), lease.holderId());
  });

  it("**过了期就不再算持有** —— 哪怕行还在", () => {
    reset();
    lease.acquireLease("x", 15_000, NOW);
    assert.equal(lease.leaseHolder("x", NOW + 15_001), null);
  });

  it("不同名字互不干扰", () => {
    reset();
    otherHolds("a", NOW + 10_000);
    assert.equal(lease.acquireLease("b", 15_000, NOW), true);
  });

  it("**放手只放自己的**", () => {
    reset();
    otherHolds("x", NOW + 10_000);
    lease.releaseLease("x");
    assert.equal(lease.leaseHolder("x", NOW), "另一个进程", "把别人的租约删了");
  });

  it("放手之后别人立刻抢得到 —— 不用空等一个 TTL", () => {
    reset();
    lease.acquireLease("x", 15_000, NOW);
    lease.releaseLease("x");
    assert.equal(lease.leaseHolder("x", NOW), null);
  });

  it("**主权能流动**：持有者不再续，另一边接手", () => {
    /*
     * 这是部署时真正发生的事：老实例被停掉，租约到期，
     * 新实例接手 —— 不需要任何人去通知它。
     */
    reset();
    otherHolds("x", NOW + 15_000);
    assert.equal(lease.acquireLease("x", 15_000, NOW), false, "还没到期就抢走了");
    assert.equal(lease.acquireLease("x", 15_000, NOW + 15_001), true, "到期了却接不了手");
  });
});

describe("**接线**", () => {
  const live = strip(src("lib/notifications/live.ts"));

  it("轮询前先抢租约", () => {
    assert.match(live, /if \(!acquireLease\(NOTIFICATIONS_LEASE, LEASE_TTL_MS\)\) return;/);
  });

  it("**抢在每一轮里，不是启动时抢一次**", () => {
    /*
     * 启动时抢一次的话，主权就固定在先起来的那个进程上 ——
     * 而它被停掉之后没有人接手，推送从此不再发出，
     * 且没有任何地方会报错。
     */
    // 锚在赋值上，不是 `setInterval` 这个词 —— 类型标注里也有它
    const tick = live.slice(live.indexOf("s.timer = setInterval("));
    assert.match(tick, /acquireLease/);
  });

  it("停的时候主动放手", () => {
    assert.match(live, /releaseLease\(NOTIFICATIONS_LEASE\)/);
  });

  it("**放手失败不能把停止流程带崩**", () => {
    const stop = live.slice(live.indexOf("export function stopWatcher"));
    assert.match(stop, /try \{[\s\S]{0,200}releaseLease[\s\S]{0,200}\} catch/);
  });

  it("**进程标识不是 pid** —— pid 会被回收", () => {
    /*
     * 一个刚起来的进程完全可能拿到上一个死掉的进程的号，
     * 那样它会「继承」一份不属于它的租约 —— 而这正是租约要防的事。
     */
    const code = strip(src("lib/runtime/lease.ts"));
    assert.match(code, /randomBytes/);
  });

  it("**抢和续是一条 upsert，不是先查再写**", () => {
    /*
     * 分两步的话，两个进程可能同时查到「过期了」然后都去写，
     * 两个都以为自己抢到了。这种竞态在测试里几乎撞不出来，
     * 而线上正好在部署那一刻最容易发生。
     */
    const code = strip(src("lib/runtime/lease.ts"));
    assert.match(code, /onConflictDoUpdate/);
    assert.match(code, /where: sql`/);
    assert.equal(/const existing = db\s*\n?\s*\.select/.test(code), false, "又变成先查再写了");
  });
});
