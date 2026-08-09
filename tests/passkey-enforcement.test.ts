import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 管理员强制 Passkey —— 接上真库之后。
 *
 * 规则那层单独测过了。这里测的是**它真的被读了**：
 * 那个开关在库里躺了很久没人读，所以这一组的重点不是判定对不对，
 * 而是「有没有人在读它」。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-passkey-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let login: typeof import("@/lib/auth/password-login");
let password: typeof import("@/lib/auth/password");
let can: typeof import("@/lib/rbac/can");
let enforcement: typeof import("@/lib/auth/passkey-enforcement");
let settingsStore: typeof import("@/lib/settings/store");

const ROLE = "01ROLEPOWER000000000000AA";
const PLAIN_ROLE = "01ROLEPLAIN000000000000AA";
const ADMIN = "01ADMIN000000000000000000";
const MEMBER = "01MEMBER00000000000000000";
const PASSWORD = "correct horse battery";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  login = await import("@/lib/auth/password-login");
  password = await import("@/lib/auth/password");
  can = await import("@/lib/rbac/can");
  enforcement = await import("@/lib/auth/passkey-enforcement");
  settingsStore = await import("@/lib/settings/store");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function setEnforced(on: boolean) {
  dbm.db.delete(schema.settings).where(eq(schema.settings.key, "auth.require_passkey_for_admin")).run();
  dbm.db
    .insert(schema.settings)
    .values({ key: "auth.require_passkey_for_admin", value: on ? "true" : "false", type: "bool" })
    .run();
  // 设置是带缓存的，直接写库不会让读取侧看到
  settingsStore.invalidateSettingsCache();
}

function givePassword(userId: string) {
  dbm.db
    .insert(schema.credentials)
    .values({ userId, type: "password", secret: password.hashPassword(PASSWORD) })
    .run();
}

function givePasskey(userId: string) {
  dbm.db
    .insert(schema.credentials)
    .values({ userId, type: "passkey", secret: "fake-public-key" })
    .run();
}

beforeEach(() => {
  for (const t of [
    schema.loginAttempts,
    schema.credentials,
    schema.userRoles,
    schema.rolePermissions,
    schema.roles,
    schema.users,
    schema.settings,
  ]) {
    dbm.db.delete(t).run();
  }
  can.invalidatePermissionCache();

  dbm.db
    .insert(schema.roles)
    .values([
      { id: ROLE, key: "power", name: "有权限的" },
      { id: PLAIN_ROLE, key: "plain", name: "普通" },
    ])
    .run();
  dbm.db
    .insert(schema.rolePermissions)
    .values([
      // system.settings 是 dangerLevel 3
      { roleId: ROLE, permissionKey: "system.settings", granted: true },
      // forum.view 没有危险等级
      { roleId: PLAIN_ROLE, permissionKey: "forum.view", granted: true },
    ])
    .run();
  can.invalidatePermissionCache();

  dbm.db
    .insert(schema.users)
    .values([
      { id: ADMIN, wxId: "admin_wx", wxNickname: "管理员", status: "active" },
      { id: MEMBER, wxId: "member_wx", wxNickname: "普通成员", status: "active" },
    ])
    .run();
  dbm.db
    .insert(schema.userRoles)
    .values([
      { userId: ADMIN, roleId: ROLE },
      { userId: MEMBER, roleId: PLAIN_ROLE },
    ])
    .run();

  givePassword(ADMIN);
  givePassword(MEMBER);
  setEnforced(true);
});

describe("**这个开关真的被读了**", () => {
  it("开着时，有权限的人用密码登不进来", () => {
    givePasskey(ADMIN);
    const r = login.loginWithPassword({ wxId: "admin_wx", password: PASSWORD });
    assert.equal(r.ok, false, "密码是对的就放进来了 —— 那这个开关还是没人读");
    assert.match(r.error!, /Passkey/);
  });

  it("关掉之后同一个人就能进 —— 证明判定确实来自这个设置", () => {
    givePasskey(ADMIN);
    setEnforced(false);
    const r = login.loginWithPassword({ wxId: "admin_wx", password: PASSWORD });
    assert.equal(r.ok, true);
  });

  it("普通成员不受影响", () => {
    const r = login.loginWithPassword({ wxId: "member_wx", password: PASSWORD });
    assert.equal(r.ok, true);
  });

  it("**权限是现算的** —— 给普通成员授一个危险权限，他马上也要走 Passkey", () => {
    /*
     * 这条锁的是「按权限判而不是按角色名判」。
     * 按名字判的话，这里怎么改权限都不会有变化。
     */
    let r = login.loginWithPassword({ wxId: "member_wx", password: PASSWORD });
    assert.equal(r.ok, true, "先确认他本来进得来");

    dbm.db
      .insert(schema.rolePermissions)
      .values({ roleId: PLAIN_ROLE, permissionKey: "points.adjust", granted: true })
      .run();
    can.invalidatePermissionCache();

    r = login.loginWithPassword({ wxId: "member_wx", password: PASSWORD });
    assert.equal(r.ok, false, "授了危险权限之后还能用密码进 —— 判定没跟着权限走");
  });

  it("没绑 Passkey 的管理员也被拦，而且说法不一样", () => {
    const r = login.loginWithPassword({ wxId: "admin_wx", password: PASSWORD });
    assert.equal(r.ok, false);
    assert.match(r.error!, /密码是对的/);
  });
});

