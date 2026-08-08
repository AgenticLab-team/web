import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * 「刷新就掉登录」的根因测试。
 *
 * 线上事故的链条是：/me 页用 <Link href="/api/auth/logout"> 渲染退出按钮，
 * 而 Next 在生产环境会对进入视口的 Link **自动预取** —— 预取就是一次带
 * cookie 的 GET。于是用户只要打开「我的」页，浏览器就替他「点」了一次
 * 退出登录：会话被撤销、cookie 被清，下一次刷新自然就掉线了。
 * （生产库里大量 revoke_reason=logout 且 created 与 revoked 只差几分钟的
 * 会话就是证据。）
 *
 * 所以这里锁两条规则，缺一不可：
 *   1. 退出登录不允许有 GET 入口 —— 任何预取、爬虫、<img src> 都是 GET
 *   2. 站内不允许出现指向退出接口的链接 —— 链接会被 Link 预取
 */

const tmp = mkdtempSync(join(tmpdir(), "al-logout-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type SessionModule = typeof import("@/lib/auth/session");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");
type LogoutRoute = typeof import("@/app/api/auth/logout/route");

let session: SessionModule;
let dbm: DbModule;
let schema: SchemaModule;
let route: LogoutRoute;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { seedDatabase } = await import("@/lib/db/seed");
  seedDatabase();
  session = await import("@/lib/auth/session");
  route = await import("@/app/api/auth/logout/route");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

/** 递归列出 src 下所有 .ts/.tsx 源文件 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("退出登录不能被预取触发", () => {
  it("**退出接口不允许导出 GET**", () => {
    assert.equal(
      "GET" in route,
      false,
      "GET 退出接口会被 Link 预取、爬虫、<img src> 触发 —— 用户什么都没点就被登出",
    );
  });

  it("站内源码不允许出现指向 /api/auth/logout 的 href", () => {
    // 只要有一个 <Link href="/api/auth/logout">，生产环境的自动预取
    // 就会在它进入视口时替用户执行退出。退出必须走表单或 fetch 的 POST。
    const offenders = sourceFiles(join(process.cwd(), "src")).filter((path) =>
      /href=["'`]\/api\/auth\/logout/.test(readFileSync(path, "utf8")),
    );
    assert.deepEqual(offenders, [], `这些文件把退出登录渲染成了链接：${offenders.join(", ")}`);
  });
});

describe("会话生命周期", () => {
  const userId = "01TESTUSER0000000000000000";

  before(() => {
    dbm.db
      .insert(schema.users)
      .values({ id: userId, wxId: "wxid_session_test", status: "active" })
      .run();
  });

  it("建会话后能解析回同一个用户", () => {
    const token = session.createSession(userId);
    const user = session.resolveSession(token);
    assert.equal(user?.id, userId);
  });

  it("**撤销后立即失效** —— 这是退出登录的全部意义", () => {
    const token = session.createSession(userId);
    assert.ok(session.resolveSession(token));
    dbm.db
      .update(schema.sessions)
      .set({ revokedAt: Date.now(), revokeReason: "logout" })
      .run();
    assert.equal(session.resolveSession(token), null, "撤销的会话若还能用，退出登录就是摆设");
  });

  it("过期会话不再解析", () => {
    const token = session.createSession(userId);
    dbm.db.update(schema.sessions).set({ expiresAt: Date.now() - 1000 }).run();
    assert.equal(session.resolveSession(token), null);
  });

  it("会话有效期来自配置且必须是正数天", () => {
    // ttl 配错成 0 的话，cookie 的 maxAge=0 等于每次都立刻删除 —— 也是一种「刷新掉登录」
    const token = session.createSession(userId);
    const row = dbm.db.select().from(schema.sessions).all().at(-1);
    assert.ok(row && row.expiresAt > Date.now() + 86_400_000, "会话至少要活一天");
    assert.ok(session.resolveSession(token));
  });
});
