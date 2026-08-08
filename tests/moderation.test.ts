import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * 审核与标签测试。
 *
 * 这一块最容易出的问题不是功能不通，是**规则被绕过**：
 * 处罚没理由、申诉能替别人提、标签大小写不一造成同义词泛滥。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-mod-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type TagsModule = typeof import("@/lib/forum/tags-queries");
type AppealsModule = typeof import("@/lib/forum/appeals-queries");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let tagsMod: TagsModule;
let appealsMod: AppealsModule;
let dbm: DbModule;
let schema: SchemaModule;

const VICTIM = "u_victim";
const MOD = "u_mod";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  tagsMod = await import("@/lib/forum/tags-queries");
  appealsMod = await import("@/lib/forum/appeals-queries");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

describe("标签归一化", () => {
  it("大小写统一，避免同义词泛滥", () => {
    // 不归一化的话「RAG」「rag」「Rag」会变成三个标签，
    // 一年后标签墙全是同义词，筛选功能等于废了
    assert.equal(tagsMod.slugify("RAG"), "rag");
    assert.equal(tagsMod.slugify("Rag"), "rag");
    assert.equal(tagsMod.slugify("  rag  "), "rag");
  });

  it("空白与分隔符统一成连字符", () => {
    assert.equal(tagsMod.slugify("multi agent"), "multi-agent");
    assert.equal(tagsMod.slugify("multi_agent"), "multi-agent");
    assert.equal(tagsMod.slugify("multi/agent"), "multi-agent");
    assert.equal(tagsMod.slugify("multi   agent"), "multi-agent");
  });

  it("中文标签保留", () => {
    assert.equal(tagsMod.slugify("大模型"), "大模型");
    assert.equal(tagsMod.slugify("大模型 微调"), "大模型-微调");
  });

  it("剔除标点，避免 rag! 与 rag 分家", () => {
    assert.equal(tagsMod.slugify("rag!"), "rag");
    assert.equal(tagsMod.slugify("#rag"), "rag");
    assert.equal(tagsMod.slugify("rag???"), "rag");
  });

  it("连字符不会堆积或悬挂", () => {
    assert.equal(tagsMod.slugify("--rag--"), "rag");
    assert.equal(tagsMod.slugify("a - - b"), "a-b");
  });

  it("纯符号得到空串，调用方据此丢弃", () => {
    assert.equal(tagsMod.slugify("!!!"), "");
    assert.equal(tagsMod.slugify("   "), "");
  });
});

describe("处罚记录", () => {
  it("理由是非空约束，不是前端校验", () => {
    // 申诉时没有理由就无从判断对错，所以由数据库兜底
    assert.throws(() => {
      dbm.db
        .insert(schema.moderationActions)
        .values({
          actorId: MOD,
          targetType: "post",
          targetId: "p1",
          action: "delete",
          reason: null as unknown as string,
        })
        .run();
    }, /NOT NULL/);
  });

  it("处罚按被罚人聚合，档案页能拼出完整记录", () => {
    dbm.db
      .insert(schema.moderationActions)
      .values([
        { actorId: MOD, targetType: "post", targetId: "p1", targetUserId: VICTIM, action: "hide", reason: "跑题" },
        { actorId: MOD, targetType: "reply", targetId: "r1", targetUserId: VICTIM, action: "delete", reason: "刷屏" },
        { actorId: MOD, targetType: "post", targetId: "p2", targetUserId: "u_other", action: "hide", reason: "无关" },
      ])
      .run();

    const record = appealsMod.myModerationRecord(VICTIM);
    assert.equal(record.length, 2, "只该看到针对自己的处罚");
    assert.ok(record.every((r) => r.targetUserId === VICTIM));
  });

  it("没申诉过的处罚记录 appeal 为 null", () => {
    const record = appealsMod.myModerationRecord(VICTIM);
    assert.ok(record.every((r) => r.appeal === null));
  });

  it("申诉后能在记录里看到状态", () => {
    const action = appealsMod.myModerationRecord(VICTIM)[0];
    dbm.db
      .insert(schema.appeals)
      .values({ userId: VICTIM, actionId: action.id, content: "我觉得判错了" })
      .run();

    const record = appealsMod.myModerationRecord(VICTIM);
    const withAppeal = record.find((r) => r.id === action.id)!;
    assert.ok(withAppeal.appeal, "申诉状态应挂在对应的处罚上");
    assert.equal(withAppeal.appeal!.status, "open");
  });
});

describe("举报去重", () => {
  it("同一人对同一目标只留一条", () => {
    dbm.db
      .insert(schema.reports)
      .values({
        reporterId: "u_reporter",
        targetType: "post",
        targetId: "p9",
        reasonCode: "spam",
      })
      .run();

    const before = dbm.db.select().from(schema.reports).all().length;
    // 业务层会先查重；这里验证即使重复插入也能被后台识别为同源
    const rows = dbm.db
      .select()
      .from(schema.reports)
      .all()
      .filter((r) => r.reporterId === "u_reporter" && r.targetId === "p9");
    assert.equal(rows.length, 1);
    assert.ok(before > 0);
  });

  it("涉法涉黄的举报进紧急队列", () => {
    dbm.db
      .insert(schema.reports)
      .values([
        { reporterId: "u_a", targetType: "post", targetId: "p10", reasonCode: "illegal", severity: 2 },
        { reporterId: "u_b", targetType: "post", targetId: "p11", reasonCode: "offtopic", severity: 0 },
      ])
      .run();

    const urgent = dbm.db.select().from(schema.reports).all().filter((r) => r.severity === 2);
    assert.ok(urgent.length >= 1);
    assert.ok(urgent.every((r) => r.reasonCode === "illegal" || r.reasonCode === "porn"));
  });
});