describe("**检查的位置**", () => {
  it("密码错的时候，报的是通用错误，不是「你要用 Passkey」", () => {
    /*
     * 检查必须在密码验完之后。
     *
     * 放前面的话，「这个账号有管理权限」会在密码还没验之前就说出来 ——
     * 等于给了一个「这个微信号是不是管理员」的免密查询接口，
     * 而那正是攻击者最想先知道的一件事。
     */
    givePasskey(ADMIN);
    const r = login.loginWithPassword({ wxId: "admin_wx", password: "wrong" });
    assert.equal(r.ok, false);
    assert.equal(r.error, password.GENERIC_LOGIN_ERROR, "密码还没验就泄露了「他是管理员」");
  });

  it("不存在的账号也报通用错误 —— 不能从措辞上分出「有没有这个人」", () => {
    const r = login.loginWithPassword({ wxId: "nobody_wx", password: PASSWORD });
    assert.equal(r.error, password.GENERIC_LOGIN_ERROR);
  });

  it("**源码里这一段确实在密码校验之后**", () => {
    const src = readFileSync(new URL("../src/lib/auth/password-login.ts", import.meta.url), "utf8");
    const verifyAt = src.indexOf("const matched = verifyPassword");
    const policyAt = src.indexOf("passwordLoginVerdict({");
    assert.ok(verifyAt > 0 && policyAt > 0);
    assert.ok(policyAt > verifyAt, "强制 Passkey 的判定跑在密码校验之前了");
  });

  it("被拦下来也记一次登录尝试 —— 否则这类失败在历史里是隐形的", () => {
    givePasskey(ADMIN);
    login.loginWithPassword({ wxId: "admin_wx", password: PASSWORD });

    const attempt = dbm.db.select().from(schema.loginAttempts).get();
    assert.ok(attempt);
    assert.equal(attempt!.success, false);
    assert.match(attempt!.failureReason!, /passkey_required/);
  });
});

describe("会锁住谁", () => {
  it("数得出没绑 Passkey 的管理员", () => {
    const risk = enforcement.passkeyLockoutRisk();
    assert.equal(risk.strandedCount, 1);
    assert.deepEqual(risk.strandedNames, ["管理员"]);
    assert.equal(risk.active, true);
  });

  it("绑上之后归零", () => {
    givePasskey(ADMIN);
    const risk = enforcement.passkeyLockoutRisk();
    assert.equal(risk.strandedCount, 0);
    assert.equal(risk.active, false);
  });

  it("**没设过密码的不算被挡** —— 生产上跑第一遍时就是这儿报错的", () => {
    /*
     * 那个管理员既没密码也没 Passkey，被报成了 down ——
     * 可这条规则没挡住他任何事。一个不成立的 down 比没有告警更糟。
     */
    dbm.db
      .delete(schema.credentials)
      .where(eq(schema.credentials.userId, ADMIN))
      .run();

    const risk = enforcement.passkeyLockoutRisk();
    assert.equal(risk.strandedCount, 0);
    assert.equal(risk.atRiskCount, 1, "今天没事，但他设密码那天就进不来 —— 要单独数出来");
    assert.equal(risk.active, false);
  });

  it("**封禁的人不算进去** —— 他本来就登不进来，算进来只会让数字失真", () => {
    dbm.db.update(schema.users).set({ status: "banned" }).where(eq(schema.users.id, ADMIN)).run();
    assert.equal(enforcement.passkeyLockoutRisk().strandedCount, 0);
  });

  it("**开关关着时也照样数** —— 「开了会怎样」要在开之前就知道", () => {
    setEnforced(false);
    const risk = enforcement.passkeyLockoutRisk();
    assert.equal(risk.strandedCount, 1);
    assert.equal(risk.enforced, false);
    assert.equal(risk.active, false);
  });

  it("扫的是所有有身份组的人，不是只扫某几个角色", () => {
    dbm.db
      .insert(schema.rolePermissions)
      .values({ roleId: PLAIN_ROLE, permissionKey: "module.toggle", granted: true })
      .run();
    can.invalidatePermissionCache();

    const risk = enforcement.passkeyLockoutRisk();
    assert.equal(risk.strandedCount, 2, "普通角色被授了危险权限，也该算进来");
  });
});

describe("接进了健康检查", () => {
  it("有人被挡时是 down —— 这不是「有个指标不好看」，是有人现在进不来", async () => {
    const health = await import("@/lib/health");
    const report = health.probeAuthPolicy();
    assert.equal(report.component, "auth");
    assert.equal(report.status, "down");
    assert.match(report.detail!, /管理员/);
  });

  it("都绑了 Passkey 就是 ok", async () => {
    givePasskey(ADMIN);
    const health = await import("@/lib/health");
    assert.equal(health.probeAuthPolicy().status, "ok");
  });

  it("**开关关着是 degraded** —— 管理员只有一道密码，是个真实的缺口", async () => {
    givePasskey(ADMIN);
    setEnforced(false);
    const health = await import("@/lib/health");
    assert.equal(health.probeAuthPolicy().status, "degraded");
  });

  it("它在每轮探测里 —— 不然写了也没人跑", async () => {
    const src = readFileSync(new URL("../src/lib/health.ts", import.meta.url), "utf8");
    const run = src.slice(src.indexOf("export async function runHealthChecks"));
    assert.match(run.slice(0, 400), /probeAuthPolicy\(\)/);
  });

  it("**告警不等** —— 有人进不来的时候，等 10 分钟没有任何意义", async () => {
    const rules = await import("@/lib/alerts/rules");
    assert.equal(rules.DEFAULT_RULES.auth.fireAfterMs, 0);
  });
});

describe("设置页把后果摆出来了", () => {
  it("auth 那一栏下面显示会锁住谁", () => {
    const src = readFileSync(
      new URL("../src/app/(app)/admin/settings/page.tsx", import.meta.url),
      "utf8",
    );
    assert.match(src, /passkeyLockoutRisk\(\)/);
    assert.match(src, /describeRisk\(/);
  });
});
