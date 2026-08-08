import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { canSeePost, GUEST, normalizePostVisibility } from "@/lib/forum/visibility";

/**
 * 群聊转帖的同意流程测试。
 *
 * 「一键成帖」加上「未登录可看论坛」，一次误操作就能把私密群聊
 * 送上公网，而且不可撤回。所以这里每一条规则都要断言。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-convert-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type QueriesModule = typeof import("@/lib/forum/convert-queries");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let queries: QueriesModule;
let dbm: DbModule;
let schema: SchemaModule;

const POST = "p_converted";
const GROUP = "g1@chatroom";
const ALICE = "wx_alice";
const BOB = "wx_bob";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  queries = await import("@/lib/forum/convert-queries");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function setConsent(entries: { wxId: string; status: "pending" | "granted" | "denied" }[]) {
  dbm.db.delete(schema.postSources).run();
  dbm.db
    .insert(schema.postSources)
    .values({
      postId: POST,
      convId: GROUP,
      messageIds: ["m1", "m2"],
      convertedBy: "u_converter",
      consentLog: entries,
      consentStatus: "pending",
    })
    .run();
}

describe("转帖强制锁定可见性", () => {
  it("**不管请求什么，转帖都只能是 group 且锁定**", () => {
    for (const requested of ["public", "unlisted", "member", "private"] as const) {
      const result = normalizePostVisibility({
        requested,
        boardMax: "public",
        fromGroupChat: true,
        sourceGroupId: GROUP,
      });
      assert.equal(result.visibility, "group", `请求 ${requested} 时仍必须是 group`);
      assert.equal(result.locked, true);
      assert.equal(result.visibilityGroupId, GROUP);
    }
  });

  it("即使标记成 public，访客与外部用户也看不到", () => {
    const leaked = {
      visibility: "public" as const,
      authorId: "u_x",
      status: "published" as const,
      fromGroupChat: true,
    };
    assert.equal(canSeePost(leaked, GUEST).visible, false);
    assert.equal(
      canSeePost(leaked, {
        userId: "u_e",
        kind: "external",
        groupIds: [],
        roleIds: [],
        canModerate: false,
      }).visible,
      false,
    );
  });
});

describe("同意状态统计", () => {
  it("非转帖返回未转换", () => {
    dbm.db.delete(schema.postSources).run();
    const summary = queries.consentSummary(POST, ALICE);
    assert.equal(summary.isConverted, false);
    assert.equal(summary.canRaise, false);
  });

  it("全部待表态时不能提升", () => {
    setConsent([
      { wxId: ALICE, status: "pending" },
      { wxId: BOB, status: "pending" },
    ]);
    const summary = queries.consentSummary(POST, ALICE);
    assert.equal(summary.pending, 2);
    assert.equal(summary.canRaise, false);
  });

  it("**部分同意也不能提升 —— 多数同意在这里不成立**", () => {
    // 被拒绝的那个人的发言依然会被公开，所以必须全体同意
    setConsent([
      { wxId: ALICE, status: "granted" },
      { wxId: BOB, status: "pending" },
    ]);
    assert.equal(queries.consentSummary(POST, ALICE).canRaise, false);
  });

  it("有人拒绝就永远不能提升", () => {
    setConsent([
      { wxId: ALICE, status: "granted" },
      { wxId: BOB, status: "denied" },
    ]);
    const summary = queries.consentSummary(POST, ALICE);
    assert.equal(summary.denied, 1);
    assert.equal(summary.canRaise, false);
  });

  it("全体同意才能提升", () => {
    setConsent([
      { wxId: ALICE, status: "granted" },
      { wxId: BOB, status: "granted" },
    ]);
    assert.equal(queries.consentSummary(POST, ALICE).canRaise, true);
  });

  it("空名单不算全体同意", () => {
    // 名单为空时 every() 恒真，不特判会变成「没人反对即通过」
    setConsent([]);
    assert.equal(queries.consentSummary(POST, ALICE).canRaise, false);
  });

  it("能看出当前查看者自己表过态没有", () => {
    setConsent([
      { wxId: ALICE, status: "granted" },
      { wxId: BOB, status: "pending" },
    ]);
    assert.equal(queries.consentSummary(POST, ALICE).myStatus, "granted");
    assert.equal(queries.consentSummary(POST, BOB).myStatus, "pending");
    assert.equal(queries.consentSummary(POST, "wx_stranger").myStatus, null);
    assert.equal(queries.consentSummary(POST, null).myStatus, null);
  });
});
