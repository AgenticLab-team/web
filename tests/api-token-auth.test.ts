import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 开放 API 的两道闸：**作用域**和**账号状态**。
 *
 * ═════════════════════════════════════════
 * 这两道闸原来一条测试都没有
 * ═════════════════════════════════════════
 *
 * `tests/api-surface.test.ts` 守着「每条路由都调了 `authenticate(`
 * 并且要了正确的 scope」—— 那是源码断言，守的是**接上没有**。
 *
 * 而 `scripts/mutate.mjs` 把 `authenticate()` **里面**那两句删掉：
 *
 *   · `const missing = required.filter(…)` → 空数组
 *     （一把只读令牌照样能写）
 *   · `if (!user || user.status !== "active")` → 只判存在
 *     （被封的人手里那把还能用）
 *
 * 两刀都活了下来。路由里的调用一个字没动，源码断言全绿。
 *
 * 而第二条正是 `auth.ts` 里那段注释点名担心的事：
 * 「令牌是长期有效的，而账号可能在这期间被封、被注销 ——
 * 只验令牌的话，一个被封的人手里那把还能继续用，
 * 而封禁在他看来完全没有发生。」
 */

const tmp = mkdtempSync(join(tmpdir(), "al-tokenauth-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

describe("开放 API 的鉴权", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const store = await import("@/lib/api-tokens/store");
  const { authenticate } = await import("@/lib/api-tokens/auth");

  after(() => rmSync(tmp, { recursive: true, force: true }));

  const USER = "u_api";

  const req = (token: string) =>
    new Request("https://example.test/api/v1/whatever", {
      headers: { authorization: `Bearer ${token}` },
    });

  beforeEach(() => {
    dbm.db.delete(schema.apiTokens).run();
    dbm.db.delete(schema.users).run();
    dbm.db
      .insert(schema.users)
      .values({ id: USER, wxId: "wx_api", siteNickname: "阿开", status: "active" })
      .run();
  });

  it("★ 只读令牌写不动 —— 缺的 scope 要点名说出来", async () => {
    const { plaintext: token } = store.createToken({ userId: USER, name: "只读", scopes: ["forum:read"] });

    assert.ok(store.verifyToken(token), `verifyToken 认不出刚建的令牌：${token.slice(0, 12)}…`);
    const ok = await authenticate(req(token), ["forum:read"]);
    assert.equal(ok.ok, true, `读都读不了：${ok.ok === false ? await ok.response.text() : ""}`);

    const denied = await authenticate(req(token), ["forum:write"]);
    assert.equal(denied.ok, false, "一把只读令牌写动了");
    assert.equal(denied.ok === false && denied.response.status, 403);

    const body = denied.ok === false ? await denied.response.json() : null;
    assert.match(
      JSON.stringify(body),
      /forum:write/,
      "只说「权限不够」而不说缺哪个 —— 人得挨个试才知道要重建什么样的令牌",
    );
  });

  it("★ 人被封 / 注销之后，他手里那把令牌立刻失效", async () => {
    /*
     * 令牌是长期有效的，而封禁最常见的场景是「他正在捣乱」——
     * 只验令牌的话，封禁在他那边完全没有发生。
     */
    const { plaintext: token } = store.createToken({ userId: USER, name: "长期", scopes: ["forum:read"] });
    assert.equal((await authenticate(req(token), ["forum:read"])).ok, true, "先确认它本来好使");

    for (const status of ["banned", "deleted", "suspended"] as const) {
      dbm.db.update(schema.users).set({ status }).where(eq(schema.users.id, USER)).run();
      const r = await authenticate(req(token), ["forum:read"]);
      assert.equal(r.ok, false, `status=${status} 之后令牌还能用`);
    }
  });

  it("没有令牌、或者令牌是假的 → 401，并带上 challenge", async () => {
    const none = await authenticate(new Request("https://example.test/x"), ["forum:read"]);
    assert.equal(none.ok, false);
    assert.equal(none.ok === false && none.response.status, 401);
    assert.match(
      none.ok === false ? (none.response.headers.get("www-authenticate") ?? "") : "",
      /Bearer/,
      "401 不带 challenge，客户端库认不出来该去换令牌",
    );

    // 假令牌得是 ASCII —— HTTP 头是 ByteString，塞中文会在构造 Request 时就炸
    const fake = await authenticate(req("al_not_a_real_token_0000000000"), ["forum:read"]);
    assert.equal(fake.ok, false);
  });
});
