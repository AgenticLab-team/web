import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 举报队列。
 *
 * 核心是**按目标归组**：十个人举报同一条内容，队列里应该是一行，
 * 不是十行。列成十行的话，版主会把同一个帖子处理十遍，
 * 而真正需要看的其他事被挤到第二页。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-reports-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type ReportsModule = typeof import("@/lib/admin/reports");
type AppealsModule = typeof import("@/lib/admin/appeals");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let mod: ReportsModule;
let appealsMod: AppealsModule;
let dbm: DbModule;
let schema: SchemaModule;

const T0 = 1_700_000_000_000;
const HOUR = 3600_000;
const BOARD = "b_main";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  mod = await import("@/lib/admin/reports");
  appealsMod = await import("@/lib/admin/appeals");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function post(id: string, authorId: string, overrides: Record<string, unknown> = {}) {
  dbm.db
    .insert(schema.posts)
    .values({
      id,
      boardId: BOARD,
      authorId,
      title: `帖子 ${id}`,
      content: "正文内容",
      contentHtml: "<p>正文内容</p>",
      ...overrides,
    })
    .run();
}

function report(
  id: string,
  reporterId: string,
  targetId: string,
  reasonCode: string,
  overrides: Record<string, unknown> = {},
) {
  dbm.db
    .insert(schema.reports)
    .values({
      id,
      reporterId,
      targetType: "post",
      targetId,
      targetUserId: "u_bad",
      reasonCode: reasonCode as "spam",
      severity: reasonCode === "porn" || reasonCode === "illegal" ? 2 : 0,
      createdAt: T0,
      ...overrides,
    })
    .run();
}

