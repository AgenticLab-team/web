import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 敏感词闸门的数据库侧。
 *
 * 两个刻意的决定要被锁死：
 *   1. **拦截时不回显命中了哪个词** —— 回显等于把词库白送给想绕过的人，
 *      改一个字再试，几次就摸清了
 *   2. **送审档照常发布，只是进队列** —— 先扣下再审的话，
 *      误伤一次就是有人的内容凭空消失几小时
 */

const tmp = mkdtempSync(join(tmpdir(), "al-gate-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type GateModule = typeof import("@/lib/moderation/word-gate");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let gate: GateModule;
let dbm: DbModule;
let schema: SchemaModule;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  gate = await import("@/lib/moderation/word-gate");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.sensitiveWords).run();
  dbm.db.delete(schema.reports).run();
});

function word(w: string, kind: "block" | "review" | "replace", replacement?: string) {
  dbm.db
    .insert(schema.sensitiveWords)
    .values({ word: w, kind, replacement: replacement ?? null })
    .run();
}

describe("闸门判定", () => {
  it("词库为空时一律放行", () => {
    const r = gate.checkContent("任何内容");
    assert.equal(r.allowed, true);
    assert.equal(r.needsReview, false);
    assert.equal(r.content, "任何内容");
  });

  it("拦截档挡下来", () => {
    word("违禁词", "block");
    const r = gate.checkContent("这里有违禁词");
    assert.equal(r.allowed, false);
  });

  it("**拦截时不回显命中了哪个词**", () => {
    // 回显等于把词库交出去，改一个字再试几次就摸清了
    word("违禁词", "block");
    const r = gate.checkContent("这里有违禁词");
    assert.ok(!r.message!.includes("违禁词"), `提示里泄露了词条：${r.message}`);
  });

  it("拦截的提示要给出去处，不能只说「不合规」", () => {
    word("违禁词", "block");
    const r = gate.checkContent("违禁词");
    assert.match(r.message!, /管理员|稍后/);
  });

  it("**送审档照常放行，只是标记需要审核**", () => {
    word("待查", "review");
    const r = gate.checkContent("这里有待查内容");
    assert.equal(r.allowed, true, "先扣下再审的话，误伤一次就是内容凭空消失几小时");
    assert.equal(r.needsReview, true);
  });

  it("替换档改写内容后放行", () => {
    word("脏话", "replace", "***");
    const r = gate.checkContent("这是脏话");
    assert.equal(r.allowed, true);
    assert.equal(r.content, "这是***");
    assert.equal(r.needsReview, false);
  });

  it("停用的词条不生效", () => {
    word("违禁词", "block");
    dbm.db.update(schema.sensitiveWords).set({ enabled: false }).run();
    assert.equal(gate.checkContent("违禁词").allowed, true);
  });
});

describe("命中计数", () => {
  it("命中会累加，用来发现误伤", () => {
    word("常见词", "review");
    gate.checkContent("常见词");
    gate.checkContent("又是常见词");

    const row = dbm.db.select().from(schema.sensitiveWords).get()!;
    assert.equal(row.hitCount, 2);
  });

  it("没命中不累加", () => {
    word("罕见词", "review");
    gate.checkContent("完全无关的内容");
    assert.equal(dbm.db.select().from(schema.sensitiveWords).get()!.hitCount, 0);
  });

  it("一段话里命中多次只算一次 —— 统计的是「多少段内容命中」", () => {
    word("重复", "review");
    gate.checkContent("重复重复重复");
    assert.equal(dbm.db.select().from(schema.sensitiveWords).get()!.hitCount, 1);
  });
});

describe("送审进队列", () => {
  it("**复用举报队列，版主只盯一个地方**", () => {
    word("待查", "review");
    const r = gate.checkContent("有待查内容");

    gate.fileForReview({
      targetType: "post",
      targetId: "p1",
      targetUserId: "u1",
      scan: r.scan,
    });

    const report = dbm.db.select().from(schema.reports).get()!;
    assert.equal(report.targetId, "p1");
    assert.equal(report.targetUserId, "u1");
    assert.equal(report.reporterId, gate.SYSTEM_REPORTER_ID);
  });

  it("详情里写清楚命中了什么 —— 版主要能判断是不是误伤", () => {
    word("待查", "review");
    const r = gate.checkContent("有待查内容");
    gate.fileForReview({ targetType: "post", targetId: "p1", targetUserId: "u1", scan: r.scan });

    assert.match(dbm.db.select().from(schema.reports).get()!.detail!, /待查/);
  });

  it("**自动送审按普通优先级排队** —— 它是提示不是判决", () => {
    word("待查", "review");
    const r = gate.checkContent("待查");
    gate.fileForReview({ targetType: "post", targetId: "p1", targetUserId: "u1", scan: r.scan });

    assert.equal(dbm.db.select().from(schema.reports).get()!.severity, 0);
  });

  it("没有命中时不产生任何举报", () => {
    word("待查", "review");
    const r = gate.checkContent("干净内容");
    gate.fileForReview({ targetType: "post", targetId: "p1", targetUserId: "u1", scan: r.scan });

    assert.equal(dbm.db.select().from(schema.reports).all().length, 0);
  });

  it("系统送审能与人工举报区分开", () => {
    word("待查", "review");
    const r = gate.checkContent("待查");
    gate.fileForReview({ targetType: "post", targetId: "p1", targetUserId: "u1", scan: r.scan });

    dbm.db
      .insert(schema.reports)
      .values({
        reporterId: "u_human",
        targetType: "post",
        targetId: "p2",
        reasonCode: "spam",
      })
      .run();

    const all = dbm.db.select().from(schema.reports).all();
    const system = all.filter((r) => r.reporterId === gate.SYSTEM_REPORTER_ID);
    assert.equal(system.length, 1);
    assert.equal(all.length, 2);
  });
});

describe("档位组合", () => {
  it("同时命中拦截和替换时按拦截处理，且不做替换", () => {
    word("违禁词", "block");
    word("脏话", "replace", "**");

    const r = gate.checkContent("违禁词和脏话");
    assert.equal(r.allowed, false);
    // 替换后的结果本来就不该发出去
    assert.equal(r.content, "违禁词和脏话");
  });

  it("同时命中送审和替换时，既替换也送审", () => {
    word("待查", "review");
    word("脏话", "replace", "**");

    const r = gate.checkContent("待查和脏话");
    assert.equal(r.allowed, true);
    assert.equal(r.needsReview, true);
    assert.equal(r.content, "待查和**");
  });
});

describe("规避手段", () => {
  it("加空格绕不过闸门", () => {
    word("违禁词", "block");
    assert.equal(gate.checkContent("违 禁 词").allowed, false);
  });

  it("全角绕不过闸门", () => {
    word("spam", "block");
    assert.equal(gate.checkContent("ＳＰＡＭ").allowed, false);
  });

  it("插标点绕不过闸门", () => {
    word("违禁词", "block");
    assert.equal(gate.checkContent("违·禁·词").allowed, false);
  });
});
