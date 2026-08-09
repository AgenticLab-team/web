import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  MAX_MISSING_RATIO,
  SMALL_GROUP_SIZE,
  checkRoster,
  revocationsFor,
} from "@/lib/sync/roster-rules";
import { stripComments as strip } from "./_source";

/**
 * 名册同步的安全判定，以及进出群事件的结算。
 *
 * ─────────────────────────────────────────
 * 「从上游名册里消失」是一个很危险的推断
 * ─────────────────────────────────────────
 *
 * 成员同步的逻辑是「本地有而上游没有的人视为退群」。
 * 上游正常时这是对的；上游不正常时它是灾难性的 ——
 * **一次空响应就会把整个群的人全部标成退群**，
 * 而 `visibleGroupsFor` 要求 `left_at IS NULL`，
 * 于是这个群的聊天记录对所有成员同时消失。
 *
 * 症状是「网站坏了」，而没有任何地方会告诉你是名册同步干的。
 * 这个站今天刚经历过隧道反复断开 —— 这不是假想。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

const base = { fetched: 100, limit: 2000, knownActive: 100, missing: 0 };

describe("**空名册一个人都不许标成退群**", () => {
  it("上游返回空、本地有人 —— 不认", () => {
    const v = checkRoster({ ...base, fetched: 0, missing: 100 });
    assert.equal(v.trust, false);
    assert.equal(v.trust === false && v.reason, "empty");
  });

  it("**本地也没人时，空名册是正常的**", () => {
    // 一个刚接入、还没同步过的群，本来就该是空的
    assert.equal(checkRoster({ ...base, fetched: 0, knownActive: 0, missing: 0 }).trust, true);
  });
});

describe("**返回数顶到上限 = 多半被截断了**", () => {
  it("刚好等于 limit 就不认", () => {
    /*
     * 这种情况下「没出现的人」里混着「在下一页的人」，
     * 而我们分不出来 —— 分不出来时就不该动。
     */
    const v = checkRoster({ ...base, fetched: 2000, knownActive: 2500, missing: 500 });
    assert.equal(v.trust === false && v.reason, "truncated");
  });

  it("差一条就正常", () => {
    assert.equal(checkRoster({ ...base, fetched: 1999, knownActive: 2000, missing: 1 }).trust, true);
  });
});

describe("**一次走掉太多人，更可能是名册没取全**", () => {
  it("超过阈值不认", () => {
    const missing = Math.ceil(100 * MAX_MISSING_RATIO) + 1;
    const v = checkRoster({ ...base, knownActive: 100, missing });
    assert.equal(v.trust === false && v.reason, "too_many_missing");
  });

  it("阈值以内照常算 —— 真的有人退群时不能不动", () => {
    assert.equal(checkRoster({ ...base, knownActive: 100, missing: 5 }).trust, true);
  });

  it("**小群不按比例算** —— 5 个人走 2 个是 40%，那完全正常", () => {
    assert.equal(
      checkRoster({ ...base, fetched: 3, knownActive: SMALL_GROUP_SIZE - 1, missing: 3 }).trust,
      true,
    );
  });

  it("没有人消失时当然可信", () => {
    assert.equal(checkRoster({ ...base, missing: 0 }).trust, true);
  });

  it("不可信时要**说出原因**，而且带上数字", () => {
    // 静默跳过等于同步一直在假装成功
    const v = checkRoster({ ...base, fetched: 0, missing: 100 });
    assert.equal(v.trust, false);
    assert.match(v.trust === false ? v.message : "", /100/);
  });
});

