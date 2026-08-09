import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  MAKEUP_WINDOW_DAYS,
  checkMakeup,
  makeupCandidates,
  shiftDate,
  streakFrom,
} from "@/lib/points/makeup-rules";
import { stripComments as strip } from "./_source";

/**
 * 补签卡。
 *
 * ─────────────────────────────────────────
 * 它一直是买得到、用不掉的
 * ─────────────────────────────────────────
 *
 * 商店里能买、卡发得下来、商店页还提示「你还有 N 张没用」——
 * 而全站没有任何地方能消耗它。`checkins.is_makeup` / `makeup_cost`
 * 两列零引用，`used_for_date` / `used_at` 从来没被写过，
 * 每月上限那个设置项零读取点。
 *
 * 死开关里最糟的一种：**用户花积分买过之后才会发现**。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

const TODAY = "2026-08-10";
const d = (n: number) => shiftDate(TODAY, n);

const base = {
  today: TODAY,
  checkedDates: [] as string[],
  since: null as string | null,
  cards: 1,
  usedThisMonth: 0,
  monthlyLimit: 1,
};

describe("**不能编一段历史出来**", () => {
  /*
   * 少了任何一条，一个买了三十张卡的人就能凭空得到一条三十天的连胜，
   * 而榜单和等级都认它。
   */
  it("超出窗口的补不了", () => {
    const r = checkMakeup({ ...base, date: d(-(MAKEUP_WINDOW_DAYS + 1)) });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "too_old");
  });

  it("窗口边界那天可以补 —— 「最近七天」要真的含第七天", () => {
    assert.equal(checkMakeup({ ...base, date: d(-MAKEUP_WINDOW_DAYS) }).ok, true);
  });

  it("**账号存在之前的日子补不了**", () => {
    const r = checkMakeup({ ...base, date: d(-3), since: d(-2) });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.message : "", /还没来/);
  });

  it("已经打过卡的那天补不了", () => {
    const r = checkMakeup({ ...base, date: d(-1), checkedDates: [d(-1)] });
    assert.equal(r.ok === false && r.reason, "not_missed");
  });

  it("**今天不用补** —— 而且要说清楚下一步", () => {
    const r = checkMakeup({ ...base, date: TODAY });
    assert.equal(r.ok, false);
    // 「不能补今天」会让人以为坏了；「直接打卡就行」才是他要的
    assert.match(r.ok === false ? r.message : "", /直接打卡/);
  });

  it("将来的日子补不了", () => {
    assert.equal(checkMakeup({ ...base, date: d(1) }).ok, false);
  });

  it("没卡就补不了", () => {
    assert.equal(checkMakeup({ ...base, date: d(-1), cards: 0 }).ok, false);
  });
});

describe("每月上限", () => {
  it("到了上限就不让补，而且说出上限是多少", () => {
    const r = checkMakeup({ ...base, date: d(-1), usedThisMonth: 1, monthlyLimit: 1 });
    assert.equal(r.ok === false && r.reason, "monthly_limit");
    assert.match(r.ok === false ? r.message : "", /上限 1/);
  });

  it("**上限设成 0 表示不限** —— 否则后台把它清零会变成「一次都不许补」", () => {
    assert.equal(checkMakeup({ ...base, date: d(-1), usedThisMonth: 9, monthlyLimit: 0 }).ok, true);
  });
});

describe("**连胜是算出来的，不是攒出来的**", () => {
  /*
   * `users.streak_current` 只是缓存列，真值是 checkins 那些行。
   * 给缓存打补丁的话，「补了两天中间那一天」必然算错，
   * 而算错的表现只是一个数字不对，没有任何人查得出来。
   */
  it("连着的日子数得对", () => {
    assert.equal(streakFrom([d(0), d(-1), d(-2)], TODAY), 3);
  });

  it("断开就停", () => {
    assert.equal(streakFrom([d(0), d(-1), d(-3)], TODAY), 2);
  });

  it("**今天还没打卡时，从昨天数起**", () => {
    // 否则一个昨天还在连胜的人，会在今天打卡之前显示成 0
    assert.equal(streakFrom([d(-1), d(-2)], TODAY), 2);
  });

  it("什么都没有就是 0", () => {
    assert.equal(streakFrom([], TODAY), 0);
  });

  it("**补上中间那一天，两截接起来**", () => {
    // 这正是给缓存打补丁会算错的那种情况
    const before = [d(0), d(-1), d(-3), d(-4)];
    assert.equal(streakFrom(before, TODAY), 2);
    assert.equal(streakFrom([...before, d(-2)], TODAY), 5);
  });
});

