import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * 每日统计的落库测试。
 *
 * 这一层必须做真实的数据库往返 —— 曾经有个 bug 是 json 模式的列被手动
 * JSON.stringify 了一次（Drizzle 本来就会序列化），双重编码后读回来是
 * 字符串不是数组，增量同步一碰到已存在的行就抛 `map is not a function`。
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

function bucket(hours: number[], messages: number, quality: number) {
  return new Map([
    [
      // 必须用生产代码的同一个键构造函数。早期测试里写成 `${WX} ${DATE}`
      // （普通空格），而生产用的是 NUL 分隔符，于是拆不出日期、
      // 插入时 date 为 null，报出一个跟真实缺陷毫无关系的 NOT NULL 错误。
      bucketKey(WX, DATE),
      {
        messages,
        qualityMessages: quality,
        charsTotal: messages * 20,
        firstMsgAt: 1_786_000_000_000,
        lastMsgAt: 1_786_000_100_000,
        hours,
      },
    ],
  ]);
}

function hoursWith(index: number, value: number) {
  const arr = new Array(24).fill(0);
  arr[index] = value;
  return arr;
}

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

describe("每日统计落库", () => {
  it("首次写入后小时分布读回来是数组", () => {
    sync.flushDailyStats(CONV, bucket(hoursWith(3, 5), 10, 4));

    const row = dbm.db.select().from(schema.dailyStats).get();
    assert.ok(row, "应该写入了一行");
    assert.ok(Array.isArray(row.hourHistogram), "小时分布必须是数组，不能是字符串");
    assert.equal((row.hourHistogram as number[])[3], 5);
  });

  it("再次写入同一天时计数累加而不是覆盖", () => {
    sync.flushDailyStats(CONV, bucket(hoursWith(3, 2), 6, 3));

    const row = dbm.db.select().from(schema.dailyStats).get()!;
    assert.equal(row.messages, 16, "消息数应累加 10 + 6");
    assert.equal(row.qualityMessages, 7, "高质量数应累加 4 + 3");
  });

  it("小时分布也累加，且仍然是数组", () => {
    const row = dbm.db.select().from(schema.dailyStats).get()!;
    assert.ok(Array.isArray(row.hourHistogram), "累加后仍必须是数组");
    assert.equal((row.hourHistogram as number[])[3], 7, "第 3 小时应累加 5 + 2");
    assert.equal((row.hourHistogram as number[]).length, 24);
  });

  it("不同小时互不干扰", () => {
    sync.flushDailyStats(CONV, bucket(hoursWith(20, 9), 9, 1));
    const row = dbm.db.select().from(schema.dailyStats).get()!;
    const hist = row.hourHistogram as number[];
    assert.equal(hist[3], 7, "原有的第 3 小时不该被清掉");
    assert.equal(hist[20], 9);
  });

  it("首末时间取极值而非覆盖", () => {
    const row = dbm.db.select().from(schema.dailyStats).get()!;
    assert.equal(row.firstMsgAt, 1_786_000_000_000);
    assert.equal(row.lastMsgAt, 1_786_000_100_000);
  });

  it("空 bucket 直接返回，不产生空行", () => {
    const before = dbm.db.select().from(schema.dailyStats).all().length;
    sync.flushDailyStats(CONV, new Map());
    assert.equal(dbm.db.select().from(schema.dailyStats).all().length, before);
  });
});
