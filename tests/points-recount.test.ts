import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  WIDE_IMPACT_RATIO,
  describePlan,
  isWideImpact,
  planRecount,
  type CachedFact,
  type LedgerFact,
} from "@/lib/points/recount-rules";
import { stripComments as strip } from "./_source";

/**
 * 积分重算（对账修复）。
 *
 * ─────────────────────────────────────────
 * 风控队列查得出来，但修不了
 * ─────────────────────────────────────────
 *
 * 上一轮做的风控队列会报「余额记着 999，流水加起来是 10」——
 * 而报完之后没有下一步。管理员唯一能做的是直接改库，
 * 而**直接改库正是造成这种不一致的原因**。
 *
 * `points.recount` 这个权限一直列在权限表里，零调用点。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

/** 简单门槛：0 / 50 / 150 */
const level = (total: number) => (total >= 150 ? 3 : total >= 50 ? 2 : 1);

const cached = (over: Partial<CachedFact> & { userId: string }): CachedFact => ({
  points: 0,
  pointsTotal: 0,
  level: 1,
  ...over,
});

describe("**方向只有一个：按流水重写缓存**", () => {
  it("对得上的不动", () => {
    const plan = planRecount(
      [cached({ userId: "a", points: 60, pointsTotal: 60, level: 2 })],
      [{ userId: "a", sum: 60, positiveSum: 60 }],
      level,
    );
    assert.deepEqual(plan.rows, []);
    assert.equal(plan.scanned, 1);
  });

  it("余额被人改过 —— 按流水改回来", () => {
    const plan = planRecount(
      [cached({ userId: "a", points: 999, pointsTotal: 999, level: 3 })],
      [{ userId: "a", sum: 10, positiveSum: 10 }],
      level,
    );
    assert.equal(plan.rows.length, 1);
    assert.deepEqual(plan.rows[0].points, { from: 999, to: 10 });
    assert.equal(plan.balanceChanges, 1);
    assert.equal(plan.netDelta, -989);
  });

  it("**一条流水都没有的人归零** —— 而不是保留缓存里那个数", () => {
    /*
     * 缓存里有分、流水里没有，只可能是有人直接写了 users 表。
     */
    const plan = planRecount([cached({ userId: "a", points: 50, pointsTotal: 50, level: 2 })], [], level);
    assert.deepEqual(plan.rows[0].points, { from: 50, to: 0 });
    assert.deepEqual(plan.rows[0].level, { from: 2, to: 1 });
  });
});

describe("**累计获得不能直接用流水总和**", () => {
  it("花掉的分不算进累计 —— 否则花积分的人会掉级", () => {
    /*
     * points_total 是「只增不减」的口径，等于所有正数流水之和。
     * 直接用总和的话，一个赚了 200 花了 180 的人会被算成累计 20，
     * 从 L3 掉到 L1 —— 而那正是当初分出两个字段要避免的事。
     */
    const plan = planRecount(
      [cached({ userId: "a", points: 20, pointsTotal: 200, level: 3 })],
      [{ userId: "a", sum: 20, positiveSum: 200 }],
      level,
    );
    assert.deepEqual(plan.rows, [], "把花掉的分从累计里扣掉了");
  });

  it("等级按累计算，不按余额", () => {
    const plan = planRecount(
      [cached({ userId: "a", points: 20, pointsTotal: 20, level: 1 })],
      [{ userId: "a", sum: 20, positiveSum: 200 }],
      level,
    );
    assert.deepEqual(plan.rows[0].pointsTotal, { from: 20, to: 200 });
    assert.deepEqual(plan.rows[0].level, { from: 1, to: 3 });
    assert.equal(plan.levelChanges, 1);
    // 余额没变 —— 不该算进「余额会变」那个数
    assert.equal(plan.balanceChanges, 0);
  });
});

describe("**改动面太大时要拦一下**", () => {
  const many = (n: number, mismatch: number) => {
    const users = Array.from({ length: n }, (_, i) =>
      cached({ userId: `u${i}`, points: 10, pointsTotal: 10, level: 1 }),
    );
    const ledger: LedgerFact[] = users.map((u, i) => ({
      userId: u.userId,
      sum: i < mismatch ? 0 : 10,
      positiveSum: i < mismatch ? 0 : 10,
    }));
    return planRecount(users, ledger, level);
  };

  it("只动几个人 —— 正常，不拦", () => {
    /*
     * 那是某次直接改库留下的痕迹，正是这个功能要修的东西。
     */
    assert.equal(isWideImpact(many(100, 3)), false);
  });

  it("**要动一半以上 —— 拦一下**", () => {
    /*
     * 更可能的解释是流水本身缺了一批（比如迁移漏抄），
     * 而这时候按流水重写缓存会把所有人的分抹掉。
     */
    assert.equal(isWideImpact(many(100, 60)), true);
  });

  it("刚好在线上不算 —— 阈值是「超过」", () => {
    assert.equal(isWideImpact(many(100, WIDE_IMPACT_RATIO * 100)), false);
  });

  it("空库不炸", () => {
    assert.equal(isWideImpact(planRecount([], [], level)), false);
  });
});

