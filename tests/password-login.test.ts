import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 密码登录的服务端。
 *
 * ─────────────────────────────────────────
 * 三条不能破的
 * ─────────────────────────────────────────
 *
 * **① 它不能创建账号，也不能激活账号。** 这个站的入口只有微信群里
 * 那条验证码 —— 密码要是能独立进门，「只有群成员能登录」当场就没了。
 *
 * **② 不能从回答里推出「这个微信号在不在社群里」。** 措辞一致、
 * 耗时一致 —— 否则就送了一个查询群成员名单的接口。
 *
 * **③ 锁定要有时限。** 永久锁定意味着任何人反复输错就能把别人锁死。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-pwd-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type DbModule = typeof import("@/lib/db");

let dbm: DbModule;
let schema: typeof import("@/lib/db/schema");
let login: typeof import("@/lib/auth/password-login");
let pwd: typeof import("@/lib/auth/password");

const NOW = 1_800_000_000_000;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  login = await import("@/lib/auth/password-login");
  pwd = await import("@/lib/auth/password");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [schema.loginAttempts, schema.credentials, schema.users]) {
    dbm.db.delete(t).run();
  }
});

const SECRET = "correct-horse-battery-staple";

function user(id: string, over: Record<string, unknown> = {}) {
  dbm.db
    .insert(schema.users)
    .values({ id, wxId: `wx_${id}`, wxNickname: id, status: "active", ...over })
    .run();
}

function withPassword(id: string, secret = SECRET) {
  dbm.db
    .insert(schema.credentials)
    .values({ userId: id, type: "password", secret: pwd.hashPassword(secret) })
    .run();
}

function attempt(wxId: string, password: string, now = NOW) {
  return login.loginWithPassword({ wxId, password, ip: "1.2.3.4", now });
}

function failures(userId: string) {
  return dbm.db
    .select()
    .from(schema.loginAttempts)
    .where(eq(schema.loginAttempts.userId, userId))
    .all();
}

describe("① 不能创建账号，也不能激活账号", () => {
  it("没有这个人时登录失败", () => {
    assert.equal(attempt("wx_nobody", SECRET).ok, false);
    assert.equal(dbm.db.select().from(schema.users).all().length, 0, "居然创建了账号");
  });

  it("**pending 的账号验对了密码也进不去**", () => {
    user("alice", { status: "pending" });
    withPassword("alice");

    const result = attempt("wx_alice", SECRET);
    assert.equal(result.ok, false);
    assert.equal(
      dbm.db.select().from(schema.users).where(eq(schema.users.id, "alice")).get()!.status,
      "pending",
      "密码登录把账号激活了",
    );
  });

  it("被封的账号进不去，但会说清楚去哪申诉", () => {
    user("bob", { status: "banned" });
    withPassword("bob");

    const result = attempt("wx_bob", SECRET);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /申诉/);
  });

  it("没设过密码的人验不过", () => {
    user("carol");
    const result = attempt("wx_carol", SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.error, pwd.GENERIC_LOGIN_ERROR);
  });

  it("撤销过的密码凭证不算数", () => {
    user("dave");
    withPassword("dave");
    dbm.db.update(schema.credentials).set({ revokedAt: NOW }).run();

    assert.equal(attempt("wx_dave", SECRET).ok, false);
  });

  it("正常账号能进", () => {
    user("erin");
    withPassword("erin");
    const result = attempt("wx_erin", SECRET);
    assert.equal(result.ok, true);
    assert.equal(result.userId, "erin");
  });
});

describe("② 不能从回答里推出「这个人在不在社群里」", () => {
  it("**三种失败给一模一样的措辞**", () => {
    user("has", {});
    withPassword("has");
    user("none");

    const noUser = attempt("wx_ghost", SECRET);
    const noPassword = attempt("wx_none", SECRET);
    const badPassword = attempt("wx_has", "wrong-password-here");

    assert.equal(noUser.error, pwd.GENERIC_LOGIN_ERROR);
    assert.equal(noPassword.error, pwd.GENERIC_LOGIN_ERROR);
    assert.equal(badPassword.error, pwd.GENERIC_LOGIN_ERROR);
  });

  it("**账号不存在时也要花掉一次哈希的时间**", () => {
    /*
     * 直接返回会让响应时间把「这个微信号在不在社群里」漏出去。
     * 这里不去量绝对耗时（机器噪声太大），量的是两者同一个数量级。
     */
    user("real");
    withPassword("real");

    const t0 = process.hrtime.bigint();
    attempt("wx_real", "wrong-password-here");
    const realMs = Number(process.hrtime.bigint() - t0) / 1e6;

    const t1 = process.hrtime.bigint();
    attempt("wx_ghost_account", "wrong-password-here");
    const ghostMs = Number(process.hrtime.bigint() - t1) / 1e6;

    assert.ok(realMs > 5, `真账号只花了 ${realMs.toFixed(1)}ms —— 哈希参数是不是太低了`);
    assert.ok(
      ghostMs > realMs / 4,
      `不存在的账号只花了 ${ghostMs.toFixed(1)}ms，而真账号 ${realMs.toFixed(1)}ms —— 时间差能推出这个人在不在`,
    );
  });

  it("**账号状态检查在密码校验之后** —— 否则密码不对也能问出「这人被封了」", () => {
    user("banned", { status: "banned" });
    withPassword("banned");

    const wrongPassword = attempt("wx_banned", "totally-wrong-here");
    assert.equal(wrongPassword.error, pwd.GENERIC_LOGIN_ERROR, "密码都不对就告诉人家账号被封了");
  });
});

