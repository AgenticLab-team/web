import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { sql } from "drizzle-orm";

/**
 * 一次性数据修复。
 *
 * ─────────────────────────────────────────
 * 修掉 bug 不等于坏数据自己变好
 * ─────────────────────────────────────────
 *
 * 线上 3831 行 `daily_stats` 里有 **19 行的 hour_histogram 是双重编码的**
 * ——「一个装着数组的字符串」。早期版本在冲突分支里又手动
 * JSON.stringify 了一次。
 *
 * 读的那一侧后来加了兜底：不是数组就当全 0。
 * 于是**那几天的小时分布被静默当成了零** —— 而数据其实还在，
 * 只是包了两层，解开一层就能完整还原。
 *
 * 「兜底不炸」和「数据还在不在」是两件事，
 * 而前者会让后者看起来已经解决了。
 */

describe("真库", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "al-repair-"));
  process.env.DB_PATH = join(tmp, "test.db");
  process.env.NEKOBOT_API_KEY = "nk_test";

  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { runRepairs, REPAIR_REASONS } = await import("@/lib/db/repairs");

  after(() => rmSync(tmp, { recursive: true, force: true }));

  /* 按 key 取，不按下标 —— 加一条修复就不该让别的测试红 */
  const fixedOf = (key: string) => runRepairs(dbm.db).find((r) => r.key === key)!.fixed;

  const reset = () => {
    dbm.db.delete(schema.dailyStats).run();
    dbm.db.delete(schema.notifications).run();
  };

  /** 直接写一行原始值，绕开 ORM 的序列化 —— 要造的正是「编码错了」的那种行 */
  const rawStats = (date: string, histogram: string) =>
    dbm.db.run(
      sql`INSERT INTO daily_stats (wx_id, conv_id, date, messages, quality_messages, chars_total, hour_histogram, updated_at)
          VALUES ('wx_a', 'g_a', ${date}, 5, 3, 100, ${histogram}, 0)`,
    );

  const histogramOf = (date: string) =>
    dbm.db.all<{ h: string }>(
      sql`SELECT hour_histogram AS h FROM daily_stats WHERE date = ${date}`,
    )[0]?.h;

  const hours = (n = 24) => Array.from({ length: n }, (_, i) => i);

  describe("**双重编码的小时分布**", () => {
    it("解开一层，完整还原", () => {
      reset();
      // 双重编码：先 stringify 数组，再把那个字符串当值 stringify 一次
      rawStats("2026-08-08", JSON.stringify(JSON.stringify(hours())));
      assert.equal(fixedOf("daily-stats-double-encoded-hours"), 1);
      assert.deepEqual(JSON.parse(histogramOf("2026-08-08")!), hours());
    });

    it("**正常的行不动**", () => {
      reset();
      rawStats("2026-08-09", JSON.stringify(hours()));
      assert.equal(fixedOf("daily-stats-double-encoded-hours"), 0);
      assert.deepEqual(JSON.parse(histogramOf("2026-08-09")!), hours());
    });

    it("**幂等** —— 跑第二遍不再匹配到任何行", () => {
      reset();
      rawStats("2026-08-08", JSON.stringify(JSON.stringify(hours())));
      assert.equal(fixedOf("daily-stats-double-encoded-hours"), 1);
      assert.equal(fixedOf("daily-stats-double-encoded-hours"), 0, "第二遍还在改，说明不幂等");
    });

    it("**形状不对就不动** —— 猜错比坏数据更糟", () => {
      /*
       * 一次猜错的批量写入比坏数据本身糟得多，
       * 因为坏数据至少还看得出是坏的。
       */
      reset();
      rawStats("2026-08-10", JSON.stringify(JSON.stringify([1, 2, 3]))); // 只有 3 个
      const before = histogramOf("2026-08-10");
      assert.equal(fixedOf("daily-stats-double-encoded-hours"), 0);
      assert.equal(histogramOf("2026-08-10"), before);
    });

    it("里面不是数字也不动", () => {
      reset();
      rawStats("2026-08-11", JSON.stringify(JSON.stringify(Array(24).fill("x"))));
      assert.equal(fixedOf("daily-stats-double-encoded-hours"), 0);
    });

    it("压根不是 JSON 也不炸", () => {
      reset();
      rawStats("2026-08-12", '"这不是 JSON');
      assert.equal(fixedOf("daily-stats-double-encoded-hours"), 0);
    });
  });

  describe("称号通知改签", () => {
    const notif = (type: string, title: string) =>
      dbm.db
        .insert(schema.notifications)
        .values({ userId: "u_a", type: type as "system", title, groupKey: `${type}:${title}` })
        .run();

    it("解锁称号改成 title", () => {
      reset();
      notif("system", "解锁称号「常客」");
      assert.equal(fixedOf("notification-title-type"), 1);
      const [row] = dbm.db.select().from(schema.notifications).all();
      assert.equal(row.type, "title");
    });

    it("**别的 system 通知不动** —— 「你的发言被整理成了帖子」要留在关不掉那一档", () => {
      reset();
      notif("system", "你在群里的发言被整理成了帖子");
      assert.equal(fixedOf("notification-title-type"), 0);
      assert.equal(dbm.db.select().from(schema.notifications).all()[0].type, "system");
    });

    it("幂等", () => {
      reset();
      notif("system", "解锁称号「常客」");
      assert.equal(fixedOf("notification-title-type"), 1);
      assert.equal(fixedOf("notification-title-type"), 0);
    });
  });

  describe("修复清单本身", () => {
    it("每条都写得出为什么", () => {
      // 「这段代码在修什么」半年后没人记得，而它每次启动都在跑
      for (const r of REPAIR_REASONS) {
        assert.ok(r.why.length > 20, `${r.key} 没说清楚`);
      }
    });

    it("**没有需要修的时候安安静静** —— fixed 全是 0", () => {
      reset();
      assert.ok(
        runRepairs(dbm.db).every((r) => r.fixed === 0),
        "没有需要修的时候还在改东西",
      );
    });
  });
});