describe("**每一天都要标出补完连胜是多少**", () => {
  /*
   * 只列日期的话，人得自己在脑子里推一遍哪天补了能接上 ——
   * 而那正是他最容易算错、事后最容易觉得被坑了的地方。
   * 一张卡两百分，补错一天等于白花。
   */
  it("只列漏掉的", () => {
    const list = makeupCandidates({ today: TODAY, checkedDates: [d(-1), d(-2)], since: null });
    assert.equal(list.some((c) => c.date === d(-1)), false);
    assert.equal(list.some((c) => c.date === d(-3)), true);
  });

  it("不列今天", () => {
    const list = makeupCandidates({ today: TODAY, checkedDates: [], since: null });
    assert.equal(list.some((c) => c.date === TODAY), false);
  });

  it("每一天都带着补完之后的连胜", () => {
    const list = makeupCandidates({
      today: TODAY,
      checkedDates: [d(0), d(-1), d(-3), d(-4)],
      since: null,
    });
    const bridge = list.find((c) => c.date === d(-2));
    assert.equal(bridge?.streakAfter, 5, "补中间那天该把两截接起来");
  });

  it("**接不上的那些也要列出来** —— 藏起来的话人会以为那天不能补", () => {
    const list = makeupCandidates({ today: TODAY, checkedDates: [d(0)], since: null });
    // d(-5) 补上也接不到今天，但它仍然是一个「漏掉的日子」
    assert.equal(list.some((c) => c.date === d(-5)), true);
  });

  it("新的在前", () => {
    const list = makeupCandidates({ today: TODAY, checkedDates: [], since: null });
    assert.equal(list[0].date, d(-1));
  });

  it("账号存在之前的不列", () => {
    const list = makeupCandidates({ today: TODAY, checkedDates: [], since: d(-2) });
    assert.deepEqual(list.map((c) => c.date), [d(-1), d(-2)]);
  });
});