describe("预览那句话", () => {
  it("**没问题时说「对得上」**，不是「暂无数据」", () => {
    const plan = planRecount([cached({ userId: "a" })], [], level);
    assert.match(describePlan(plan), /对得上|不需要重算/);
  });

  it("有问题时把三个数都说出来", () => {
    const plan = planRecount(
      [cached({ userId: "a", points: 999, pointsTotal: 999, level: 3 })],
      [{ userId: "a", sum: 10, positiveSum: 10 }],
      level,
    );
    const text = describePlan(plan);
    assert.match(text, /1 个账号要改/);
    assert.match(text, /余额会变/);
    assert.match(text, /-989/);
  });
});

describe("接线", () => {
  it("**points.recount 这个权限终于有人用了**", () => {
    assert.match(strip(src("lib/points/recount-actions.ts")), /requireWritableAdmin\("points\.recount"\)/);
  });

  it("复用现成的 admin_tasks，不另起一套", () => {
    /*
     * 存储裁剪那条路已经是「出预览 → awaiting_confirm → 执行」了，
     * 表也是通用的。再造一套的话两套状态机早晚分叉，
     * 而「跑过没有」要去两个地方查。
     */
    const actions = strip(src("lib/points/recount-actions.ts"));
    assert.match(actions, /kind: "points\.recount"/);
    assert.match(actions, /status: "awaiting_confirm"/);
    assert.match(actions, /task\.status !== "awaiting_confirm"/);
  });

  it("**执行时重新算一遍**，不吃预览里那份", () => {
    /*
     * 预览和确认之间隔着人的一次思考，那段时间里分还在照常发。
     * 用预览那份落库会把中间的变动抹掉。
     */
    const actions = strip(src("lib/points/recount-actions.ts"));
    const fn = actions.slice(actions.indexOf("function executeRecount"));
    assert.match(fn, /const plan = buildPlan\(\);/);
    // 而且界面上要说出来，否则人以为预览的数就是最终会落库的数
    assert.match(src("components/admin/RecountPanel.tsx"), /执行时会重新算一遍/);
  });

  it("预览时的数和实际改的数一起进审计 —— 两者不一致本身就是信息", () => {
    const actions = strip(src("lib/points/recount-actions.ts"));
    assert.match(actions, /before: task\.preview/);
    assert.match(actions, /after: result/);
  });

  it("落库在一个事务里 —— 半边重算过的库比不一致更难查", () => {
    assert.match(strip(src("lib/points/recount.ts")), /db\.transaction/);
  });

  it("**只算不改的那一步是纯函数** —— 预览和执行才走得成同一条路", () => {
    const rules = src("lib/points/recount-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(rules.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });

  it("还挂着的任务会显示出来 —— 否则人以为上次点的预览丢了", () => {
    assert.match(src("app/(app)/admin/points/ledger/page.tsx"), /pendingRecount/);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 真数据库：SQL 那两个和算得对不对
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-recount-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let ledgerLib: typeof import("@/lib/points/ledger");
let recount: typeof import("@/lib/points/recount");
let eq: typeof import("drizzle-orm").eq;

const USER = "u_a";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  ledgerLib = await import("@/lib/points/ledger");
  recount = await import("@/lib/points/recount");
  ({ eq } = await import("drizzle-orm"));
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.pointsLedger).run();
  dbm.db.delete(schema.users).run();
  dbm.db.insert(schema.users).values({ id: USER, wxId: "wx_a", status: "active" }).run();
});

describe("重算（真数据）", () => {
  it("正常记账之后不需要重算", () => {
    ledgerLib.grantPoints({ userId: USER, delta: 60, reason: "发" });
    assert.deepEqual(recount.buildPlan().rows, []);
  });

  it("**有人直接改了库 —— 重算修回来**", () => {
    ledgerLib.grantPoints({ userId: USER, delta: 60, reason: "发" });
    dbm.db.update(schema.users).set({ points: 9999 }).where(eq(schema.users.id, USER)).run();

    const plan = recount.buildPlan();
    assert.equal(plan.rows.length, 1);

    recount.applyPlan(plan);
    const user = dbm.db.select().from(schema.users).where(eq(schema.users.id, USER)).get();
    assert.equal(user?.points, 60);
    assert.equal(ledgerLib.auditBalance(USER).consistent, true);
  });

  it("**花过分的人重算后不掉级**", () => {
    /*
     * 赚 200 花 180：余额 20、累计 200。累计要用正数流水之和算，
     * 用总和的话会变成 20，人会从 L3 掉到 L1。
     */
    ledgerLib.grantPoints({ userId: USER, delta: 200, reason: "赚" });
    ledgerLib.grantPoints({ userId: USER, delta: -180, reason: "花" });

    const before = dbm.db.select().from(schema.users).where(eq(schema.users.id, USER)).get()!;
    recount.applyPlan(recount.buildPlan());
    const after = dbm.db.select().from(schema.users).where(eq(schema.users.id, USER)).get()!;

    assert.equal(after.points, 20);
    assert.equal(after.pointsTotal, 200, "累计被花掉的分扣掉了");
    assert.equal(after.level, before.level, "重算把人降级了");
  });

  it("重算之后再算一遍是空的 —— 幂等", () => {
    ledgerLib.grantPoints({ userId: USER, delta: 60, reason: "发" });
    dbm.db.update(schema.users).set({ points: 1 }).where(eq(schema.users.id, USER)).run();

    recount.applyPlan(recount.buildPlan());
    assert.deepEqual(recount.buildPlan().rows, []);
  });
});
