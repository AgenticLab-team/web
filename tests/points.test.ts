import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 积分记账测试。
 *
 * 积分一旦说不清，整个激励体系就失去公信力 ——
 * 所以「流水是唯一真值」「只增不改」「余额可对账」这三条必须锁死。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-points-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type LedgerModule = typeof import("@/lib/points/ledger");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let ledger: LedgerModule;
let dbm: DbModule;
let schema: SchemaModule;

const ALICE = "u_alice";
const BOB = "u_bob";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  ledger = await import("@/lib/points/ledger");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.pointsLedger).run();
  dbm.db.delete(schema.users).run();
  dbm.db
    .insert(schema.users)
    .values([
      { id: ALICE, wxId: "wx_alice", points: 0, pointsTotal: 0 },
      { id: BOB, wxId: "wx_bob", points: 0, pointsTotal: 0 },
    ])
    .run();
});

describe("记账基本规则", () => {
  it("加分后余额与流水一致", () => {
    const r = ledger.grantPoints({ userId: ALICE, delta: 50, reason: "测试加分" });
    assert.equal(r.ok, true);
    assert.equal(r.balance, 50);
    assert.equal(ledger.auditBalance(ALICE).consistent, true);
  });

  it("**理由不能为空**", () => {
    const r = ledger.grantPoints({ userId: ALICE, delta: 10, reason: "   " });
    assert.equal(r.ok, false);
    assert.match(r.error!, /理由/);
  });

  it("变动值必须是非零整数", () => {
    assert.equal(ledger.grantPoints({ userId: ALICE, delta: 0, reason: "零" }).ok, false);
    assert.equal(ledger.grantPoints({ userId: ALICE, delta: 1.5, reason: "小数" }).ok, false);
  });

  it("**余额不能扣成负数**", () => {
    // 余额为负会让所有基于余额的判断都失效
    ledger.grantPoints({ userId: ALICE, delta: 10, reason: "先加" });
    const r = ledger.grantPoints({ userId: ALICE, delta: -50, reason: "超额扣" });
    assert.equal(r.ok, false);
    assert.match(r.error!, /不足/);
    assert.equal(ledger.auditBalance(ALICE).cached, 10, "失败的扣分不该改变余额");
  });

  it("累计获得只增不减，花掉的分不该让人掉级", () => {
    ledger.grantPoints({ userId: ALICE, delta: 100, reason: "赚" });
    ledger.grantPoints({ userId: ALICE, delta: -40, reason: "花" });
    const user = dbm.db.select().from(schema.users).all().find((u) => u.id === ALICE)!;
    assert.equal(user.points, 60, "余额扣掉了");
    assert.equal(user.pointsTotal, 100, "累计获得不该跟着减");
  });

  it("记录余额快照，可逐条对账", () => {
    ledger.grantPoints({ userId: ALICE, delta: 30, reason: "一" });
    ledger.grantPoints({ userId: ALICE, delta: 20, reason: "二" });
    const rows = ledger.listLedger(ALICE).reverse();
    assert.deepEqual(rows.map((r) => r.balanceAfter), [30, 50]);
  });
});

describe("幂等", () => {
  it("同一个幂等键只记一次账", () => {
    // 定时任务失败重跑是常态，没有幂等键每重跑一次就多发一次分
    const key = "checkin:alice:2026-08-09";
    const first = ledger.grantPoints({ userId: ALICE, delta: 10, reason: "打卡", idempotencyKey: key });
    const second = ledger.grantPoints({ userId: ALICE, delta: 10, reason: "打卡", idempotencyKey: key });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true, "第二次应识别为重复");
    assert.equal(ledger.auditBalance(ALICE).cached, 10, "只该加一次");
  });

  it("不同幂等键各记各的", () => {
    ledger.grantPoints({ userId: ALICE, delta: 10, reason: "第一天", idempotencyKey: "d1" });
    ledger.grantPoints({ userId: ALICE, delta: 10, reason: "第二天", idempotencyKey: "d2" });
    assert.equal(ledger.auditBalance(ALICE).cached, 20);
  });
});

