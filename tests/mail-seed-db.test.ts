import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq, inArray } from "drizzle-orm";

/**
 * 域名种子 —— 接上真库之后。
 *
 * 重点只有两处，而且都是**认错人**的那一类错：
 *   · 归属是从 activity_applications 查出来的，查错就是把域名给了别人
 *   · niuniu 那位登记的名字和实际买到的域名**不是同一个** ——
 *     替代品表接不上的话，他手里那张空头支票永远兑不了
 */

const tmp = mkdtempSync(join(tmpdir(), "al-mailseed-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let seed: typeof import("@/lib/mail/seed-domains");

const APPLICANT = "01USER_AETHER";
const NIUNIU = "01USER_NIUNIU";
const OWNER = "01USER_OWNER";
const ACTIVITY = "01ACTIVITY_DOMAIN";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  seed = await import("@/lib/mail/seed-domains");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.mailDomains,
    schema.mailBanwords,
    schema.activityApplications,
    schema.userRoles,
    schema.roles,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }

  const stamp = { createdAt: Date.now(), updatedAt: Date.now() };
  for (const id of [APPLICANT, NIUNIU, OWNER]) {
    dbm.db.insert(schema.users).values({ id, kind: "member", status: "active", ...stamp }).run();
  }

  dbm.db.insert(schema.roles).values({ id: "01ROLE_OWNER", key: "owner", name: "站长", ...stamp }).run();
  dbm.db
    .insert(schema.userRoles)
    .values({ id: "01UR_OWNER", userId: OWNER, roleId: "01ROLE_OWNER" })
    .run();

  const app = (id: string, userId: string, key: string) =>
    dbm.db
      .insert(schema.activityApplications)
      .values({
        id,
        activityId: ACTIVITY,
        userId,
        normalizedKey: key,
        status: "submitted",
        ...stamp,
      })
      .run();

  app("01APP_AETHER", APPLICANT, "aetherstudio.icu");
  // 这位登记的是 niuniu.icu —— 而它 2023 年就被别人注册了
  app("01APP_NIUNIU", NIUNIU, "niuniu.icu");
});

describe("灌域名", () => {
  it("100 个全部写进去，且 punycode 一个都没出问题", () => {
    const r = seed.seedMailDomains();
    assert.equal(r.domains, 100);
    assert.deepEqual(r.punycodeProblems, [], "punycode 转换出问题 = 那个域名会静默收不到信");
  });

  it("★ 到期日全部补上 —— 空的到期日不触发任何告警", () => {
    const r = seed.seedMailDomains();
    assert.equal(r.expiryFilled, 100);

    const rows = dbm.db.select().from(schema.mailDomains).all();
    assert.equal(rows.filter((d) => d.domainExpiresAt === null).length, 0);
    assert.equal(
      new Date(rows[0].domainExpiresAt!).toISOString().slice(0, 10),
      "2027-08-08",
    );
  });

  it("★ 到期日只填空、不覆盖 —— 后台改过的不该被重置", () => {
    seed.seedMailDomains();
    const custom = Date.UTC(2030, 0, 1);
    dbm.db
      .update(schema.mailDomains)
      .set({ domainExpiresAt: custom })
      .where(eq(schema.mailDomains.domain, "tsuki.icu"))
      .run();

    const again = seed.seedMailDomains();
    assert.equal(again.expiryFilled, 0);

    const row = dbm.db
      .select()
      .from(schema.mailDomains)
      .where(eq(schema.mailDomains.domain, "tsuki.icu"))
      .get();
    assert.equal(row?.domainExpiresAt, custom);
  });

  it("★ 幂等：再跑一次不新增", () => {
    seed.seedMailDomains();
    const again = seed.seedMailDomains();
    assert.equal(again.domains, 0);
    assert.equal(again.banwords, 0);
  });

  it("★ 只补不改：管理员改过的分类不会被下次启动重置", () => {
    seed.seedMailDomains();

    // 管理员把一个靓号调进一次性池 —— 这是一次有意的决定
    dbm.db
      .update(schema.mailDomains)
      .set({ kind: "temp", tier: null })
      .where(eq(schema.mailDomains.domain, "tsuki.icu"))
      .run();

    seed.seedMailDomains();

    const row = dbm.db
      .select()
      .from(schema.mailDomains)
      .where(eq(schema.mailDomains.domain, "tsuki.icu"))
      .get();
    assert.equal(row?.kind, "temp", "被重置回去的话，后台那一页就是假的");
  });

  it("中文域名存的是 A 标签", () => {
    seed.seedMailDomains();
    const row = dbm.db
      .select()
      .from(schema.mailDomains)
      .where(eq(schema.mailDomains.domain, "华立.icu"))
      .get();
    assert.equal(row?.punycode, "xn--xkrw23g.icu");
  });
});

