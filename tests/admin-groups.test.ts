import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 群与数据源的查询层。
 *
 * 这一页存在的唯一理由是**发现数据没进来**。
 * 上游断掉的表现是消息数不再增长，而那和「今天大家没说话」
 * 在数据上长得一模一样 —— 所以这里的断言几乎都在验证
 * 「异常能不能被认出来」，以及「正常的别误报」。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-groups-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type Mod = typeof import("@/lib/admin/groups");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let mod: Mod;
let dbm: DbModule;
let schema: SchemaModule;

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 3600_000;
const DAY = 86_400_000;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { seedDatabase } = await import("@/lib/db/seed");
  seedDatabase();
  mod = await import("@/lib/admin/groups");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [schema.syncJobs, schema.syncCursors, schema.dailyStats, schema.messages, schema.groups]) {
    dbm.db.delete(t).run();
  }
});

function group(convId: string, over: Record<string, unknown> = {}) {
  dbm.db
    .insert(schema.groups)
    .values({ convId, name: `群 ${convId}`, bound: true, syncEnabled: true, ...over })
    .run();
}

function message(convId: string, ts: number, id = `m_${convId}_${ts}`) {
  dbm.db
    .insert(schema.messages)
    .values({
      id,
      convId,
      senderWxId: "wx1",
      senderName: "甲",
      type: "text",
      content: "一段足够长的正常发言内容",
      length: 20,
      ts,
    })
    .run();
}

function daily(convId: string, date: string, messages: number) {
  dbm.db
    .insert(schema.dailyStats)
    .values({ convId, wxId: "wx1", date, messages, qualityMessages: messages })
    .run();
}

describe("接入状态", () => {
  it("区分已绑定、已接入、已排除", () => {
    group("g1");
    group("g2", { syncExcluded: true, syncEnabled: false });
    group("g3", { bound: false, syncEnabled: false });

    const s = mod.upstreamStatus();
    assert.equal(s.boundGroups, 2);
    assert.equal(s.syncedGroups, 1);
    assert.equal(s.excludedGroups, 1);
  });

  it("**上游可达性报「不知道」而不是「正常」**", () => {
    // 这一页的全部意义就是发现上游断了，
    // 它自己却谎报健康的话，就成了最坏的那种仪表盘
    assert.equal(mod.upstreamStatus().reachable, "unknown");
  });

  it("空库不炸", () => {
    const s = mod.upstreamStatus();
    assert.equal(s.boundGroups, 0);
    assert.equal(s.totalMessages, 0);
  });
});

describe("群列表", () => {
  it("统计真实消息数与冗余计数", () => {
    group("g1", { messageCount: 999 });
    message("g1", NOW - HOUR);
    message("g1", NOW - 2 * HOUR, "m_b");

    const row = mod.listGroupsForAdmin(NOW)[0];
    assert.equal(row.liveMessages, 2);
    assert.equal(row.messageCount, 999, "冗余列要能单独看到，才发现得了漂移");
  });

  it("最新消息时间取自真实数据", () => {
    group("g1", { lastMessageAt: 0 });
    message("g1", NOW - HOUR);
    assert.equal(mod.listGroupsForAdmin(NOW)[0].lastMessageAt, NOW - HOUR);
  });

  it("有效阈值：本群没设就用全局", () => {
    group("g1");
    group("g2", { qualityMin: 30 });

    const rows = mod.listGroupsForAdmin(NOW);
    assert.equal(rows.find((r) => r.convId === "g2")!.effectiveQualityMin, 30);
    assert.ok(rows.find((r) => r.convId === "g1")!.effectiveQualityMin > 0);
  });

  it("**没接入同步的群不做新鲜度判定**", () => {
    // 它本来就不该有数据，标成「可能中断」是误报
    group("g1", { syncEnabled: false, bound: false });
    const row = mod.listGroupsForAdmin(NOW)[0];
    assert.equal(row.freshness.level, "unknown");
    assert.match(row.freshness.message, /未接入/);
  });
});

