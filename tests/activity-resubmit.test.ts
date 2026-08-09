import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { checkDomainName } from "@/lib/activities/modules/domain";
import { MAX_RESUBMITS, RESUBMITTABLE, canResubmit } from "@/lib/activities/resubmit-rules";
import { canTransitionApplication, holdsQuota, quotaDelta } from "@/lib/activities/state";

/**
 * 撤回之后重新编辑域名。
 *
 * ─────────────────────────────────────────
 * 撤回一次等于把自己锁死
 * ─────────────────────────────────────────
 *
 * 撤回是「我想换一个域名」时唯一能点的东西，但撤回之后
 * `cancelled` 是终态、页面上那条已撤回的记录又一直占着表单的位置 ——
 * 结果是既撤不了也提交不了。
 *
 * ─────────────────────────────────────────
 * 改的必须是**同一行**
 * ─────────────────────────────────────────
 *
 * 名额、域名唯一性、每人限额三道判定全是按「在途的申请」数的。
 * 每重提一次就新建一行的话，一个人会在一个活动里攒下一串申请，
 * 任何一道判漏，那串就变成一堆被这个人占住的域名。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

const base = {
  isOwner: true,
  status: "cancelled" as const,
  activityOpen: true,
  otherActiveApplications: 0,
  perUserLimit: 1,
  submitCount: 1,
};

describe("**什么状态下才让改**", () => {
  it("撤回掉的可以改了重提 —— 这就是这次要加的", () => {
    assert.equal(canResubmit(base).ok, true);
  });

  it("判无效、被驳回、履约失败、过期的也一样", () => {
    for (const status of ["invalid", "rejected", "failed", "expired"] as const) {
      assert.equal(canResubmit({ ...base, status }).ok, true, status);
      assert.equal(RESUBMITTABLE.has(status), true);
    }
  });

  it("**还在途的不能直接改** —— 要改先撤回", () => {
    /*
     * 允许直接改的话，「改域名」就绕开了撤回那一步 ——
     * 而撤回正是把名额和原来那个域名还回去的地方。
     * 结果会是名额还挂在旧的那次上，域名却已经换成新的了。
     */
    for (const status of ["submitted", "waitlisted", "approved"] as const) {
      const check = canResubmit({ ...base, status });
      assert.equal(check.ok, false, status);
      assert.match(check.reason!, /先撤回/);
    }
  });

  it("已经拿到手的不能再改", () => {
    assert.equal(canResubmit({ ...base, status: "fulfilled" }).ok, false);
  });

  it("不是本人的申请，连状态都不告诉他", () => {
    const check = canResubmit({ ...base, isOwner: false, status: "cancelled" });
    assert.equal(check.ok, false);
    assert.match(check.reason!, /不是你的申请/);
  });

  it("活动关了就不能再提 —— 撤回不是一张过期不作废的票", () => {
    const check = canResubmit({ ...base, activityOpen: false, activityClosedReason: "已经截止了" });
    assert.equal(check.ok, false);
    assert.match(check.reason!, /已经截止了/);
  });
});

describe("**重提不能变成占名额的口子**", () => {
  it("另外还有在途的申请时，重提要按每人限额挡住", () => {
    /*
     * 这是「一个人占一堆域名」的入口：撤回 A、新申请 B，
     * 然后再把 A 改一改提回来 —— 如果这里不数 B，他就有两份了。
     */
    const check = canResubmit({ ...base, otherActiveApplications: 1, perUserLimit: 1 });
    assert.equal(check.ok, false);
    assert.match(check.reason!, /每人最多同时有 1 份/);
  });

  it("限额是 2 的活动里，另有 1 份在途仍然可以重提", () => {
    assert.equal(canResubmit({ ...base, otherActiveApplications: 1, perUserLimit: 2 }).ok, true);
  });

  it("**反复撤回—重提有次数上限** —— 否则等于拿站点当域名扫描器", () => {
    /*
     * 它不占名额（每一刻都只占一个），但会一直打注册商的 RDAP。
     * 5 次够一个人改主意，不够拿来扫描。
     */
    assert.equal(canResubmit({ ...base, submitCount: MAX_RESUBMITS - 1 }).ok, true);
    const check = canResubmit({ ...base, submitCount: MAX_RESUBMITS });
    assert.equal(check.ok, false);
    assert.match(check.reason!, /改过 5 次/);
  });

  it("归属判在最前面 —— 别人的申请不该因为「次数够了」才被拒", () => {
    const check = canResubmit({ ...base, isOwner: false, submitCount: 99, activityOpen: false });
    assert.match(check.reason!, /不是你的申请/);
  });
});