describe("③ 锁定", () => {
  beforeEach(() => {
    user("target");
    withPassword("target");
  });

  it("连续失败到线之后锁住", () => {
    for (let i = 0; i < pwd.LOCKOUT_THRESHOLD; i++) {
      attempt("wx_target", "wrong-password-here", NOW + i * 1000);
    }

    const locked = attempt("wx_target", SECRET, NOW + 10_000);
    assert.equal(locked.ok, false, "锁定期内正确的密码也不该放行");
    assert.ok(locked.retryAfterSeconds! > 0);
    assert.match(locked.error ?? "", /分钟后再试/);
  });

  it("**锁定会过期** —— 永久锁定等于谁都能把别人锁死", () => {
    for (let i = 0; i < pwd.LOCKOUT_THRESHOLD; i++) {
      attempt("wx_target", "wrong-password-here", NOW + i * 1000);
    }
    const after = attempt("wx_target", SECRET, NOW + pwd.LOCKOUT_MS + 60_000);
    assert.equal(after.ok, true, "锁定没有解除");
  });

  it("**成功一次就把连续失败清零**", () => {
    for (let i = 0; i < pwd.LOCKOUT_THRESHOLD - 1; i++) {
      attempt("wx_target", "wrong-password-here", NOW + i * 1000);
    }
    attempt("wx_target", SECRET, NOW + 10_000);

    const state = login.recentFailures("target", NOW + 20_000);
    assert.equal(state.failures, 0, "昨天输错几次会一直挂着");
  });

  it("锁定的是这个账号，不是所有人", () => {
    user("other");
    withPassword("other");
    for (let i = 0; i < pwd.LOCKOUT_THRESHOLD; i++) {
      attempt("wx_target", "wrong-password-here", NOW + i * 1000);
    }
    assert.equal(attempt("wx_other", SECRET, NOW + 10_000).ok, true);
  });

  it("每一次尝试都留痕 —— 成功和失败都记", () => {
    attempt("wx_target", "wrong-password-here");
    attempt("wx_target", SECRET);

    const rows = failures("target");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.success).sort(), [false, true]);
    assert.ok(rows.every((r) => r.method === "password"));
  });

  it("失败原因记下来了，但不外露给调用方", () => {
    user("zed");
    attempt("wx_zed", "wrong-password-here");
    const row = failures("zed")[0];
    assert.equal(row.failureReason, "no_password");
  });
});

describe("哈希参数升级", () => {
  it("**登录成功时顺手把老哈希换成当前强度**", () => {
    user("olduser");
    const salt = randomBytes(16);
    const hash = scryptSync(SECRET, salt, 64, { N: 16384, r: 8, p: 1 });
    const legacy = ["scrypt", 16384, 8, 1, salt.toString("base64url"), hash.toString("base64url")].join("$");

    dbm.db
      .insert(schema.credentials)
      .values({ userId: "olduser", type: "password", secret: legacy })
      .run();

    assert.equal(attempt("wx_olduser", SECRET).ok, true, "老哈希登不进去 = 把人锁在门外");

    const after = dbm.db.select().from(schema.credentials).all()[0];
    assert.notEqual(after.secret, legacy, "参数没升级");
    assert.equal(pwd.needsRehash(after.secret), false);
    assert.equal(pwd.verifyPassword(SECRET, after.secret), true, "升级之后密码验不过了");
  });

  it("登录成功会记下最近使用时间", () => {
    user("frank");
    withPassword("frank");
    attempt("wx_frank", SECRET);
    assert.ok(dbm.db.select().from(schema.credentials).all()[0].lastUsedAt);
  });
});

describe("输入的边界", () => {
  it("空微信 ID / 空密码都失败，不炸", () => {
    assert.equal(attempt("", SECRET).ok, false);
    assert.equal(attempt("wx_x", "").ok, false);
    assert.equal(attempt("", "").ok, false);
  });

  it("前后空格不影响 —— 手机输入法常带一个", () => {
    user("gina");
    withPassword("gina");
    assert.equal(attempt("  wx_gina  ", SECRET).ok, true);
  });
});