beforeEach(() => {
  for (const t of [
    schema.reports,
    schema.moderationActions,
    schema.appeals,
    schema.posts,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }
  dbm.db
    .insert(schema.users)
    .values([
      { id: "u_bad", wxId: "wx_bad", siteNickname: "被举报的人" },
      { id: "u_r1", wxId: "wx_r1", siteNickname: "举报人一" },
      { id: "u_r2", wxId: "wx_r2", siteNickname: "举报人二" },
      { id: "u_r3", wxId: "wx_r3", siteNickname: "举报人三" },
      { id: "u_mod", wxId: "wx_mod", siteNickname: "版主" },
      { id: "u_mod2", wxId: "wx_mod2", siteNickname: "另一位版主" },
    ])
    .run();
});

describe("按目标归组", () => {
  it("**十个人举报同一条内容只占队列一行**", () => {
    post("p1", "u_bad");
    for (let i = 0; i < 10; i++) report(`r${i}`, `u_x${i}`, "p1", "spam");

    const queue = mod.reportQueue({}, T0 + HOUR);
    assert.equal(queue.length, 1, "归组失败的话版主会把同一个帖子处理十遍");
    assert.equal(queue[0].reporterCount, 10);
    assert.equal(queue[0].reportIds.length, 10);
  });

  it("不同目标各占一行", () => {
    post("p1", "u_bad");
    post("p2", "u_bad");
    report("r1", "u_r1", "p1", "spam");
    report("r2", "u_r2", "p2", "spam");

    assert.equal(mod.reportQueue({}, T0 + HOUR).length, 2);
  });

  it("同一个人重复出现只算一个举报人", () => {
    post("p1", "u_bad");
    report("r1", "u_r1", "p1", "spam");
    report("r2", "u_r1", "p1", "abuse");

    const row = mod.reportQueue({}, T0 + HOUR)[0];
    assert.equal(row.reporterCount, 1, "举报人数是去重后的人数，不是举报条数");
    assert.equal(row.reportIds.length, 2);
  });

  it("理由按出现次数聚合", () => {
    post("p1", "u_bad");
    report("r1", "u_r1", "p1", "spam");
    report("r2", "u_r2", "p1", "spam");
    report("r3", "u_r3", "p1", "abuse");

    const row = mod.reportQueue({}, T0 + HOUR)[0];
    assert.equal(row.reasons[0].code, "spam");
    assert.equal(row.reasons[0].count, 2);
    assert.equal(row.reasons[0].label, "垃圾信息");
  });
});

describe("升级与排序", () => {
  it("**三个不同的人举报会把普通件升级**", () => {
    post("p1", "u_bad");
    report("r1", "u_r1", "p1", "spam");
    report("r2", "u_r2", "p1", "spam");
    report("r3", "u_r3", "p1", "spam");

    const row = mod.reportQueue({}, T0 + HOUR)[0];
    assert.equal(row.baseSeverity, 0);
    assert.equal(row.severity, 1, "多人独立举报应该升级");
  });

  it("紧急件排在普通件前面", () => {
    post("p1", "u_bad");
    post("p2", "u_bad");
    report("r1", "u_r1", "p1", "spam", { createdAt: T0 - 10 * HOUR });
    report("r2", "u_r2", "p2", "porn");

    const queue = mod.reportQueue({}, T0 + HOUR);
    assert.equal(queue[0].targetId, "p2", "涉黄要插队，哪怕它更新");
  });

  it("**同严重度下最老的排最前**", () => {
    post("p1", "u_bad");
    post("p2", "u_bad");
    report("r1", "u_r1", "p1", "spam", { createdAt: T0 });
    report("r2", "u_r2", "p2", "spam", { createdAt: T0 - 20 * HOUR });

    assert.equal(mod.reportQueue({}, T0 + HOUR)[0].targetId, "p2");
  });
});

describe("超时", () => {
  it("紧急件超过两小时标红", () => {
    post("p1", "u_bad");
    report("r1", "u_r1", "p1", "porn");

    assert.equal(mod.reportQueue({}, T0 + HOUR)[0].overdue, false);
    assert.equal(mod.reportQueue({}, T0 + 5 * HOUR)[0].overdue, true);
  });

  it("**超时按最早那条算**", () => {
    // 按最新算的话，持续被举报的内容永远不会超时 —— 恰恰相反才对
    post("p1", "u_bad");
    report("r1", "u_r1", "p1", "spam", { createdAt: T0 - 60 * HOUR });
    report("r2", "u_r2", "p1", "spam", { createdAt: T0 });

    assert.equal(mod.reportQueue({}, T0 + HOUR)[0].overdue, true);
  });
});

describe("队列里的上下文", () => {
  it("带出内容摘要，不用点进去才知道在说什么", () => {
    post("p1", "u_bad", { title: "标题在这", content: "正文在这" });
    report("r1", "u_r1", "p1", "spam");

    const row = mod.reportQueue({}, T0 + HOUR)[0];
    assert.match(row.preview!, /标题在这/);
    assert.match(row.preview!, /正文在这/);
  });

  it("带出被举报人昵称", () => {
    post("p1", "u_bad");
    report("r1", "u_r1", "p1", "spam");
    assert.equal(mod.reportQueue({}, T0 + HOUR)[0].targetUserName, "被举报的人");
  });

  it("**标出内容是否已经被处理掉了**", () => {
    post("p1", "u_bad", { status: "hidden" });
    post("p2", "u_bad");
    report("r1", "u_r1", "p1", "spam");
    report("r2", "u_r2", "p2", "spam");

    const queue = mod.reportQueue({}, T0 + HOUR);
    assert.equal(queue.find((r) => r.targetId === "p1")!.targetGone, true);
    assert.equal(queue.find((r) => r.targetId === "p2")!.targetGone, false);
  });

  it("**锁定的帖子不算已处理** —— 它还看得见", () => {
    post("p1", "u_bad", { status: "locked" });
    report("r1", "u_r1", "p1", "spam");
    assert.equal(mod.reportQueue({}, T0 + HOUR)[0].targetGone, false);
  });

  it("带出被举报人的历史处罚次数 —— 惯犯和初犯不该同样处理", () => {
    post("p1", "u_bad");
    report("r1", "u_r1", "p1", "spam");
    dbm.db
      .insert(schema.moderationActions)
      .values([
        { actorId: "u_mod", targetType: "post", targetId: "px", targetUserId: "u_bad", action: "warn", reason: "第一次" },
        { actorId: "u_mod", targetType: "post", targetId: "py", targetUserId: "u_bad", action: "hide", reason: "第二次" },
      ])
      .run();

    assert.equal(mod.reportQueue({}, T0 + HOUR)[0].priorActions, 2);
  });

  it("已撤销的处罚不计入历史 —— 误判过的不能算他头上", () => {
    post("p1", "u_bad");
    report("r1", "u_r1", "p1", "spam");
    dbm.db
      .insert(schema.moderationActions)
      .values({
        actorId: "u_mod",
        targetType: "post",
        targetId: "px",
        targetUserId: "u_bad",
        action: "warn",
        reason: "后来撤销了",
        revertedAt: T0,
        revertedBy: "u_mod2",
      })
      .run();

    assert.equal(mod.reportQueue({}, T0 + HOUR)[0].priorActions, 0);
  });
});

describe("筛选与计数", () => {
  it("默认只看待处理的", () => {
    post("p1", "u_bad");
    post("p2", "u_bad");
    report("r1", "u_r1", "p1", "spam");
    report("r2", "u_r2", "p2", "spam", { status: "resolved" });

    const queue = mod.reportQueue({}, T0 + HOUR);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].targetId, "p1");
  });

  it("按理由筛选", () => {
    post("p1", "u_bad");
    post("p2", "u_bad");
    report("r1", "u_r1", "p1", "spam");
    report("r2", "u_r2", "p2", "abuse");

    assert.equal(mod.reportQueue({ reasonCode: "abuse" }, T0 + HOUR)[0].targetId, "p2");
  });

  it("分桶计数与队列一致", () => {
    post("p1", "u_bad");
    post("p2", "u_bad");
    report("r1", "u_r1", "p1", "porn");
    report("r2", "u_r2", "p2", "spam", { createdAt: T0 - 100 * HOUR });

    const facets = mod.reportFacets(T0 + HOUR);
    assert.equal(facets.pending, 2);
    assert.equal(facets.urgent, 1);
    assert.equal(facets.overdue, 1, "那条 100 小时前的普通件早该超时了");
    assert.equal(facets.unassigned, 2);
  });

  it("空队列不报错", () => {
    assert.deepEqual(mod.reportQueue({}, T0), []);
    assert.equal(mod.reportFacets(T0).pending, 0);
  });
});