describe("认领归属", () => {
  it("从 activity_applications 认到人头上，并记下是哪条申请", () => {
    seed.seedMailDomains();
    const row = dbm.db
      .select()
      .from(schema.mailDomains)
      .where(eq(schema.mailDomains.domain, "aetherstudio.icu"))
      .get();

    assert.equal(row?.ownerUserId, APPLICANT);
    // 「这个域名凭什么是他的」要答得上
    assert.equal(row?.sourceApplicationId, "01APP_AETHER");
  });

  it("★ niuniu 那位拿到的是 niuniu869.icu —— 他登记的那个根本没买到", () => {
    seed.seedMailDomains();
    const row = dbm.db
      .select()
      .from(schema.mailDomains)
      .where(eq(schema.mailDomains.domain, "niuniu869.icu"))
      .get();
    assert.equal(row?.ownerUserId, NIUNIU, "替代品表接不上的话，他那张空头支票永远兑不了");
  });

  it("站长的两个域名认到站长头上", () => {
    seed.seedMailDomains();
    const rows = dbm.db
      .select()
      .from(schema.mailDomains)
      .where(inArray(schema.mailDomains.domain, ["muran.icu", "jiangmuran.icu"]))
      .all();
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.ownerUserId, OWNER);
      assert.equal(r.kind, "owned");
      assert.equal(r.catchAll, true, "自有域名那条路径的第一个用户就是站长本人");
    }
  });

  it("★ 查不到人的域名留空，不乱认", () => {
    seed.seedMailDomains();
    // 这个域名的主人还没在库里出现过
    const row = dbm.db
      .select()
      .from(schema.mailDomains)
      .where(eq(schema.mailDomains.domain, "zennon.icu"))
      .get();
    assert.equal(row?.ownerUserId, null, "宁可没主人，也不能认错人");
  });

  it("★ 后台改过的归属不会被下次启动覆盖", () => {
    seed.seedMailDomains();

    dbm.db
      .update(schema.mailDomains)
      .set({ ownerUserId: OWNER })
      .where(eq(schema.mailDomains.domain, "aetherstudio.icu"))
      .run();

    seed.seedMailDomains();

    const row = dbm.db
      .select()
      .from(schema.mailDomains)
      .where(eq(schema.mailDomains.domain, "aetherstudio.icu"))
      .get();
    assert.equal(row?.ownerUserId, OWNER);
  });

  it("没有站长这个身份组时，站长那两个域名留空而不是认给某个人", () => {
    dbm.db.delete(schema.userRoles).run();
    seed.seedMailDomains();
    const row = dbm.db
      .select()
      .from(schema.mailDomains)
      .where(eq(schema.mailDomains.domain, "muran.icu"))
      .get();
    assert.equal(row?.ownerUserId, null);
  });
});

