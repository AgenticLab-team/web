import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { eq } from "drizzle-orm";
import { stripComments as strip } from "./_source";

/**
 * 「这个账号就是不设密码」。
 *
 * 没有这个状态之前，「还没设」和「决定不设」在数据上长得一模一样，
 * 安全页只能对着后者反复劝设密码 —— 被反复劝的人最后会把
 * 真正重要的提醒一起无视掉。
 *
 * action 层要过 cookie 会话，测不到；所以这里分两层测：
 * 列本身（migration 0030 之后真的存在、真的三态可分），
 * 和接线（action 里的关键约束真的写在代码里）。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-pwoptout-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
});

after(() => rmSync(tmp, { recursive: true, force: true }));

describe("列本身", () => {
  it("**「还没设」和「决定不设」终于是两个状态**", () => {
    dbm.db
      .insert(schema.users)
      .values([
        { id: "01USERNONE00000000000000A", wxId: "wx_none", status: "active" },
        {
          id: "01USEROPTOUT000000000000A",
          wxId: "wx_optout",
          status: "active",
          passwordOptOutAt: 1_700_000_000_000,
        },
      ])
      .run();

    const rows = dbm.db.select().from(schema.users).all();
    const none = rows.find((r) => r.wxId === "wx_none")!;
    const opted = rows.find((r) => r.wxId === "wx_optout")!;

    assert.equal(none.passwordOptOutAt, null, "默认必须是「没表过态」");
    assert.equal(opted.passwordOptOutAt, 1_700_000_000_000, "存的是时间戳，翻旧账时它是证据");
  });

  it("表态可以收回 —— 设回 null 就是没表过态", () => {
    dbm.db
      .update(schema.users)
      .set({ passwordOptOutAt: null })
      .where(eq(schema.users.wxId, "wx_optout"))
      .run();
    const row = dbm.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.wxId, "wx_optout"))
      .get()!;
    assert.equal(row.passwordOptOutAt, null);
  });
});

describe("接线", () => {
  const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
    const actions = () => strip(src("lib/auth/password-actions.ts"));

  it("**设了密码就自动清掉表态** —— 两个状态并存谁看谁糊涂", () => {
    const fn = actions().slice(
      actions().indexOf("function setPassword"),
      actions().indexOf("function removePassword"),
    );
    assert.match(fn, /passwordOptOutAt:\s*null/);
  });

  it("**有密码时不许表态「不设密码」** —— 那句话和现实矛盾", () => {
    const fn = actions().slice(actions().indexOf("function setPasswordlessIntent"));
    const rejectAt = fn.indexOf("passwordCredentialOf");
    const writeAt = fn.indexOf(".update(users)");
    assert.ok(rejectAt > 0, "没查现有密码");
    assert.ok(rejectAt < writeAt, "先写库后检查等于没检查");
  });

  it("**三个密码 action 都拦预览态** —— 预览态下 getCurrentUser 是别人", () => {
    for (const fn of ["setPassword", "removePassword", "setPasswordlessIntent"]) {
      const body = actions().slice(actions().indexOf(`function ${fn}`));
      const guardAt = body.indexOf("assertNotPreviewing()");
      const userAt = body.indexOf("getCurrentUser()");
      assert.ok(guardAt > 0, `${fn} 没拦预览态`);
      assert.ok(guardAt < userAt, `${fn} 先取了用户再拦 —— 顺序反了`);
    }
  });

  it("安全页把表态传给了密码组件，并用 selfLoginStatus 汇总登录处境", () => {
    const page = src("app/(app)/me/security/page.tsx");
    assert.match(page, /passwordOptOutAt/);
    assert.match(page, /optedOut=\{optedOut\}/);
    assert.match(page, /selfLoginStatus\(/);
  });

  it("**表过态之后不再劝** —— 组件里「不设密码」状态有自己的文案", () => {
    const component = src("components/auth/PasswordSetup.tsx");
    assert.match(component, /这个账号不设密码/);
    assert.match(component, /我不打算设密码/);
    assert.match(component, /取消「不设密码」/);
  });
});
