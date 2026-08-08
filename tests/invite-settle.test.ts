import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 邀请奖励的结算与回滚。
 *
 * 邀请体系最容易变成刷分工具 —— 拉一个僵尸号的成本几乎为零。
 * 这组测试锁的就是让刷邀请不划算的那几条：
 *   奖励延迟到「被邀请人真的用起来」才发、
 *   被封时回滚、
 *   同一次邀请只发一笔。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-invite-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type Settle = typeof import("@/lib/invites/settle");
type Ledger = typeof import("@/lib/points/ledger");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let settle: Settle;
let ledger: Ledger;
let dbm: DbModule;
let schema: SchemaModule;

const INVITER = "u_inviter";
const INVITEE = "u_invitee";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { seedDatabase } = await import("@/lib/db/seed");
  seedDatabase();
  settle = await import("@/lib/invites/settle");
  ledger = await import("@/lib/points/ledger");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.inviteUses).run();
  dbm.db.delete(schema.invites).run();
  dbm.db.delete(schema.pointsLedger).run();
  dbm.db.delete(schema.users).run();

  dbm.db
    .insert(schema.users)
    .values([
      { id: INVITER, wxId: "wx_a", siteNickname: "邀请人", status: "active", points: 0, pointsTotal: 0 },
      { id: INVITEE, wxId: "wx_b", siteNickname: "被邀请人", status: "active", points: 0, pointsTotal: 0 },
    ])
    .run();

  dbm.db
    .insert(schema.invites)
    .values({ id: "inv1", code: "AAAA3333", createdBy: INVITER, maxUses: 5 })
    .run();

  dbm.db
    .insert(schema.inviteUses)
    .values({ id: "use1", inviteId: "inv1", inviterId: INVITER, invitedUserId: INVITEE })
    .run();
});

function checkIn(date = "2026-08-09") {
  dbm.db.update(schema.users).set({ lastCheckinDate: date }).where(eq(schema.users.id, INVITEE)).run();
}

function inviterPoints(): number {
  return dbm.db.select().from(schema.users).where(eq(schema.users.id, INVITER)).get()!.points;
}

describe("延迟发放", () => {
  it("**只注册没打卡时不发** —— 否则拉一堆僵尸号就能刷分", () => {
    assert.equal(settle.settleInviteReward(INVITEE), false);
    assert.equal(inviterPoints(), 0);
  });

  it("完成首次打卡后才发", () => {
    checkIn();
    assert.equal(settle.settleInviteReward(INVITEE), true);
    assert.ok(inviterPoints() > 0);
  });

  it("发放后在使用记录上留痕", () => {
    checkIn();
    settle.settleInviteReward(INVITEE);

    const use = dbm.db.select().from(schema.inviteUses).get()!;
    assert.ok(use.rewardedAt);
    assert.ok(use.rewardPoints && use.rewardPoints > 0);
  });

  it("**同一次邀请只发一笔**", () => {
    checkIn();
    settle.settleInviteReward(INVITEE);
    const after = inviterPoints();

    assert.equal(settle.settleInviteReward(INVITEE), false, "第二次不该再发");
    assert.equal(inviterPoints(), after);
  });

  it("被邀请人已被封时不发", () => {
    checkIn();
    dbm.db.update(schema.users).set({ status: "banned" }).where(eq(schema.users.id, INVITEE)).run();

    assert.equal(settle.settleInviteReward(INVITEE), false);
    assert.equal(inviterPoints(), 0);
  });

  it("没有邀请关系的人不会凭空发分", () => {
    dbm.db.delete(schema.inviteUses).run();
    checkIn();
    assert.equal(settle.settleInviteReward(INVITEE), false);
  });
});