describe("单个目标的举报全文", () => {
  it("列出每一条举报及举报人", () => {
    post("p1", "u_bad");
    report("r1", "u_r1", "p1", "spam", { detail: "连发二十条广告" });
    report("r2", "u_r2", "p1", "abuse");

    const list = mod.reportsForTarget("post", "p1");
    assert.equal(list.length, 2);
    assert.ok(list.some((r) => r.reporterName === "举报人一" && r.detail === "连发二十条广告"));
    assert.ok(list.every((r) => r.reasonLabel.length > 0));
  });
});

describe("申诉队列", () => {
  function punishAndAppeal(opts: { punisher: string; appealId: string; createdAt?: number }) {
    const actionId = `a_${opts.appealId}`;
    dbm.db
      .insert(schema.moderationActions)
      .values({
        id: actionId,
        actorId: opts.punisher,
        targetType: "post",
        targetId: "p1",
        targetUserId: "u_bad",
        action: "hide",
        reason: "广告刷屏",
        createdAt: T0,
      })
      .run();
    dbm.db
      .insert(schema.appeals)
      .values({
        id: opts.appealId,
        userId: "u_bad",
        actionId,
        content: "我发的是自己的项目，不是广告",
        createdAt: opts.createdAt ?? T0,
      })
      .run();
  }

  it("**每行都带上原处罚的理由** —— 只看申诉人怎么说没法复核", () => {
    punishAndAppeal({ punisher: "u_mod", appealId: "ap1" });

    const row = appealsMod.appealQueue({}, T0 + HOUR)[0];
    assert.equal(row.actionReason, "广告刷屏");
    assert.equal(row.actionKind, "hide");
    assert.equal(row.content, "我发的是自己的项目，不是广告");
  });

  it("**标出是谁下的处罚** —— 他不能复核自己的决定，界面要先说清楚", () => {
    punishAndAppeal({ punisher: "u_mod", appealId: "ap1" });
    const row = appealsMod.appealQueue({}, T0 + HOUR)[0];
    assert.equal(row.punisherId, "u_mod");
    assert.equal(row.punisherName, "版主");
  });

  it("**最老的排最前** —— 等待本身就是二次伤害", () => {
    punishAndAppeal({ punisher: "u_mod", appealId: "ap1", createdAt: T0 });
    punishAndAppeal({ punisher: "u_mod", appealId: "ap2", createdAt: T0 - 48 * HOUR });

    const queue = appealsMod.appealQueue({}, T0 + HOUR);
    assert.equal(queue[0].id, "ap2");
    assert.equal(queue[0].waitingHours, 49);
  });

  it("默认只看待处理的", () => {
    punishAndAppeal({ punisher: "u_mod", appealId: "ap1" });
    dbm.db
      .update(schema.appeals)
      .set({ status: "rejected", handledBy: "u_mod2", response: "维持原判" })
      .run();

    assert.equal(appealsMod.appealQueue({}, T0 + HOUR).length, 0);
    assert.equal(appealsMod.appealQueue({ status: "rejected" }, T0 + HOUR).length, 1);
  });

  it("**采纳率是制度体检指标** —— 长期 0% 说明申诉是走过场", () => {
    punishAndAppeal({ punisher: "u_mod", appealId: "ap1" });
    punishAndAppeal({ punisher: "u_mod", appealId: "ap2" });
    dbm.db.update(schema.appeals).set({ status: "accepted" }).where(eq(schema.appeals.id, "ap1")).run();
    dbm.db.update(schema.appeals).set({ status: "rejected" }).where(eq(schema.appeals.id, "ap2")).run();

    const facets = appealsMod.appealFacets();
    assert.equal(facets.handled, 2);
    assert.equal(facets.acceptRate, 50);
  });

  it("还没有处理过任何申诉时采纳率是 null，不是 0", () => {
    // 显示 0% 会让人以为「一条都没采纳过」，其实是「还没处理过」
    assert.equal(appealsMod.appealFacets().acceptRate, null);
  });

  it("处罚动作有中文名", () => {
    assert.equal(appealsMod.actionLabel("ban"), "封禁");
    assert.equal(appealsMod.actionLabel("brand_new"), "brand_new");
  });
});
