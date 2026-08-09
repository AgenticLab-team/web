import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * 群可见性收口测试。
 *
 * 规则：群列表与群相关数据都属于隐私 ——
 * 访客一个群都看不到，成员只能看到自己所在的群。
 *
 * 这一层必须逐条断言。靠肉眼检查页面是查不出泄露的：
 * 数据已经渲染进 HTML 了，前端隐藏不算数。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-vis-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");
type VisModule = typeof import("@/lib/queries/visibility");
type BoardModule = typeof import("@/lib/queries/leaderboard");

let dbm: DbModule;
let schema: SchemaModule;
let vis: VisModule;
let board: BoardModule;

const ALICE = "wxid_alice";
const BOB = "wxid_bob";
const G1 = "g1@chatroom";
const G2 = "g2@chatroom";
const G3_UNSYNCED = "g3@chatroom";

/** 造一个最小可用的 user 对象，只填可见性判定会读的字段 */
function userOf(wxId: string | null) {
  return {
    id: `u_${wxId ?? "none"}`,
    wxId,
    status: "active",
    kind: "member",
  } as unknown as Parameters<VisModule["visibleGroupsFor"]>[0];
}

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  vis = await import("@/lib/queries/visibility");
  board = await import("@/lib/queries/leaderboard");

  const { db } = dbm;
  const { groups, groupMembers, dailyStats } = schema;

  db.insert(groups)
    .values([
      { convId: G1, name: "一号群", syncEnabled: true, bound: true, messageCount: 100 },
      { convId: G2, name: "二号群", syncEnabled: true, bound: true, messageCount: 200 },
      { convId: G3_UNSYNCED, name: "未接入群", syncEnabled: false, bound: false },
    ])
    .run();

  db.insert(groupMembers)
    .values([
      // Alice 在 1、2 号群
      { convId: G1, wxId: ALICE, displayName: "Alice", messages: 10 },
      { convId: G2, wxId: ALICE, displayName: "Alice", messages: 20 },
      // Alice 也在未接入的群里，但那个群不该出现
      { convId: G3_UNSYNCED, wxId: ALICE, displayName: "Alice", messages: 5 },
      // Bob 只在 1 号群；他曾在 2 号群但已退出
      { convId: G1, wxId: BOB, displayName: "Bob", messages: 30 },
      { convId: G2, wxId: BOB, displayName: "Bob", messages: 40, leftAt: 1_786_000_000_000 },
    ])
    .run();

  db.insert(dailyStats)
    .values([
      { wxId: ALICE, convId: G1, date: "2026-08-08", messages: 10, qualityMessages: 5 },
      { wxId: ALICE, convId: G2, date: "2026-08-08", messages: 20, qualityMessages: 9 },
      { wxId: BOB, convId: G1, date: "2026-08-08", messages: 30, qualityMessages: 7 },
      // 只存在于 2 号群的人，Bob 不该在任何榜单里看到他
      { wxId: "wxid_only_g2", convId: G2, date: "2026-08-08", messages: 50, qualityMessages: 40 },
    ])
    .run();
});

after(() => rmSync(tmp, { recursive: true, force: true }));

describe("群可见性", () => {
  it("访客一个群都看不到", () => {
    assert.deepEqual(vis.visibleGroupsFor(null), []);
    assert.deepEqual(vis.visibleGroupIds(null), []);
  });

  it("未绑定微信的账号也看不到任何群", () => {
    assert.deepEqual(vis.visibleGroupsFor(userOf(null)), []);
  });

  it("成员只看到自己所在的群", () => {
    const ids = vis.visibleGroupIds(userOf(ALICE)).sort();
    assert.deepEqual(ids, [G1, G2].sort());
  });

  it("已退群的不再可见", () => {
    const ids = vis.visibleGroupIds(userOf(BOB));
    assert.deepEqual(ids, [G1]);
    assert.ok(!ids.includes(G2), "退群后必须立即失去该群可见权");
  });

  it("未接入本站的群不可见，哪怕人还在里面", () => {
    assert.ok(!vis.visibleGroupIds(userOf(ALICE)).includes(G3_UNSYNCED));
  });

  it("单群访问校验：不在的群返回 null", () => {
    assert.ok(vis.assertGroupAccess(userOf(BOB), G1), "自己的群应可访问");
    assert.equal(vis.assertGroupAccess(userOf(BOB), G2), null, "退出的群不可访问");
    assert.equal(vis.assertGroupAccess(null, G1), null, "访客不可访问任何群");
  });

  it("filterToVisible 剔除越权行", () => {
    const rows = [{ convId: G1 }, { convId: G2 }, { convId: G3_UNSYNCED }];
    assert.deepEqual(vis.filterToVisible(userOf(BOB), rows), [{ convId: G1 }]);
    assert.deepEqual(vis.filterToVisible(null, rows), []);
  });
});

