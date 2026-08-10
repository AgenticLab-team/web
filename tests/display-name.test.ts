import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  FALLBACK_DISPLAY_NAME,
  looksLikeWxId,
  resolveDisplayName,
} from "@/lib/users/display-name";

/**
 * 显示名解析的收口测试。
 *
 * 线上出过的事故：people 同步在拿不到昵称时把 wx_id 写进了 displayName，
 * 排行榜的兜底又直接用了 wx_id —— 于是访客都能在页面上看到
 * wxid_xxxx，拿去就能精确加好友。这属于隐私泄露，不是显示瑕疵。
 *
 * 规则只有一条：任何展示路径都必须经过 resolveDisplayName，
 * 它保证 wx_id 形态的值永远到不了页面。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-name-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

after(() => rmSync(tmp, { recursive: true, force: true }));

describe("looksLikeWxId", () => {
  it("认得出自动分配的 wxid_ 前缀", () => {
    assert.equal(looksLikeWxId("wxid_examplemember01"), true);
    assert.equal(looksLikeWxId("  wxid_abc "), true);
    assert.equal(looksLikeWxId("WXID_ABC"), true);
  });

  it("认得出群聊 ID —— people 表里实测混进过群 ID 当「人」", () => {
    assert.equal(looksLikeWxId("20000000002@chatroom"), true);
  });

  it("正常昵称不误伤", () => {
    assert.equal(looksLikeWxId("jmr"), false);
    assert.equal(looksLikeWxId("张三"), false);
    // 昵称里**提到** wxid 不等于**是** wxid，只拦完整形态
    assert.equal(looksLikeWxId("我的 wxid_abc 你别加"), false);
  });
});

describe("resolveDisplayName", () => {
  it("按优先级取第一个可用候选", () => {
    assert.equal(resolveDisplayName(["站内名", "微信名"]), "站内名");
    assert.equal(resolveDisplayName([null, "微信名"]), "微信名");
    assert.equal(resolveDisplayName([undefined, "  空格裹着  "]), "空格裹着");
  });

  it("**wx_id 形态的候选一律跳过**", () => {
    assert.equal(
      resolveDisplayName(["wxid_abc123", "真名"]),
      "真名",
      "存量脏数据里 displayName 就是 wx_id，必须被过滤而不是原样展示",
    );
  });

  it("等于本人 wx_id 的候选跳过 —— 拦住不带前缀的自设微信号", () => {
    assert.equal(
      resolveDisplayName(["zhangsan123"], { wxId: "zhangsan123" }),
      FALLBACK_DISPLAY_NAME,
      "自设微信号没有 wxid_ 前缀，只能靠与 wxId 精确比对拦住",
    );
  });

  it("全部落空时给占位，绝不返回 wx_id", () => {
    assert.equal(
      resolveDisplayName([null, undefined, "", "wxid_only"], { wxId: "wxid_only" }),
      FALLBACK_DISPLAY_NAME,
    );
  });

  it("语境化兜底：个人页可以用「我」这类占位", () => {
    assert.equal(resolveDisplayName([null], { fallback: "我" }), "我");
  });
});

describe("展示路径不泄露 wx_id（数据库往返）", () => {
  type DbModule = typeof import("@/lib/db");
  type SchemaModule = typeof import("@/lib/db/schema");
  type BoardModule = typeof import("@/lib/queries/leaderboard");

  let dbm: DbModule;
  let schema: SchemaModule;
  let board: BoardModule;

  const G = "g1@chatroom";
  const NAMED = "wxid_named";
  const NAMELESS = "wxid_nameless";
  const POISONED = "wxid_poisoned";

  before(async () => {
    dbm = await import("@/lib/db");
    schema = await import("@/lib/db/schema");
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
    migrate(dbm.db, { migrationsFolder: "./drizzle" });
    board = await import("@/lib/queries/leaderboard");

    dbm.db
      .insert(schema.people)
      .values([
        { wxId: NAMED, displayName: "有名字的" },
        // 存量脏数据：displayName 里存的就是 wx_id
        { wxId: POISONED, displayName: POISONED },
      ])
      .run();

    dbm.db
      .insert(schema.dailyStats)
      .values([
        { wxId: NAMED, convId: G, date: "2026-08-08", messages: 10, qualityMessages: 9 },
        { wxId: NAMELESS, convId: G, date: "2026-08-08", messages: 10, qualityMessages: 5 },
        { wxId: POISONED, convId: G, date: "2026-08-08", messages: 10, qualityMessages: 3 },
      ])
      .run();
  });

  /*
   * 这几条测的是**名字兜底**，所以要以成员身份看。
   *
   * 访客那一侧另有一层：没注册过本站的人一律显示「群成员」——
   * 那是「不给看」，和这里的「查不到名字」是两件事，
   * 混在一起的话，一个真的没有昵称的人和一个没注册的人
   * 会长成同一个样子，而它们该由不同的机制去修。
   */
  const asMember = { id: "u_me", wxId: "wx_me" } as never;

  it("排行榜：没有 people 记录的人显示占位，不显示 wx_id", () => {
    const entries = board.getLeaderboard({ convIds: [G], period: "all", viewer: asMember });
    const nameless = entries.find((e) => e.wxId === NAMELESS);
    assert.equal(nameless?.name, FALLBACK_DISPLAY_NAME);
  });

  it("**排行榜：存量脏数据（displayName 存的是 wx_id）也被拦住**", () => {
    // 这是对历史数据的兜底 —— 修了同步逻辑不等于老数据自动变干净
    const entries = board.getLeaderboard({ convIds: [G], period: "all", viewer: asMember });
    const poisoned = entries.find((e) => e.wxId === POISONED);
    assert.equal(poisoned?.name, FALLBACK_DISPLAY_NAME);
  });

  it("排行榜：有正常昵称的人不受影响", () => {
    const entries = board.getLeaderboard({ convIds: [G], period: "all", viewer: asMember });
    assert.equal(entries.find((e) => e.wxId === NAMED)?.name, "有名字的");
  });

  it("people 同步的兜底不再把 wx_id 写进 displayName", async () => {
    // 造一个只有消息、没有任何昵称来源的人：
    // sender_name 为空，也不在任何群名册里
    dbm.db
      .insert(schema.groups)
      .values({ convId: G, name: "测试群", syncEnabled: true, bound: true })
      .run();
    dbm.db
      .insert(schema.messages)
      .values({
        id: "m1",
        convId: G,
        senderWxId: "wxid_ghost",
        senderName: "wxid_ghost", // 上游对部分账号的 name 就是 wx_id
        content: "hello",
        type: "text",
        ts: Date.now(),
        isSend: false,
      })
      .run();

    const { syncPeople } = await import("@/lib/sync/people");
    await syncPeople();

    const row = dbm.db
      .select()
      .from(schema.people)
      .all()
      .find((p) => p.wxId === "wxid_ghost");
    assert.ok(row, "同步后应有 people 记录");
    assert.equal(
      row.displayName,
      FALLBACK_DISPLAY_NAME,
      "拿不到昵称时写占位；写 wx_id 的话所有展示这个名字的页面都会泄露它",
    );
  });
});