describe("状态机与名额账", () => {
  it("**撤回之后能回到已提交** —— 以前这里是终态", () => {
    assert.equal(canTransitionApplication("cancelled", "submitted").ok, true);
  });

  it("名额被抢光时能落到候补，而不是卡在「撤回了也回不去」", () => {
    assert.equal(canTransitionApplication("cancelled", "waitlisted").ok, true);
  });

  it("已履约的仍然是终态 —— 东西已经给出去了", () => {
    assert.equal(canTransitionApplication("fulfilled", "submitted").ok, false);
  });

  it("撤回还一个名额，重提再占一个 —— 一进一出对得上", () => {
    assert.equal(quotaDelta("submitted", "cancelled"), -1);
    assert.equal(quotaDelta("cancelled", "submitted"), 1);
    // 落到候补时不占 —— 占了的话候补就没有意义了
    assert.equal(quotaDelta("cancelled", "waitlisted"), 0);
    assert.equal(holdsQuota("cancelled"), false);
  });
});

describe("**重提照样只发普通域名**", () => {
  const TLDS = ["icu"];

  it("溢价的挡在同一道校验上 —— 重提走的是同一个 validate", () => {
    assert.match(checkDomainName("12345678", TLDS, "icu").error!, /纯数字/);
    assert.match(checkDomainName("aaaaaa", TLDS, "icu").error!, /同一个字符/);
    assert.match(checkDomainName("abc", TLDS, "icu").error!, /更短的域名值钱/);
  });

  it("后缀只能是 .icu", () => {
    assert.match(checkDomainName("agentic-lab", TLDS, "com").error!, /后缀只能选 icu/);
    assert.equal(checkDomainName("agentic-lab", TLDS, "icu").normalized, "agentic-lab.icu");
  });
});