describe("排行榜按可见群收口", () => {
  it("可见群为空时返回空榜，而不是全量榜", () => {
    // 这是整个设计的关键：漏传范围的后果必须是「看不到」而不是「全看到」
    assert.deepEqual(board.getLeaderboard({ convIds: [], period: "all" }), []);
  });

  it("只聚合可见群的数据", () => {
    const bobIds = vis.visibleGroupIds(userOf(BOB));
    const entries = board.getLeaderboard({ convIds: bobIds, period: "all" });
    const names = entries.map((e) => e.wxId);
    assert.ok(names.includes(BOB));
    assert.ok(
      !names.includes("wxid_only_g2"),
      "Bob 不在二号群，榜上不该出现只在二号群发言的人",
    );
  });

  it("同一个人在不同可见范围下的数字不同", () => {
    const all = board.getLeaderboard({ convIds: [G1, G2], period: "all" });
    const onlyG1 = board.getLeaderboard({ convIds: [G1], period: "all" });
    const aliceAll = all.find((e) => e.wxId === ALICE)!;
    const aliceG1 = onlyG1.find((e) => e.wxId === ALICE)!;
    assert.equal(aliceAll.quality, 14, "两个群合计 5 + 9");
    assert.equal(aliceG1.quality, 5, "只算一号群");
  });

  it("指定一个不可见的群等于看不到，不报错也不降级成全量", () => {
    const bobIds = vis.visibleGroupIds(userOf(BOB));
    const entries = board.getLeaderboard({ convIds: bobIds, convId: G2, period: "all" });
    assert.deepEqual(entries, [], "越权指定的群必须返回空，而不是忽略参数返回全量");
  });

  it("getMyRank 同样受可见范围约束", () => {
    // getMyRank 现在收整个 user：隐私豁免要判权限，而权限判断只该有一处
    assert.equal(board.getMyRank(userOf(ALICE), { convIds: [], period: "all" }), null);
    const rank = board.getMyRank(userOf(ALICE), { convIds: [G1], period: "all" });
    assert.ok(rank);
    assert.equal(rank.quality, 5);
  });
});

describe("总榜公开但群身份不外泄", () => {
  it("allSyncedGroupIds 只返回已接入的群", () => {
    const ids = vis.allSyncedGroupIds().sort();
    assert.deepEqual(ids, [G1, G2].sort(), "未接入的群不该出现在总榜聚合里");
  });

  it("访客能用总榜范围拿到排名", () => {
    // 与「群列表私密」不冲突：公开的是「谁贡献最多」，不是「有哪些群」
    const entries = board.getLeaderboard({ convIds: vis.allSyncedGroupIds(), period: "all" });
    assert.ok(entries.length > 0, "总榜对所有人开放");
  });

  it("总榜里不含任何群标识", () => {
    const entries = board.getLeaderboard({ convIds: vis.allSyncedGroupIds(), period: "all" });
    for (const entry of entries) {
      assert.ok(!("convId" in entry), "榜单条目不该带群 id");
      assert.ok(!("groupName" in entry), "榜单条目不该带群名");
    }
  });

  it("访客仍然拿不到群列表", () => {
    // 这一条与总榜公开是两回事，必须同时成立
    assert.deepEqual(vis.visibleGroupsFor(null), []);
  });
});
