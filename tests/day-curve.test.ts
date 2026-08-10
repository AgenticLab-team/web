import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

/**
 * 一天的活跃度曲线。
 *
 * ─────────────────────────────────────────
 * 它是导航，不是装饰
 * ─────────────────────────────────────────
 *
 * 线上最热闹的那天 1,274 条、48 个人。按天回看能落到那一天，
 * 落进去之后却是几十页 —— 「上周三那个讨论」还是得一页页找。
 *
 * 而真实的一天不是均匀的：白天零星几句，晚上某个话题突然炸出三百条。
 * 曲线的价值全在**每一格能点进去**：只画不能点的话，
 * 只是把「不知道讨论在哪」变成「知道在哪但还是够不着」。
 *
 * 所以下面最要紧的几条测的都是 `firstId` —— 那是可点性的全部依据。
 */

const TMP = mkdtempSync(join(tmpdir(), "al-curve-"));
process.env.DB_PATH = join(TMP, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
process.env.SITE_URL = "https://example.test";

describe("曲线", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { dayCurve } = await import("@/lib/messages/day-curve");

  after(() => rmSync(TMP, { recursive: true, force: true }));

  const CONV = "g@chatroom";
  const DATE = "2026-08-08";

  const reset = () => dbm.db.delete(schema.messages).run();

  /** 东八区当天某个时刻 */
  const at = (hour: number, minute = 0) => Date.UTC(2026, 7, 8, hour - 8, minute);

  let seq = 0;
  function msg(hour: number, minute = 0, over: { convId?: string; ts?: number } = {}) {
    const id = `m${String(++seq).padStart(4, "0")}`;
    dbm.db
      .insert(schema.messages)
      .values({
        id,
        convId: over.convId ?? CONV,
        senderWxId: "wx_a",
        type: "text",
        content: "内容",
        length: 10,
        ts: over.ts ?? at(hour, minute),
      })
      .run();
    return id;
  }

  it("**恒定 24 格** —— 只画有消息的小时，两天之间就没法比了", () => {
    reset();
    msg(9);
    const curve = dayCurve(CONV, DATE);
    assert.equal(curve.hours.length, 24);
    assert.deepEqual(
      curve.hours.map((h) => h.hour),
      Array.from({ length: 24 }, (_, i) => i),
    );
  });

  it("按小时数对", () => {
    reset();
    msg(9);
    msg(9, 30);
    msg(21);
    const curve = dayCurve(CONV, DATE);
    assert.equal(curve.hours[9].count, 2);
    assert.equal(curve.hours[21].count, 1);
    assert.equal(curve.hours[10].count, 0);
    assert.equal(curve.total, 3);
  });

  it("**firstId 是那个小时最早的一条** —— 点进去要落在开头，不是中间", () => {
    /*
     * 用的是 SQLite「min() 配裸列」那条保证。写错的话拿到的是
     * 分组里任意一行 —— 表现是点 22:00 落到 22:47，
     * 而 22:00 到 22:47 之间那几十条正是要找的开头。
     */
    reset();
    const first = msg(22, 5);
    msg(22, 30);
    msg(22, 50);
    const curve = dayCurve(CONV, DATE);
    assert.equal(curve.hours[22].firstId, first);
  });

  it("**插入顺序打乱也拿最早的那条**", () => {
    // 按时间倒着插 —— 拿 rowid 最小的那条会在这里翻车
    reset();
    const late = msg(14, 55);
    const mid = msg(14, 30);
    const early = msg(14, 1);
    const curve = dayCurve(CONV, DATE);
    assert.equal(curve.hours[14].firstId, early);
    assert.notEqual(curve.hours[14].firstId, late);
    assert.notEqual(curve.hours[14].firstId, mid);
  });

  it("**没有消息的小时 firstId 是 null** —— 那一格不该可点", () => {
    reset();
    msg(9);
    const curve = dayCurve(CONV, DATE);
    assert.equal(curve.hours[3].firstId, null);
    assert.equal(curve.hours[9].firstId !== null, true);
  });

  it("峰值小时", () => {
    reset();
    msg(9);
    msg(21);
    msg(21, 10);
    msg(21, 20);
    assert.equal(dayCurve(CONV, DATE).peakHour, 21);
  });

  it("**一条消息都没有时 peakHour 是 null** —— 不能把 0 点当成高峰", () => {
    reset();
    const curve = dayCurve(CONV, DATE);
    assert.equal(curve.peakHour, null);
    assert.equal(curve.total, 0);
    assert.equal(curve.hours.length, 24);
  });

  it("**日期边界按东八区切**", () => {
    /*
     * 少加 8 小时的话，凌晨那几条会落到前一天 ——
     * 而那种错要等到有人盯着曲线才看得出来。
     */
    reset();
    msg(0, 5); // 东八区当天 00:05
    msg(23, 55); // 东八区当天 23:55
    const curve = dayCurve(CONV, DATE);
    assert.equal(curve.total, 2, "凌晨或深夜那条被切到别的日期去了");
    assert.equal(curve.hours[0].count, 1);
    assert.equal(curve.hours[23].count, 1);
  });

  it("**前一天和后一天的消息不混进来**", () => {
    reset();
    msg(12);
    msg(0, 0, { ts: at(12) - 86_400_000 });
    msg(0, 0, { ts: at(12) + 86_400_000 });
    assert.equal(dayCurve(CONV, DATE).total, 1);
  });

  it("**别的群的消息不混进来**", () => {
    reset();
    msg(12);
    msg(12, 30, { convId: "other@chatroom" });
    assert.equal(dayCurve(CONV, DATE).total, 1);
  });
});

