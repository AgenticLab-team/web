import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 网关问路。
 *
 * 这一层错了的表现是**静默收不到信**：网关在 RCPT 阶段拒掉，
 * 拒信退回给发件人，我们这边一个字都看不到。
 * 所以每一条判定都值得单独钉一个断言。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-mailroute-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let burner: typeof import("@/lib/mail/burner");
let routing: typeof import("@/lib/mail/routing");
let seed: typeof import("@/lib/mail/seed-domains");

const USER = "01USER_ROUTE";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  burner = await import("@/lib/mail/burner");
  routing = await import("@/lib/mail/routing");
  seed = await import("@/lib/mail/seed-domains");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.mailMessages,
    schema.mailEvents,
    schema.mailBoxes,
    schema.mailDomains,
    schema.mailBanwords,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }
  dbm.db
    .insert(schema.users)
    .values({ id: USER, kind: "member", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
    .run();
  seed.seedMailDomains();
});

describe("域名快照", () => {
  it("收信的域名都在", () => {
    const snap = routing.mailRoutingSnapshot();
    const names = new Set(snap.domains.map((d) => d.punycode));

    assert.ok(names.has("rickroll.icu"), "一次性池的该在");
    assert.ok(names.has("tsuki.icu"), "靓号池的该在");
  });

  it("★ 管理员专用的也在名单里 —— 排掉的话网关会在 RCPT 就回 550", () => {
    /*
     * 站长 8-14：这 11 个配 MX、收信，只是没人能在上面开地址。
     * 从快照里排掉的话：管理员开的地址收不到信，
     * 而且**我们也看不到有人在试探** —— 而那正是配 MX 换来的东西。
     */
    const names = new Set(routing.mailRoutingSnapshot().domains.map((d) => d.punycode));
    assert.ok(names.has("githubusercontent.icu"));
  });

  it("★ 但它上面没有地址时照样收不到 —— catch-all 是关的", () => {
    assert.equal(routing.deliverableAddress("security@githubusercontent.icu"), false);
  });

  it("真封禁的域名不在名单里（现在一个都没有，用改类别来验）", () => {
    dbm.db
      .update(schema.mailDomains)
      .set({ kind: "blocked" })
      .where(eq(schema.mailDomains.domain, "rickroll.icu"))
      .run();

    const names = new Set(routing.mailRoutingSnapshot().domains.map((d) => d.punycode));
    assert.equal(names.has("rickroll.icu"), false, "封禁的连 MX 都不该配");
  });

  it("中文域名在快照里是 A 标签 —— 信封上就是这个形态", () => {
    const snap = routing.mailRoutingSnapshot();
    const names = new Set(snap.domains.map((d) => d.punycode));
    assert.ok(names.has("xn--xkrw23g.icu"));
    assert.equal(names.has("华立.icu"), false);
  });

  it("★ 没有主人的域名，catch-all 报成关 —— 开着也没用，信落不到任何箱子里", () => {
    const snap = routing.mailRoutingSnapshot();
    const owned = snap.domains.find((d) => d.punycode === "muran.icu");
    assert.equal(owned?.catchAll, false, "站长账号还没建，这时候不该报成能收");

    dbm.db
      .update(schema.mailDomains)
      .set({ ownerUserId: USER })
      .where(eq(schema.mailDomains.domain, "muran.icu"))
      .run();

    const after = routing.mailRoutingSnapshot().domains.find((d) => d.punycode === "muran.icu");
    assert.equal(after?.catchAll, true, "认到人之后就该能收了");
  });

  it("停用的域名不在名单里", () => {
    dbm.db
      .update(schema.mailDomains)
      .set({ enabled: false })
      .where(eq(schema.mailDomains.domain, "rickroll.icu"))
      .run();

    const names = new Set(routing.mailRoutingSnapshot().domains.map((d) => d.punycode));
    assert.equal(names.has("rickroll.icu"), false);
  });
});

describe("单地址查询", () => {
  it("刚开出来的一次性箱**立刻**收得到信", () => {
    // 这条是这个接口存在的全部理由：用户开完箱就去点「发送验证码」，
    // 等不了下一次快照刷新
    const box = burner.openBurner({ userId: USER });
    assert.equal(box.ok, true);
    if (!box.ok) return;
    assert.equal(routing.deliverableAddress(box.box.address), true);
  });

  it("不存在的地址收不到", () => {
    assert.equal(routing.deliverableAddress("nobody@rickroll.icu"), false);
  });

  it("管理员专用域名上、没开过的地址收不到", () => {
    assert.equal(routing.deliverableAddress("anyone@githubusercontent.icu"), false);
  });

  it("大小写和空白不影响判定 —— 信封上什么形态都可能来", () => {
    const box = burner.openBurner({ userId: USER });
    if (!box.ok) return;
    assert.equal(routing.deliverableAddress(`  ${box.box.address.toUpperCase()}  `), true);
  });

  it("★ 到期的地址不再收信 —— 回收任务 5 分钟才跑一次，判定不能等它", () => {
    const box = burner.openBurner({ userId: USER });
    if (!box.ok) return;

    dbm.db
      .update(schema.mailBoxes)
      .set({ expiresAt: Date.now() - 1000 })
      .where(eq(schema.mailBoxes.id, box.box.id))
      .run();

    // 一个到期的地址随时会被别人抢走，那时这些信就落到别人手里了
    assert.equal(routing.deliverableAddress(box.box.address), false);
  });

  it("销毁掉的地址收不到", () => {
    const box = burner.openBurner({ userId: USER });
    if (!box.ok) return;
    burner.destroyBurner(box.box.id, { userId: USER });
    assert.equal(routing.deliverableAddress(box.box.address), false);
  });

  it("catch-all 域名上任意前缀都收得到 —— 「任意别名」靠的就是它", () => {
    dbm.db
      .update(schema.mailDomains)
      .set({ ownerUserId: USER, catchAll: true })
      .where(eq(schema.mailDomains.domain, "muran.icu"))
      .run();

    assert.equal(routing.deliverableAddress("netflix-2026@muran.icu"), true);
    assert.equal(routing.deliverableAddress("随便什么@muran.icu"), true);
  });

  it("catch-all 关掉之后，没登记的前缀就收不到了", () => {
    dbm.db
      .update(schema.mailDomains)
      .set({ ownerUserId: USER, catchAll: false })
      .where(eq(schema.mailDomains.domain, "muran.icu"))
      .run();

    assert.equal(routing.deliverableAddress("netflix-2026@muran.icu"), false);
  });

  it("拆不动的地址一律不收，不抛", () => {
    for (const bad of ["", "no-at-sign", "@leading", "trailing@"]) {
      assert.doesNotThrow(() => routing.deliverableAddress(bad));
      assert.equal(routing.deliverableAddress(bad), false, bad);
    }
  });
});
