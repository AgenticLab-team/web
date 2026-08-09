import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  BURST_PER_DAY,
  RISK_LABEL,
  emptyRiskMessage,
  severityOf,
  sortRisks,
  type RiskItem,
} from "@/lib/points/admin-rules";

/**
 * 全站积分流水与风控。
 *
 * ─────────────────────────────────────────
 * 有人工调整，但没有全站视图
 * ─────────────────────────────────────────
 *
 * `listLedger(userId)` 给的是当事人自己的账单。而「这周分是怎么发
 * 出去的」「有没有人在刷」这两个问题，管理员唯一的办法是自己写 SQL。
 * 对账同理：`auditBalance` 只有单人版，「所有人都对得上吗」
 * 要遍历全站才答得出来，于是从来没人答过。
 *
 * ─────────────────────────────────────────
 * 顺手修了 revertPoints 里一个会让钱多出来的 bug
 * ─────────────────────────────────────────
 *
 * 它冲正之后要把「原记录」和「反向记录」互相指上，而找反向记录的
 * 办法是「按 user_id 取 created_at 最新的一条」——
 * created_at 是毫秒，成批结算时同一毫秒给同一个人写两条完全可能。
 * 撞上那一次，关系会挂到别的流水上：**被冲正的那笔没被标记，
 * 于是还能再冲一次**。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

const risk = (kind: RiskItem["kind"], at: number): RiskItem => ({
  kind,
  userId: "u",
  name: "谁",
  detail: "",
  severity: severityOf(kind),
  at,
});

describe("**风控看的是「不该发生」，不是「谁分多」**", () => {
  it("对不上账排最前 —— 它说明记账系统本身出了问题", () => {
    /*
     * 其它几种都还在系统的规则之内，只有这一条说明规则已经不作数了。
     */
    assert.ok(severityOf("mismatch") > severityOf("negative"));
    assert.ok(severityOf("negative") > severityOf("burst"));
    assert.ok(severityOf("burst") > severityOf("manual"));
  });

  it("同等级里新的在前", () => {
    const sorted = sortRisks([risk("burst", 100), risk("burst", 900)]);
    assert.deepEqual(sorted.map((r) => r.at), [900, 100]);
  });

  it("跨等级时等级优先于时间", () => {
    const sorted = sortRisks([risk("manual", 9999), risk("mismatch", 1)]);
    assert.equal(sorted[0].kind, "mismatch");
  });

  it("每一类都有中文名 —— 「burst」对着屏幕的人没有意义", () => {
    for (const k of ["mismatch", "negative", "burst", "manual"] as const) {
      assert.ok(RISK_LABEL[k].length > 0);
    }
  });

  it("**阈值留了一个数量级的余量** —— 报正常行为的队列会被整个忽略", () => {
    /*
     * 生产上每日打卡一次十几分，一天正常上限在几十分。
     * 一旦这个队列开始报正常行为，真出事那天也没人看。
     */
    assert.ok(BURST_PER_DAY >= 200, "定得太低会天天报");
    assert.ok(BURST_PER_DAY <= 2000, "定得太高等于没有");
  });

  it("**空队列说的是好消息**，不是「暂无数据」", () => {
    /*
     * 中性的一句话会让人以为这一页还没做好。
     */
    assert.match(emptyRiskMessage(), /没有异常/);
    assert.doesNotMatch(emptyRiskMessage(), /暂无|没有数据/);
  });
});

describe("**不重复造人工调整**", () => {
  it("admin-actions 里没有第二份 adjustPoints", () => {
    /*
     * lib/admin/user-actions.ts 里已经有一个，而且更完整：
     * 阈值可配、大额要 points.adjust.large 权限、审计带 before/after。
     * 我一开始在这儿又写了一个 —— 那正是这个 session 一路在拆的东西。
     */
    const actions = strip(src("lib/points/admin-actions.ts"));
    assert.doesNotMatch(actions, /export async function adjustPoints/);
    assert.match(actions, /export async function revertLedgerEntry/);
  });

  it("规则层也没有第二份校验", () => {
    const rules = strip(src("lib/points/admin-rules.ts"));
    assert.doesNotMatch(rules, /export function checkAdjust/);
  });

  it("流水页明说人工调整在别处", () => {
    assert.match(src("app/(app)/admin/points/ledger/page.tsx"), /人工发放 \/ 扣除在用户详情页上/);
  });
});