describe("看起来是给某人的那 21 个", () => {
  it("★ 匹配上的转成 owned 并认到人头上", () => {
    // 这一批测试数据里，APPLICANT 认领过 aetherstudio.icu
    dbm.db
      .insert(schema.activityApplications)
      .values({
        id: "01APP_SHIP",
        activityId: ACTIVITY,
        userId: APPLICANT,
        normalizedKey: "shipowner.icu",
        status: "submitted",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();

    const r = seed.seedMailDomains();

    const hit = r.matched.find((m) => m.domain === "ashipowner.icu");
    assert.ok(hit, "ashipowner 该认给 shipowner 的主人");
    assert.equal(hit.userId, APPLICANT);
    assert.match(hit.why, /shipowner/, "理由要说得出口");

    const row = dbm.db
      .select()
      .from(schema.mailDomains)
      .where(eq(schema.mailDomains.domain, "ashipowner.icu"))
      .get();
    assert.equal(row?.kind, "owned");
    assert.equal(row?.catchAll, true, "自有域名那条路的意义就是 catch-all");
    assert.equal(row?.allowBurner, false);
    assert.equal(row?.tier, null, "转成 owned 之后不该还挂着靓号档位");
  });

  it("★ 匹配不上的留在靓号池，不乱认", () => {
    seed.seedMailDomains();
    const row = dbm.db
      .select()
      .from(schema.mailDomains)
      .where(eq(schema.mailDomains.domain, "borancui.icu"))
      .get();
    assert.equal(row?.ownerUserId, null, "宁可进公共池，也不能认错人");
    assert.equal(row?.kind, "reserved");
  });

  it("★ 认过一次之后不会被下次启动改掉", () => {
    seed.seedMailDomains();
    dbm.db
      .update(schema.mailDomains)
      .set({ ownerUserId: OWNER })
      .where(eq(schema.mailDomains.domain, "borancui.icu"))
      .run();

    const again = seed.seedMailDomains();
    assert.equal(again.matched.some((m) => m.domain === "borancui.icu"), false);

    const row = dbm.db
      .select()
      .from(schema.mailDomains)
      .where(eq(schema.mailDomains.domain, "borancui.icu"))
      .get();
    assert.equal(row?.ownerUserId, OWNER);
  });
});

describe("站长人工确认的配对", () => {
  it("★ 顺着配对的那个域名查出人 —— 不是写死人名", () => {
    // LAY 认领过 layopc.icu，所以 lay621.icu 该跟着归他
    const LAY = "01USER_LAY";
    const stamp = { createdAt: Date.now(), updatedAt: Date.now() };
    dbm.db.insert(schema.users).values({ id: LAY, kind: "member", status: "active", ...stamp }).run();
    dbm.db
      .insert(schema.activityApplications)
      .values({
        id: "01APP_LAY",
        activityId: ACTIVITY,
        userId: LAY,
        normalizedKey: "layopc.icu",
        status: "submitted",
        ...stamp,
      })
      .run();

    const r = seed.seedMailDomains();

    const hit = r.matched.find((m) => m.domain === "lay621.icu");
    assert.ok(hit, "lay621 该跟着 layopc 归同一个人");
    assert.equal(hit.userId, LAY);
    assert.match(hit.why, /站长确认/);
    assert.match(hit.why, /layopc/, "理由里要指明是跟哪个域名配的");
  });

  it("★ 配对的那个域名还没主人时跳过，不乱认", () => {
    // 没人认领过 layopc.icu 的这一轮
    const r = seed.seedMailDomains();
    assert.equal(r.matched.some((m) => m.domain === "lay621.icu"), false);

    const row = dbm.db
      .select()
      .from(schema.mailDomains)
      .where(eq(schema.mailDomains.domain, "lay621.icu"))
      .get();
    assert.equal(row?.ownerUserId, null, "宁可这轮不认，下轮那个人绑定了自然会认上");
  });
});

describe("内置禁用词", () => {
  it("postmaster 和 abuse 标成 builtin —— 后台删不掉", () => {
    seed.seedMailDomains();
    const rows = dbm.db
      .select()
      .from(schema.mailBanwords)
      .where(inArray(schema.mailBanwords.word, ["postmaster", "abuse"]))
      .all();
    assert.equal(rows.length, 2);
    for (const r of rows) assert.equal(r.builtin, true);
  });

  it("别的内置词是普通词，管理员可以删", () => {
    seed.seedMailDomains();
    const row = dbm.db
      .select()
      .from(schema.mailBanwords)
      .where(eq(schema.mailBanwords.word, "billing"))
      .get();
    assert.equal(row?.builtin, false);
  });
});