describe("回滚", () => {
  it("**被邀请人被封时把奖励冲正** —— 否则刷号被抓也不亏", () => {
    checkIn();
    settle.settleInviteReward(INVITEE);
    const rewarded = inviterPoints();
    assert.ok(rewarded > 0);

    dbm.db.update(schema.users).set({ status: "banned" }).where(eq(schema.users.id, INVITEE)).run();
    assert.equal(settle.revertInviteReward(INVITEE, "刷号"), true);
    assert.equal(inviterPoints(), 0);
  });

  it("**走冲正而不是直接扣** —— 流水只增不改", () => {
    checkIn();
    settle.settleInviteReward(INVITEE);
    dbm.db.update(schema.users).set({ status: "banned" }).where(eq(schema.users.id, INVITEE)).run();
    settle.revertInviteReward(INVITEE, "刷号");

    const entries = dbm.db.select().from(schema.pointsLedger).all();
    assert.equal(entries.length, 2, "应该是一正一反两条，而不是改掉原来那条");
    assert.ok(entries.some((e) => e.delta > 0));
    assert.ok(entries.some((e) => e.delta < 0));
    assert.equal(ledger.auditBalance(INVITER).consistent, true);
  });

  it("回滚后在使用记录上留痕", () => {
    checkIn();
    settle.settleInviteReward(INVITEE);
    dbm.db.update(schema.users).set({ status: "banned" }).where(eq(schema.users.id, INVITEE)).run();
    settle.revertInviteReward(INVITEE, "确认是小号");

    const use = dbm.db.select().from(schema.inviteUses).get()!;
    assert.ok(use.revertedAt);
    assert.match(use.revertReason!, /小号/);
  });

  it("**不会回滚两次**", () => {
    checkIn();
    settle.settleInviteReward(INVITEE);
    dbm.db.update(schema.users).set({ status: "banned" }).where(eq(schema.users.id, INVITEE)).run();

    assert.equal(settle.revertInviteReward(INVITEE, "一"), true);
    assert.equal(settle.revertInviteReward(INVITEE, "二"), false);
    assert.equal(inviterPoints(), 0);
  });

  it("没发过的没得回滚", () => {
    dbm.db.update(schema.users).set({ status: "banned" }).where(eq(schema.users.id, INVITEE)).run();
    assert.equal(settle.revertInviteReward(INVITEE, "刷号"), false);
  });

  it("**暂停不回滚** —— 暂停是可逆的，封禁才是定论", () => {
    checkIn();
    settle.settleInviteReward(INVITEE);
    dbm.db.update(schema.users).set({ status: "suspended" }).where(eq(schema.users.id, INVITEE)).run();

    assert.equal(settle.revertInviteReward(INVITEE, "暂停"), false);
    assert.ok(inviterPoints() > 0);
  });

  it("**回滚之后不会因为解封而重新发放**", () => {
    checkIn();
    settle.settleInviteReward(INVITEE);
    dbm.db.update(schema.users).set({ status: "banned" }).where(eq(schema.users.id, INVITEE)).run();
    settle.revertInviteReward(INVITEE, "刷号");

    // 解封
    dbm.db.update(schema.users).set({ status: "active" }).where(eq(schema.users.id, INVITEE)).run();
    assert.equal(settle.settleInviteReward(INVITEE), false, "封了再解封不该能重领");
    assert.equal(inviterPoints(), 0);
  });
});

describe("批量补结算", () => {
  it("**能补上流程漏掉的发放**", () => {
    // 结算挂在打卡流程上，但流程可能因为改代码或异常漏掉
    checkIn();
    const result = settle.settleAllPending();
    assert.equal(result.settled, 1);
    assert.ok(inviterPoints() > 0);
  });

  it("能补上流程漏掉的回滚", () => {
    checkIn();
    settle.settleInviteReward(INVITEE);
    dbm.db.update(schema.users).set({ status: "banned" }).where(eq(schema.users.id, INVITEE)).run();

    const result = settle.settleAllPending();
    assert.equal(result.reverted, 1);
    assert.equal(inviterPoints(), 0);
  });

  it("重复跑是安全的", () => {
    checkIn();
    settle.settleAllPending();
    const after = inviterPoints();

    const second = settle.settleAllPending();
    assert.equal(second.settled, 0);
    assert.equal(inviterPoints(), after);
  });

  it("没有任何邀请时不炸", () => {
    dbm.db.delete(schema.inviteUses).run();
    assert.deepEqual(settle.settleAllPending(), { settled: 0, reverted: 0 });
  });
});