describe("接线", () => {
  it("**points.read 这个权限终于有人用了**", () => {
    /*
     * 它一直列在权限表里，零调用点 —— 而它管的正是「看流水」这件事。
     */
    assert.match(src("app/(app)/admin/points/ledger/page.tsx"), /requireAdmin\("points\.read"\)/);
    assert.match(src("lib/admin/nav.ts"), /permission: "points\.read"/);
  });

  it("冲正要写理由，而且服务端也判", () => {
    const actions = strip(src("lib/points/admin-actions.ts"));
    assert.match(actions, /trimmed\.length < 4/);
    assert.match(actions, /requireWritableAdmin\("points\.adjust"\)/);
    assert.match(actions, /action: "points\.revert"/);
  });

  it("已经冲正过的、以及冲正本身，界面上不给再冲的入口", () => {
    const table = src("components/admin/LedgerTable.tsx");
    assert.match(table, /!wasReverted && !isReversal && !confirming/);
  });

  it("**按人筛时不拿空数组去 in** —— 那会匹配所有行", () => {
    const admin = strip(src("lib/points/admin.ts"));
    assert.match(admin, /if \(ids\.length === 0\) return \[\];/);
  });

  it("名字批量补齐，不逐条查", () => {
    const admin = strip(src("lib/points/admin.ts"));
    assert.match(admin, /function namesOf\(ids: string\[\]\)/);
    assert.match(admin, /inArray\(users\.id, ids\)/);
  });

  it("规则层不碰数据库", () => {
    const code = src("lib/points/admin-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(code.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});

/* ───────────────────────────────────────────────────────────────
 * 冲正那个 bug 只有真数据库测得出来
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-ledger-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let ledger: typeof import("@/lib/points/ledger");
let admin: typeof import("@/lib/points/admin");
let eq: typeof import("drizzle-orm").eq;

const USER = "u_a";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  ledger = await import("@/lib/points/ledger");
  admin = await import("@/lib/points/admin");
  ({ eq } = await import("drizzle-orm"));
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.pointsLedger).run();
  dbm.db.delete(schema.users).run();
  dbm.db
    .insert(schema.users)
    .values({ id: USER, wxId: "wx_a", siteNickname: "甲", status: "active" })
    .run();
});

describe("**冲正：同一毫秒里的两笔不能串**", () => {
  it("冲正标记挂在正确的那两条上", () => {
    /*
     * 原来的实现是「按 user_id 取 created_at 最新的一条」当成刚写的那笔。
     * 成批结算时同一毫秒写两条完全可能 —— 撞上就串了。
     */
    const a = ledger.grantPoints({ userId: USER, delta: 10, reason: "第一笔" });
    const b = ledger.grantPoints({ userId: USER, delta: 20, reason: "第二笔" });
    assert.ok(a.ok && b.ok);

    // 制造「同一毫秒」：把两条的时间戳压平
    const t = Date.now();
    dbm.db.update(schema.pointsLedger).set({ createdAt: t }).run();

    const r = ledger.revertPoints(a.ledgerId!, "op", "退回第一笔");
    assert.equal(r.ok, true);

    const rows = dbm.db.select().from(schema.pointsLedger).all();
    const original = rows.find((x) => x.id === a.ledgerId)!;
    const other = rows.find((x) => x.id === b.ledgerId)!;
    const reversal = rows.find((x) => x.id === r.ledgerId)!;

    assert.equal(reversal.revertsId, a.ledgerId, "反向记录指错了原记录");
    assert.equal(original.revertedBy, r.ledgerId, "原记录没被标成已冲正");
    assert.equal(other.revertedBy, null, "把无辜的那笔标成了已冲正");
  });

  it("**冲正过的不能再冲一次** —— 否则钱会凭空多一份", () => {
    const a = ledger.grantPoints({ userId: USER, delta: 100, reason: "发一笔" });
    const t = Date.now();
    dbm.db.update(schema.pointsLedger).set({ createdAt: t }).run();

    assert.equal(ledger.revertPoints(a.ledgerId!, "op", "第一次冲正").ok, true);
    const second = ledger.revertPoints(a.ledgerId!, "op", "再冲一次");
    assert.equal(second.ok, false);
    assert.match(second.error!, /已经冲正过/);

    // 余额回到 0，不是 -100
    const user = dbm.db.select().from(schema.users).where(eq(schema.users.id, USER)).get();
    assert.equal(user?.points, 0);
  });

  it("冲正之后余额对得上账", () => {
    const a = ledger.grantPoints({ userId: USER, delta: 50, reason: "发一笔" });
    ledger.revertPoints(a.ledgerId!, "op", "退回");
    assert.equal(ledger.auditBalance(USER).consistent, true);
  });
});

describe("全站流水", () => {
  it("按时间倒序列出来，带名字", () => {
    ledger.grantPoints({ userId: USER, delta: 5, reason: "早的" });
    ledger.grantPoints({ userId: USER, delta: 7, reason: "晚的" });

    const rows = admin.listAllLedger();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, "甲");
  });

  it("只看人工调整", () => {
    ledger.grantPoints({ userId: USER, delta: 5, reason: "自动的" });
    ledger.grantPoints({ userId: USER, delta: 5, reason: "人工的", operatorId: "op" });

    const rows = admin.listAllLedger({ manualOnly: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, "人工的");
  });

  it("按人找 —— 找不到就是空，不是全部", () => {
    ledger.grantPoints({ userId: USER, delta: 5, reason: "一笔" });
    assert.equal(admin.listAllLedger({ q: "甲" }).length, 1);
    assert.equal(admin.listAllLedger({ q: "查无此人" }).length, 0, "空数组 in 匹配了所有行");
  });

  it("汇总分得清发出去和花掉", () => {
    ledger.grantPoints({ userId: USER, delta: 100, reason: "发" });
    ledger.grantPoints({ userId: USER, delta: -30, reason: "花" });

    const s = admin.ledgerSummary(30);
    assert.equal(s.granted, 100);
    assert.equal(s.spent, 30);
  });
});

describe("风控队列（真数据）", () => {
  it("正常情况下是空的", () => {
    ledger.grantPoints({ userId: USER, delta: 17, reason: "打卡" });
    assert.deepEqual(admin.riskQueue(), []);
  });

  it("**余额被人直接改过 —— 报出来**", () => {
    ledger.grantPoints({ userId: USER, delta: 10, reason: "正常一笔" });
    // 模拟「顺手改一下库」
    dbm.db.update(schema.users).set({ points: 999 }).where(eq(schema.users.id, USER)).run();

    const risks = admin.riskQueue();
    assert.equal(risks[0].kind, "mismatch");
    assert.match(risks[0].detail, /999/);
  });

  it("一天涨得太快 —— 报出来", () => {
    ledger.grantPoints({ userId: USER, delta: BURST_PER_DAY + 1, reason: "一大笔" });
    assert.ok(admin.riskQueue().some((r) => r.kind === "burst"));
  });

  it("**刚好在线上不报** —— 阈值是「超过」不是「达到」", () => {
    ledger.grantPoints({ userId: USER, delta: BURST_PER_DAY, reason: "刚好" });
    assert.equal(admin.riskQueue().some((r) => r.kind === "burst"), false);
  });

  it("人工调整会进队列，但排在最后", () => {
    ledger.grantPoints({ userId: USER, delta: 10, reason: "人工的", operatorId: "op" });
    const risks = admin.riskQueue();
    assert.equal(risks.some((r) => r.kind === "manual"), true);
  });

  it("**system 写的自动回滚不算人工** —— 那不是人做的", () => {
    ledger.grantPoints({ userId: USER, delta: 10, reason: "自动退回", operatorId: "system" });
    assert.equal(admin.riskQueue().some((r) => r.kind === "manual"), false);
  });
});