describe("接线", () => {
  const actions = strip(src("lib/activities/actions.ts"));

  it("重提走 canResubmit，判定不散在动作里", () => {
    assert.match(actions, /canResubmit\(\{/);
  });

  it("**每人限额的口径和首次申请一模一样**", () => {
    /*
     * 两处口径不同的话，走重提这条路就能绕开每人限额 ——
     * 而那正是「一个人占一堆域名」的入口。
     */
    const clause = /NOT IN \('invalid','rejected','cancelled','expired','failed'\)/g;
    assert.equal((actions.match(clause) ?? []).length, 2, "首次申请与重提各一处");
  });

  it("**改的是同一行**，不是 insert 一行新的", () => {
    const fn = actions.slice(
      actions.indexOf("export async function resubmitApplication"),
      actions.indexOf("export async function cancelApplication"),
    );
    assert.equal(/insert\(activityApplications\)/.test(fn), false, "重提又新建了一行");
    assert.match(fn, /to: "submitted"/);
    assert.match(fn, /patch: \{/);
  });

  it("**资格重新算，不吃申请时那份快照** —— 快照会变成永久通行证", () => {
    const fn = actions.slice(
      actions.indexOf("export async function resubmitApplication"),
      actions.indexOf("export async function cancelApplication"),
    );
    assert.match(fn, /computeStatsFor\(user\.id\)/);
    assert.match(fn, /evaluateEligibility\(/);
    // 而且把新的快照写回去，事后对账才对得上人
    assert.match(fn, /eligibilitySnapshot: stats/);
  });

  it("域名没换就不重查 RDAP —— 否则重提就是在打注册局", () => {
    assert.match(actions, /validation\.normalizedKey !== app\.normalizedKey/);
  });

  it("**状态、名额、内容在同一次 transition 里落**", () => {
    // 内容单独先写的话，中间失败会留下「状态是旧的、域名已经换了」的记录
    assert.match(actions, /patch\?: \{/);
    assert.match(actions, /normalizedKey: input\.patch \? \(input\.patch\.normalizedKey \?\? null\) : undefined/);
  });

  it("**撞了唯一索引要把刚占的名额还回去** —— 不还就是永久蒸发一个", () => {
    assert.match(actions, /reason: "状态流转失败，归还名额"/);
    assert.match(actions, /message\.includes\("UNIQUE"\)/);
  });

  it("落到候补时排队尾，不插回原来的位置", () => {
    assert.match(actions, /queuePosition: waitlisted \? nextQueuePosition\(app\.activityId\) : undefined/);
  });

  it("**页面上撤回之后真的还找得到入口**", () => {
    /*
     * 以前是 mine.find(...)，撤回之后找到的还是那条已撤回的记录，
     * 于是表单一直显示「你已经登记了 xxx（已撤回）」—— 死路一条。
     */
    const page = strip(src("app/(app)/activities/page.tsx"));
    assert.match(page, /ours\.find\(\(m\) => !RESUBMITTABLE\.has\(m\.status\)\)/);
    assert.match(page, /resumable/);
    // 上次填的原样带回表单，而不是让人从空白重填
    assert.match(page, /resume=\{/);
    assert.match(strip(src("components/activities/ApplyForm.tsx")), /resubmitApplication\(\{ id: resume\.id/);
  });

  it("**规则层是纯的**", () => {
    const rules = src("lib/activities/resubmit-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(rules.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});

/* ───────────────────────────────────────────────────────────────
 * 真数据库：撤回到底有没有把东西还干净
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-resubmit-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let quota: typeof import("@/lib/activities/quota");
let eq: typeof import("drizzle-orm").eq;

const ACT = "act1";
const ME = "u_me";
const OTHER = "u_other";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  quota = await import("@/lib/activities/quota");
  ({ eq } = await import("drizzle-orm"));
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.activityQuotaLog).run();
  dbm.db.delete(schema.activityApplications).run();
  dbm.db.delete(schema.activities).run();
  dbm.db
    .insert(schema.activities)
    .values({
      id: ACT,
      moduleKey: "domain",
      title: "域名发放",
      quotaTotal: 1,
      perUserLimit: 1,
      status: "open",
      createdBy: "u_admin",
      config: { tlds: ["icu"] },
    })
    .run();
});

/** 登记一条在途申请，并占掉一个名额 —— 和 applyToActivity 的落库口径一致 */
function apply(userId: string, domain: string): string {
  quota.claimQuota({ activityId: ACT, applicationId: "pending", reason: `申请：${userId}` });
  return dbm.db
    .insert(schema.activityApplications)
    .values({ activityId: ACT, userId, normalizedKey: domain, status: "submitted" })
    .returning({ id: schema.activityApplications.id })
    .get().id;
}

/** 撤回：还名额、改状态 —— transition 里 quotaDelta 走的就是这一步 */
function cancel(id: string) {
  quota.releaseQuota({ activityId: ACT, applicationId: id, reason: "状态变为 cancelled" });
  dbm.db
    .update(schema.activityApplications)
    .set({ status: "cancelled" })
    .where(eq(schema.activityApplications.id, id))
    .run();
}

const used = () => dbm.db.select().from(schema.activities).where(eq(schema.activities.id, ACT)).get()!.quotaUsed;

describe("撤回释放得干不干净（真数据）", () => {
  it("**撤回把名额还回去了**", () => {
    const id = apply(ME, "wanted.icu");
    assert.equal(used(), 1);
    cancel(id);
    assert.equal(used(), 0);
    assert.equal(quota.auditQuota(ACT).consistent, true, "缓存列和流水对不上");
  });

  it("**撤回也把那个域名让出来了** —— 别人能登记同一个", () => {
    const id = apply(ME, "wanted.icu");
    cancel(id);
    assert.doesNotThrow(() => apply(OTHER, "wanted.icu"));
  });

  it("两条在途的同域名会被数据库挡住，不靠应用层查重", () => {
    /*
     * 应用层的「先查再插」在并发下必然漏：两个请求同时查到没人占，
     * 然后都插进去。
     */
    apply(ME, "wanted.icu");
    assert.throws(() => apply(OTHER, "wanted.icu"), /UNIQUE/);
  });
});

describe("**重提之后这个人还是只有一份**（真数据）", () => {
  const rowsOfMine = () =>
    dbm.db
      .select()
      .from(schema.activityApplications)
      .where(eq(schema.activityApplications.userId, ME))
      .all();

  it("改同一行：申请数不涨，域名换成新的，名额回到 1", () => {
    const id = apply(ME, "first.icu");
    cancel(id);

    // 重提 = 在同一行上换域名 + 重新占名额（transition 的 patch 干的事）
    quota.claimQuota({ activityId: ACT, applicationId: id, reason: "状态变为 submitted" });
    dbm.db
      .update(schema.activityApplications)
      .set({ status: "submitted", normalizedKey: "second.icu" })
      .where(eq(schema.activityApplications.id, id))
      .run();

    const rows = rowsOfMine();
    assert.equal(rows.length, 1, "重提多攒了一行申请");
    assert.equal(rows[0].normalizedKey, "second.icu");
    assert.equal(used(), 1);
    assert.equal(quota.auditQuota(ACT).consistent, true);
  });

  it("**撤回掉的那一行不占着旧域名** —— 改成新的之后旧的谁都能拿", () => {
    const id = apply(ME, "first.icu");
    cancel(id);
    dbm.db
      .update(schema.activityApplications)
      .set({ status: "submitted", normalizedKey: "second.icu" })
      .where(eq(schema.activityApplications.id, id))
      .run();

    assert.doesNotThrow(() => apply(OTHER, "first.icu"), "旧域名没让出来");
  });

  it("重提时新域名已经被别人占着 —— 数据库拦下来，名额要还回去", () => {
    const id = apply(ME, "first.icu");
    cancel(id);
    apply(OTHER, "taken.icu");

    quota.claimQuota({ activityId: ACT, applicationId: id, reason: "状态变为 submitted" });
    const before = used();
    assert.throws(
      () =>
        dbm.db
          .update(schema.activityApplications)
          .set({ status: "submitted", normalizedKey: "taken.icu" })
          .where(eq(schema.activityApplications.id, id))
          .run(),
      /UNIQUE/,
    );

    // 这一步就是 transition 的 catch 干的事：不还的话名额永久蒸发一个
    quota.releaseQuota({ activityId: ACT, applicationId: id, reason: "状态流转失败，归还名额" });
    assert.equal(used(), before - 1);
    assert.equal(quota.auditQuota(ACT).consistent, true);
  });
});