describe("接线", () => {
  it("规则层是纯的", () => {
    const rules = src("lib/sync/roster-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(rules.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });

  it("**同步真的用了这个判定**", () => {
    assert.match(strip(src("lib/sync/members.ts")), /checkRoster\(/);
  });

  it("**拦下来的只是「缺席推断」那一段**", () => {
    /*
     * 名册里出现的人照常更新、上游明确标了 left 的照常算 ——
     * 那些是上游说出来的事实，不是我们推断出来的。
     * 一刀切跳过整次同步的话，改名和新加入的人也一起停了。
     */
    const body = strip(src("lib/sync/members.ts"));
    assert.match(body, /verdict\.trust \? existingMap : \[\]/);
  });

  it("不可信时要把原因带回去", () => {
    assert.match(strip(src("lib/sync/members.ts")), /verdict\.trust \? undefined : verdict\.message/);
  });

  it("**进出群结算挂在名册同步之后**", () => {
    // 反过来的话这一轮的退群事件要等下一轮才处理，
    // 而那意味着一个已退群的人还多握着两分钟的群管理权限
    const sync = strip(readFileSync(new URL("../scripts/sync.ts", import.meta.url), "utf8"));
    assert.ok(
      sync.indexOf("群成员名册") < sync.indexOf("进出群结算"),
      "结算排到名册同步前面去了",
    );
  });

  it("**不自动封号**", () => {
    /*
     * 一次名册同步出错就能把一群人挡在门外，而把真的成员关在门外的代价，
     * 比让一个已经退群的人多登录几天大得多。
     */
    const body = strip(src("lib/sync/member-events.ts"));
    assert.equal(/status:\s*"banned"|setUserStatus/.test(body), false, "居然自动封号了");
    assert.match(body, /leftEverything/);
  });

  it("收回身份组要留痕 —— 系统自己做的、不可逆、当事人没有提示", () => {
    assert.match(strip(src("lib/sync/member-events.ts")), /audit\(/);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 真数据库
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-roster-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let mod: typeof import("@/lib/sync/member-events");
let eq: typeof import("drizzle-orm").eq;

const CONV = "conv_1";
const NOW = 1_786_000_000_000;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  mod = await import("@/lib/sync/member-events");
  ({ eq } = await import("drizzle-orm"));
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.groupMemberEvents,
    schema.groupMembers,
    schema.userRoles,
    schema.roles,
    schema.auditLogs,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }
  dbm.db.insert(schema.users).values({ id: "u_a", wxId: "wx_a", status: "active" }).run();
  dbm.db
    .insert(schema.roles)
    .values([
      { id: "r_gm", key: "group_manager", name: "群管理" },
      { id: "r_staff", key: "staff", name: "站务" },
    ])
    .run();
});

const leaveEvent = () =>
  dbm.db
    .insert(schema.groupMemberEvents)
    .values({ convId: CONV, wxId: "wx_a", event: "leave", detectedAt: NOW })
    .run();

describe("结算（真库）", () => {
  it("**退群收回这个群上的身份组**", () => {
    dbm.db
      .insert(schema.userRoles)
      .values({ userId: "u_a", roleId: "r_gm", scopeType: "group", scopeId: CONV })
      .run();
    leaveEvent();

    const r = mod.processMemberEvents(NOW);
    assert.equal(r.revoked, 1);

    const row = dbm.db.select().from(schema.userRoles).get();
    assert.notEqual(row?.revokedAt, null);
  });

  it("**全站身份组不动** —— 退一个群不该丢掉全站权限", () => {
    dbm.db.insert(schema.userRoles).values({ userId: "u_a", roleId: "r_staff" }).run();
    leaveEvent();

    mod.processMemberEvents(NOW);
    const row = dbm.db.select().from(schema.userRoles).get();
    assert.equal(row?.revokedAt, null);
  });

  it("别的群的身份组也不动", () => {
    dbm.db
      .insert(schema.userRoles)
      .values({ userId: "u_a", roleId: "r_gm", scopeType: "group", scopeId: "conv_other" })
      .run();
    leaveEvent();

    mod.processMemberEvents(NOW);
    assert.equal(dbm.db.select().from(schema.userRoles).get()?.revokedAt, null);
  });

  it("加入事件不收任何东西", () => {
    dbm.db
      .insert(schema.userRoles)
      .values({ userId: "u_a", roleId: "r_gm", scopeType: "group", scopeId: CONV })
      .run();
    dbm.db
      .insert(schema.groupMemberEvents)
      .values({ convId: CONV, wxId: "wx_a", event: "join", detectedAt: NOW })
      .run();

    const r = mod.processMemberEvents(NOW);
    assert.equal(r.revoked, 0);
    assert.equal(r.processed, 1);
  });

  it("**处理过的不会再处理第二遍**", () => {
    leaveEvent();
    assert.equal(mod.processMemberEvents(NOW).processed, 1);
    assert.equal(mod.processMemberEvents(NOW).processed, 0);
  });

  it("收回要留痕", () => {
    dbm.db
      .insert(schema.userRoles)
      .values({ userId: "u_a", roleId: "r_gm", scopeType: "group", scopeId: CONV })
      .run();
    leaveEvent();
    mod.processMemberEvents(NOW);

    const log = dbm.db.select().from(schema.auditLogs).get();
    assert.equal(log?.action, "role.revoke");
    assert.match(log?.reason ?? "", /退出/);
  });

  it("没有站内账号的人不会炸", () => {
    dbm.db
      .insert(schema.groupMemberEvents)
      .values({ convId: CONV, wxId: "wx_nobody", event: "leave", detectedAt: NOW })
      .run();
    assert.equal(mod.processMemberEvents(NOW).processed, 1);
  });

  it("**报出「已经不在任何群里」的人，但不动他的账号**", () => {
    dbm.db
      .insert(schema.groupMembers)
      .values({ convId: CONV, wxId: "wx_a", leftAt: NOW })
      .run();
    leaveEvent();

    const r = mod.processMemberEvents(NOW);
    assert.equal(r.leftEverything, 1);

    const user = dbm.db.select().from(schema.users).where(eq(schema.users.id, "u_a")).get();
    assert.equal(user?.status, "active", "居然把人封了");
  });

  it("还在别的群里的人不算「不在任何群」", () => {
    dbm.db
      .insert(schema.groupMembers)
      .values([
        { convId: CONV, wxId: "wx_a", leftAt: NOW },
        { convId: "conv_other", wxId: "wx_a" },
      ])
      .run();
    leaveEvent();
    assert.equal(mod.processMemberEvents(NOW).leftEverything, 0);
  });
});

describe("退群之后不能再拿「发过言」当成员证据", () => {
  it("这条判定要看 left_at", () => {
    /*
     * 原来那段不看 `left_at`，于是一个退光了所有群的人照样能绑定新账号。
     * 而且光是「不返回 true」还不够 —— 下面还有一条
     * 「在已同步群里发过言就算成员」，退过群的人一定发过言，
     * 所以必须**直接返回 false**。
     */
    const body = strip(src("lib/auth/bind.ts"));
    assert.match(body, /rosterRows\.some\(\(r\) => r\.leftAt === null\)/);
    assert.match(body, /if \(rosterRows\.length > 0\) return false;/);
  });
});

describe("revocationsFor", () => {
  it("只收 scope 正好是这个群的", () => {
    assert.deepEqual(revocationsFor("conv_x"), [
      { scopeType: "group", scopeId: "conv_x", reason: "已退出该群" },
    ]);
  });
});