describe("冲正", () => {
  it("冲正写反向流水，不改原记录", () => {
    ledger.grantPoints({ userId: ALICE, delta: 100, reason: "误发" });
    const original = ledger.listLedger(ALICE)[0];

    const r = ledger.revertPoints(original.id, "u_admin", "发错了");
    assert.equal(r.ok, true);
    assert.equal(ledger.auditBalance(ALICE).cached, 0);

    const rows = ledger.listLedger(ALICE);
    assert.equal(rows.length, 2, "冲正是新增一条，不是删掉原来那条");
    const stillOriginal = rows.find((x) => x.id === original.id)!;
    assert.equal(stillOriginal.delta, 100, "原记录必须原样保留");
  });

  it("同一条流水不能冲正两次", () => {
    ledger.grantPoints({ userId: ALICE, delta: 100, reason: "误发" });
    const original = ledger.listLedger(ALICE)[0];
    ledger.revertPoints(original.id, "u_admin", "第一次");
    const second = ledger.revertPoints(original.id, "u_admin", "第二次");
    assert.equal(second.ok, false);
  });

  it("冲正后余额仍然对得上", () => {
    ledger.grantPoints({ userId: ALICE, delta: 80, reason: "一" });
    const target = ledger.listLedger(ALICE)[0];
    ledger.grantPoints({ userId: ALICE, delta: 20, reason: "二" });
    ledger.revertPoints(target.id, "u_admin", "撤销第一笔");
    assert.equal(ledger.auditBalance(ALICE).consistent, true);
    assert.equal(ledger.auditBalance(ALICE).cached, 20);
  });
});

describe("转移（悬赏采纳用）", () => {
  it("一边扣一边加，余额守恒", () => {
    ledger.grantPoints({ userId: ALICE, delta: 100, reason: "初始" });
    const r = ledger.transferPoints({
      fromUserId: ALICE,
      toUserId: BOB,
      amount: 30,
      reason: "悬赏采纳",
    });
    assert.equal(r.ok, true);
    assert.equal(ledger.auditBalance(ALICE).cached, 70);
    assert.equal(ledger.auditBalance(BOB).cached, 30);
  });

  it("余额不足时整笔失败，不会只扣不加", () => {
    ledger.grantPoints({ userId: ALICE, delta: 10, reason: "初始" });
    const r = ledger.transferPoints({
      fromUserId: ALICE,
      toUserId: BOB,
      amount: 50,
      reason: "悬赏",
    });
    assert.equal(r.ok, false);
    assert.equal(ledger.auditBalance(ALICE).cached, 10, "失败后付款方余额不变");
    assert.equal(ledger.auditBalance(BOB).cached, 0, "收款方也不该有变化");
  });

  it("不能转给自己", () => {
    ledger.grantPoints({ userId: ALICE, delta: 100, reason: "初始" });
    assert.equal(
      ledger.transferPoints({ fromUserId: ALICE, toUserId: ALICE, amount: 10, reason: "自转" }).ok,
      false,
    );
  });

  it("带幂等键的转移重复调用不会转两次", () => {
    ledger.grantPoints({ userId: ALICE, delta: 100, reason: "初始" });
    const args = {
      fromUserId: ALICE,
      toUserId: BOB,
      amount: 30,
      reason: "悬赏采纳",
      idempotencyKey: "bounty:p1",
    };
    ledger.transferPoints(args);
    ledger.transferPoints(args);
    assert.equal(ledger.auditBalance(ALICE).cached, 70, "只该转一次");
    assert.equal(ledger.auditBalance(BOB).cached, 30);
  });
});

describe("对账", () => {
  it("缓存列被人直接改过时能查出来", () => {
    // 这是发现「有人直接改库」或「某处漏走流水」的唯一手段
    ledger.grantPoints({ userId: ALICE, delta: 50, reason: "正常" });
    dbm.db.update(schema.users).set({ points: 999 }).run();

    const audit = ledger.auditBalance(ALICE);
    assert.equal(audit.consistent, false);
    assert.equal(audit.cached, 999);
    assert.equal(audit.computed, 50);
  });
});