describe("接线", () => {
  it("规则层是纯的", () => {
    const rules = src("lib/points/makeup-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(rules.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });

  it("**那两个一直没人读的设置项终于有人读了**", () => {
    const body = strip(src("lib/points/makeup.ts"));
    assert.match(body, /points\.makeup_card\.monthly_limit/);
    assert.match(body, /points\.makeup_card\.cost/);
  });

  it("**`used_for_date` / `used_at` 真的被写了**", () => {
    // 这两列以前零写入 —— 也就是卡永远「没用掉」
    assert.match(strip(src("lib/points/makeup.ts")), /usedForDate: date/);
  });

  it("**补签不发分**", () => {
    /*
     * 卡是用积分买的，补签再把分发回来就成了洗分的路子。
     * 人买它想要的是连胜，不是那几分。
     */
    const body = strip(src("lib/points/makeup.ts"));
    assert.match(body, /pointsAwarded: 0/);
    assert.equal(body.includes("grantPoints("), false, "补签居然发分了");
  });

  it("界面上要说明它不发分", () => {
    // 不说的话，花两百分买卡的人会以为能拿回当天那几分
    assert.match(src("components/points/MakeupPanel.tsx"), /不补发|不发.*积分/);
  });

  it("三件事在一个事务里", () => {
    // 分开做会留下「卡用掉了但没补上」或者「补上了但卡还在」
    assert.match(strip(src("lib/points/makeup.ts")), /db\.transaction/);
  });

  it("**占卡用带条件的 UPDATE，不是先查再改**", () => {
    // 两个标签页同时点，「先查再改」会各补一天而只扣一张卡
    const body = strip(src("lib/points/makeup.ts"));
    assert.match(body, /claimed\.changes === 0/);
  });

  it("用的是真身 —— 预览态下会花掉别人的卡", () => {
    assert.match(strip(src("lib/points/makeup-actions.ts")), /getRealUser\(\)/);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 真数据库
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-makeup-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let mod: typeof import("@/lib/points/makeup");
let eq: typeof import("drizzle-orm").eq;

const USER = "u_a";
const user = () =>
  ({ id: USER, wxId: "wx_a", status: "active", kind: "member", createdAt: 1 }) as unknown as Parameters<
    typeof mod.makeupState
  >[0];

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  mod = await import("@/lib/points/makeup");
  ({ eq } = await import("drizzle-orm"));
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const checkin = (date: string) =>
  dbm.db
    .insert(schema.checkins)
    .values({ userId: USER, date, pointsAwarded: 5, basePoints: 5, streakAfter: 1 })
    .run();

const giveCard = (n = 1) => {
  for (let i = 0; i < n; i++) {
    dbm.db.insert(schema.makeupCards).values({ userId: USER, createdAt: 1 }).run();
  }
};

beforeEach(() => {
  for (const t of [schema.makeupCards, schema.checkins, schema.users]) dbm.db.delete(t).run();
  dbm.db
    .insert(schema.users)
    .values({ id: USER, wxId: "wx_a", status: "active", createdAt: 1 })
    .run();
});

describe("真库", () => {
  it("**补上之后连胜真的接回来了**", () => {
    // 前天、大前天打过，昨天断了
    checkin(d(-2));
    checkin(d(-3));
    giveCard();

    const r = mod.redeemMakeupCard(user(), d(-1), TODAY);
    assert.equal(r.ok, true);
    assert.equal(r.ok === true && r.streak, 3);

    const row = dbm.db.select().from(schema.users).where(eq(schema.users.id, USER)).get();
    assert.equal(row?.streakCurrent, 3);
  });

  it("卡被标掉，而且记着补的是哪天", () => {
    checkin(d(-2));
    giveCard();
    mod.redeemMakeupCard(user(), d(-1), TODAY);

    const card = dbm.db.select().from(schema.makeupCards).get();
    assert.notEqual(card?.usedAt, null);
    assert.equal(card?.usedForDate, d(-1));
  });

  it("**补出来的那行不发分，但记着卡价**", () => {
    giveCard();
    mod.redeemMakeupCard(user(), d(-1), TODAY);
    const row = dbm.db
      .select()
      .from(schema.checkins)
      .where(eq(schema.checkins.date, d(-1)))
      .get();
    assert.equal(row?.pointsAwarded, 0);
    assert.equal(row?.isMakeup, true);
    assert.ok((row?.makeupCost ?? 0) > 0, "没记下当时的卡价，事后对不了账");
  });

  it("没卡时不动任何东西", () => {
    const r = mod.redeemMakeupCard(user(), d(-1), TODAY);
    assert.equal(r.ok, false);
    assert.equal(dbm.db.select().from(schema.checkins).all().length, 0);
  });

  it("同一天补两次不会补出两行，也不会白扣一张卡", () => {
    /*
     * 注意这条走的是**判定**那一层（第二次在 checkMakeup 就被拦下了），
     * 不是事务里那道并发防线 —— 那道防线要两个请求同时进来才触发，
     * 这里造不出来。它由「占卡用带条件的 UPDATE」那条结构性断言盯着。
     */
    giveCard(2);
    assert.equal(mod.redeemMakeupCard(user(), d(-1), TODAY).ok, true);
    const second = mod.redeemMakeupCard(user(), d(-1), TODAY);
    assert.equal(second.ok, false);

    assert.equal(dbm.db.select().from(schema.checkins).all().length, 1);
    const unused = dbm.db
      .select()
      .from(schema.makeupCards)
      .all()
      .filter((c) => c.usedAt === null).length;
    assert.equal(unused, 1, "第二次失败却把卡扣掉了");
  });

  it("**历史最好连胜也跟着更新**", () => {
    checkin(d(-2));
    checkin(d(-3));
    giveCard();
    mod.redeemMakeupCard(user(), d(-1), TODAY);
    const row = dbm.db.select().from(schema.users).where(eq(schema.users.id, USER)).get();
    assert.equal(row?.streakBest, 3);
  });

  it("状态里能看到还剩几张、这个月补过几次", () => {
    giveCard(3);
    checkin(d(-2));
    const s = mod.makeupState(user(), TODAY);
    assert.equal(s.cards, 3);
    assert.equal(s.usedThisMonth, 0);
    assert.ok(s.candidates.length > 0);

    mod.redeemMakeupCard(user(), d(-1), TODAY);
    const after = mod.makeupState(user(), TODAY);
    assert.equal(after.cards, 2);
    assert.equal(after.usedThisMonth, 1);
  });
});