describe("接线", () => {
  it("seed 里会跑，而且只报修了东西的那几条", () => {
    const seed = readFileSync(new URL("../src/lib/db/seed.ts", import.meta.url), "utf8");
    assert.match(seed, /runRepairs\(/);
    assert.match(seed, /filter\(\(r\) => r\.fixed > 0\)/);
  });

  it("**落库那一侧不再读回旧直方图** —— 双重编码读崩那一类从根上没有了", () => {
    /*
     * 原来的写法是「读回来 + 累加 + 写回去」，所以必须防着
     * 读到一个不是数组的东西（那个兜底就是这么来的）。
     *
     * 现在是从消息表重算再覆盖 —— **根本不读那一列**，
     * 于是不管库里存的是什么形状，下一次同步都会把它写正。
     * 这比加一层兜底强：兜底只是不炸，重算是真的修好。
     */
    const sync = readFileSync(new URL("../src/lib/sync/messages.ts", import.meta.url), "utf8");
    const flush = sync.slice(sync.indexOf("export function flushDailyStats"));
    assert.equal(flush.includes("hourHistogram as number[]"), false, "又去读回旧直方图了");
    assert.equal(flush.includes("previousHours"), false);
    assert.match(flush, /strftime\('%H'/);
  });

  it("**同步那一侧记的是「碰过哪些天」，不是「新写了几条」**", () => {
    /*
     * 这是那 26 条漏计数的根源：原来只有新写入的消息才进桶，
     * 于是一条「上一轮写进去、没来得及统计」的消息，
     * 这一轮会被主键冲突跳过，缺口永远补不上。
     *
     * 现在记 key 的那一句在 `changes === 0` 判断**之前**。
     */
    const sync = readFileSync(new URL("../src/lib/sync/messages.ts", import.meta.url), "utf8");
    const touchAt = sync.indexOf("touched.add(");
    const skipAt = sync.indexOf("if (result.changes === 0) continue;");
    assert.ok(touchAt > 0 && skipAt > 0);
    assert.ok(touchAt < skipAt, "记「碰过」跑到跳过判断后面去了 —— 缺口补不上");
  });
});
