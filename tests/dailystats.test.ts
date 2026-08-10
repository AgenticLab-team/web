import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 每日统计的落库。
 *
 * ─────────────────────────────────────────
 * 从累加改成重算
 * ─────────────────────────────────────────
 *
 * 原来是「这一轮新写了 N 条 → 在原数字上 +N」。累加有一个
 * **注定会发生**的漏洞：消息写进去之后、统计落库之前那一轮失败了，
 * 重跑时消息因为主键冲突被跳过，于是那几条**永远不会被计入**。
 *
 * 线上对照下来 `daily_stats` 比 `messages` 少 26 条、14 个人对不上 ——
 * 而榜单是按这张表排的。
 *
 * 现在改成：记下这一轮碰过哪些「人 × 天」，然后拿那几天**从消息表重算**。
 * 重算是幂等的 —— 同一轮跑两遍、失败之后重跑，结果都一样。
 *
 * 这一层必须做真实的数据库往返：曾经有个 bug 是 json 列被手动
 * JSON.stringify 了一次，双重编码后读回来是字符串不是数组，
 * 增量同步一碰到已存在的行就抛 `map is not a function`。
 * 纯函数测试完全抓不到这种问题。
 */

// 必须在 import 任何用到 env 的模块之前设置
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "al-test-")), "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");
type SyncModule = typeof import("@/lib/sync/messages");

let dbm: DbModule;
let schema: SchemaModule;
let sync: SyncModule;
let bucketKey: (wxId: string, date: string) => string;

const CONV = "test@chatroom";
const WX = "wxid_test";
const DATE = "2026-08-08";

/** 东八区 2026-08-08 那一天的某个小时 */
const at = (hour: number, minute = 0) =>
  Date.UTC(2026, 7, 8, hour - 8, minute) as number;

let seq = 0;
/** 往消息表写一条真消息 —— 统计现在是从它算出来的 */
function message(over: {
  hour: number;
  quality?: boolean;
  length?: number;
  isSend?: boolean;
  wxId?: string;
} ) {
  dbm.db
    .insert(schema.messages)
    .values({
      id: `m${++seq}`,
      convId: CONV,
      senderWxId: over.wxId ?? WX,
      isSend: over.isSend ?? false,
      type: "text",
      content: "内容",
      length: over.length ?? 20,
      isQuality: over.quality ?? false,
      ts: at(over.hour),
    })
    .run();
}

const touched = (wxId = WX, date = DATE) => new Set([bucketKey(wxId, date)]);
const row = () => dbm.db.select().from(schema.dailyStats).get();

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  sync = await import("@/lib/sync/messages");
  bucketKey = sync.bucketKey;
});

after(() => {
  rmSync(join(process.env.DB_PATH!, ".."), { recursive: true, force: true });
});

beforeEach(() => {
  dbm.db.delete(schema.dailyStats).run();
  dbm.db.delete(schema.messages).run();
});

describe("每日统计落库", () => {
  it("小时分布读回来是数组，不是字符串", () => {
    message({ hour: 3 });
    message({ hour: 3 });
    sync.flushDailyStats(CONV, touched());

    const r = row();
    assert.ok(r, "应该写入了一行");
    assert.ok(Array.isArray(r.hourHistogram), "小时分布必须是数组，不能是字符串");
    assert.equal((r.hourHistogram as number[])[3], 2);
    assert.equal((r.hourHistogram as number[]).length, 24);
  });

  it("**跑两遍结果一样** —— 这正是累加做不到的", () => {
    message({ hour: 3 });
    message({ hour: 3 });
    sync.flushDailyStats(CONV, touched());
    sync.flushDailyStats(CONV, touched());

    assert.equal(row()!.messages, 2, "跑两遍变成了 4 —— 又变回累加了");
  });

  it("**消息表是唯一真相** —— 后来补进去的消息重算就能补上", () => {
    /*
     * 这就是线上那 26 条的形状：消息写进去了、统计没跟上。
     * 重算能补，累加补不了（那些消息下一轮会被主键冲突跳过）。
     */
    message({ hour: 3 });
    sync.flushDailyStats(CONV, touched());
    assert.equal(row()!.messages, 1);

    message({ hour: 5 });
    sync.flushDailyStats(CONV, touched());
    assert.equal(row()!.messages, 2);
    assert.equal((row()!.hourHistogram as number[])[5], 1);
  });

  it("高质量单独数", () => {
    message({ hour: 1, quality: true });
    message({ hour: 1, quality: false });
    sync.flushDailyStats(CONV, touched());
    assert.equal(row()!.messages, 2);
    assert.equal(row()!.qualityMessages, 1);
  });

  it("字数是求和", () => {
    message({ hour: 1, length: 30 });
    message({ hour: 1, length: 12 });
    sync.flushDailyStats(CONV, touched());
    assert.equal(row()!.charsTotal, 42);
  });

  it("首末时间是极值", () => {
    message({ hour: 9 });
    message({ hour: 21 });
    message({ hour: 14 });
    sync.flushDailyStats(CONV, touched());
    assert.equal(row()!.firstMsgAt, at(9));
    assert.equal(row()!.lastMsgAt, at(21));
  });

  it("不同小时互不干扰", () => {
    message({ hour: 3 });
    message({ hour: 20 });
    message({ hour: 20 });
    sync.flushDailyStats(CONV, touched());
    const hist = row()!.hourHistogram as number[];
    assert.equal(hist[3], 1);
    assert.equal(hist[20], 2);
    assert.equal(hist.reduce((a, b) => a + b, 0), 3);
  });

  it("**机器人自己的消息不算** —— 口径要和采集那一侧一致", () => {
    message({ hour: 3 });
    message({ hour: 3, isSend: true });
    sync.flushDailyStats(CONV, touched());
    assert.equal(row()!.messages, 1, "把机器人的消息也算进榜了");
  });

  it("**别人的消息不混进来**", () => {
    message({ hour: 3 });
    message({ hour: 3, wxId: "wxid_other" });
    sync.flushDailyStats(CONV, touched());
    const mine = dbm.db.select().from(schema.dailyStats).all().find((r) => r.wxId === WX);
    assert.equal(mine!.messages, 1);
  });

  it("**日期边界按东八区切** —— 少加 8 小时的话凌晨那几条会落到前一天", () => {
    /*
     * 这种错要等到有人盯着热力图才看得出来，
     * 而那时候已经攒了几个月的错数据。
     */
    message({ hour: 0, });
    message({ hour: 23 });
    sync.flushDailyStats(CONV, touched());
    assert.equal(row()!.messages, 2, "凌晨或深夜那条被切到别的日期去了");
    const hist = row()!.hourHistogram as number[];
    assert.equal(hist[0], 1);
    assert.equal(hist[23], 1);
  });

  it("那一天一条消息都没有时不写空行", () => {
    sync.flushDailyStats(CONV, touched());
    assert.equal(dbm.db.select().from(schema.dailyStats).all().length, 0);
  });

  it("空集合直接返回", () => {
    message({ hour: 1 });
    sync.flushDailyStats(CONV, new Set());
    assert.equal(dbm.db.select().from(schema.dailyStats).all().length, 0);
  });
});