describe("接线", () => {
  const page = readFileSync(
    new URL("../src/app/(app)/archive/page.tsx", import.meta.url),
    "utf8",
  );
  const comp = readFileSync(
    new URL("../src/components/messages/DayCurve.tsx", import.meta.url),
    "utf8",
  );

  it("**每一格链到 ?m=<id>** —— 复用已有的定位，不另造一套", () => {
    /*
     * 那一套会算出页码、渲染那一页、高亮那一条并滚过去
     * （lib/messages/locate.ts）。自己再实现一遍跳转的话，
     * 两处对「第几页」的算法迟早分叉。
     */
    assert.match(comp, /new URLSearchParams\(\{ group, m: id \}\)/);
    assert.match(comp, /\/archive\?\$\{params\.toString\(\)\}/);
  });

  it("**排序要带过去** —— 丢掉的话点一下曲线就被打回默认排序", () => {
    assert.match(comp, /if \(order\) params\.set\("order", order\)/);
    assert.match(page, /order=\{carry\.order\}/);
  });

  it("**权限校验在算曲线之前** —— 越权请求不该先跑一遍聚合", () => {
    /*
     * messagesOfDay 那一句会 notFound。曲线放在它前面的话，
     * 一次越权请求仍然会算出那个群真实的一天形状。
     */
    const guard = page.indexOf("if (day_ === null) notFound();");
    const curve = page.indexOf("const curve = dayCurve(");
    assert.ok(guard > 0 && curve > 0);
    assert.ok(guard < curve, "曲线算在权限校验前面了");
  });

  it("**曲线在列表上面** —— 放下面的话人已经开始翻了才看见它", () => {
    /*
     * 找的是**渲染**那一处（`rows.map((message) =>`），
     * 不是随便一个 `rows.map` —— 页面上面还有两处
     * `rows.map` 是在取提及和回复上下文的 id，
     * 拿它们当锚点的话这条断言测的是别的东西。
     */
    const curveAt = page.indexOf("<DayCurve");
    const listAt = page.indexOf("rows.map((message)");
    assert.ok(curveAt > 0, "页面上没有渲染曲线");
    assert.ok(listAt > 0, "找不到消息列表的渲染处");
    assert.ok(curveAt < listAt, "曲线排在消息列表后面了");
  });

  it("**空格子不可点**，而且留着不删", () => {
    assert.match(comp, /if \(!h\.firstId\)/);
    assert.match(comp, /aria-hidden/);
  });

  it("**读屏软件读得出是哪个时段** —— 一串没有名字的链接等于没有", () => {
    assert.match(comp, /aria-label=\{`\$\{h\.hour\}:00，\$\{h\.count\} 条`\}/);
  });

  it("**一条消息都没有的一天不渲染空图**", () => {
    assert.match(comp, /if \(curve\.total === 0\) return null;/);
  });
});