describe("新鲜度：认出异常，别误报正常", () => {
  function activeGroup(convId: string, lastTs: number) {
    group(convId);
    message(convId, lastTs);
    // 14 天日均 200 条
    for (let i = 1; i <= 14; i++) {
      daily(convId, `2026-08-${String(i).padStart(2, "0")}`, 200);
    }
  }

  function sleepyGroup(convId: string, lastTs: number) {
    group(convId);
    message(convId, lastTs);
    for (let i = 1; i <= 14; i++) {
      daily(convId, `2026-08-${String(i).padStart(2, "0")}`, 0);
    }
    daily(convId, "2026-07-01", 5);
  }

  it("刚有消息的活跃群是正常", () => {
    activeGroup("g1", NOW - HOUR);
    assert.equal(mod.listGroupsForAdmin(NOW)[0].freshness.level, "fresh");
  });

  it("**活跃群安静两天判为可能中断**", () => {
    activeGroup("g1", NOW - 2 * DAY);
    const row = mod.listGroupsForAdmin(NOW)[0];
    assert.equal(row.freshness.level, "stale");
  });

  it("**冷清群安静很久不算中断** —— 否则天天报警，报警就会被忽略", () => {
    sleepyGroup("g1", NOW - 10 * DAY);
    const level = mod.listGroupsForAdmin(NOW)[0].freshness.level;
    assert.notEqual(level, "stale");
  });

  it("日均随统计天数正确计算", () => {
    group("g1");
    message("g1", NOW);
    daily("g1", "2026-08-01", 100);
    daily("g1", "2026-08-02", 200);

    assert.equal(mod.listGroupsForAdmin(NOW)[0].dailyAverage, 150);
  });

  it("没有统计数据时日均为 0，不是 NaN", () => {
    group("g1");
    message("g1", NOW);
    const row = mod.listGroupsForAdmin(NOW)[0];
    assert.equal(row.dailyAverage, 0);
    assert.ok(Number.isFinite(row.dailyAverage));
  });
});

describe("同步任务概览", () => {
  function job(kind: string, over: Record<string, unknown> = {}) {
    dbm.db
      .insert(schema.syncJobs)
      .values({ kind: kind as "messages", status: "success", createdAt: NOW, ...over })
      .run();
  }

  it("每类同步都有一行，哪怕从没跑过", () => {
    const rows = mod.syncOverview(NOW);
    assert.ok(rows.length >= 6);
    assert.ok(rows.every((r) => r.label.length > 0));
    assert.ok(rows.every((r) => r.health.verdict === "never"));
  });

  it("最近成功过判为正常", () => {
    job("messages", { finishedAt: NOW - 30_000 });
    const row = mod.syncOverview(NOW).find((r) => r.kind === "messages")!;
    assert.equal(row.health.verdict, "ok");
  });

  it("**很久没成功判为已中断，哪怕一次都没失败过**", () => {
    // 定时器停了的话失败率是 0，看起来完美
    job("messages", { finishedAt: NOW - 2 * DAY, createdAt: NOW - 2 * DAY });
    const row = mod.syncOverview(NOW).find((r) => r.kind === "messages")!;
    assert.equal(row.health.verdict, "down");
  });

  it("带出最近几次的记录，含错误原文", () => {
    job("messages", { status: "failed", error: "ECONNREFUSED 127.0.0.1:8090" });
    const row = mod.syncOverview(NOW).find((r) => r.kind === "messages")!;
    assert.equal(row.recent.length, 1);
    assert.match(row.recent[0].error!, /ECONNREFUSED/);
  });

  it("不同 kind 互不干扰", () => {
    job("messages", { finishedAt: NOW });
    job("members", { status: "failed", error: "boom" });

    const rows = mod.syncOverview(NOW);
    assert.equal(rows.find((r) => r.kind === "messages")!.health.verdict, "ok");
    assert.notEqual(rows.find((r) => r.kind === "members")!.health.verdict, "ok");
  });
});

describe("正在跑与可重试", () => {
  function job(status: string, over: Record<string, unknown> = {}) {
    dbm.db
      .insert(schema.syncJobs)
      .values({ kind: "messages", status: status as "success", ...over })
      .run();
  }

  it("统计正在跑的任务数", () => {
    // running 必须带 startedAt —— 没有的话是坏数据，见下一条
    job("running", { startedAt: NOW - MINUTE });
    job("pending");
    job("success");
    assert.equal(mod.runningJobs(NOW), 2);
  });

  it("**僵死的 running 不算在跑** —— 否则一具尸体会锁死触发按钮", () => {
    // 同步进程被杀掉时会留下永远不收尾的 running 行，实测发生过
    job("running", { startedAt: NOW - 60 * MINUTE });
    assert.equal(mod.runningJobs(NOW), 0);
  });

  it("只有失败和部分成功的算可重试", () => {
    job("failed");
    job("partial");
    job("success");
    job("running");

    const ids = mod.retryableJobs().map((j) => j.status);
    assert.deepEqual(new Set(ids), new Set(["failed", "partial"]));
  });
});

describe("增量游标", () => {
  it("列出每类同步拉到哪儿了", () => {
    dbm.db
      .insert(schema.syncCursors)
      .values({ kind: "messages", scope: "g1", lastTs: NOW - HOUR })
      .run();

    const rows = mod.cursors();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lastTs, NOW - HOUR);
  });

  it("没有游标时返回空数组", () => {
    assert.deepEqual(mod.cursors(), []);
  });
});
