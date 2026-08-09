import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { stripComments as strip } from "./_source";

/**
 * 会话与设备。
 *
 * ─────────────────────────────────────────
 * 两个一直没人管的问题
 * ─────────────────────────────────────────
 *
 * **① 会话只增不减。** 每次登录新建一行，没有任何地方合并或回收 ——
 * 线上有人三天里攒了 25 个活会话。「登录设备」那一页因此变成
 * 一串认不出来的条目，而这一页存在的唯一理由，
 * 就是让人发现不该在的那一台。
 *
 * **② 过期的从来没删过。** 30 天 TTL、一百多人，一年下来几万行；
 * 每一行都带着 IP 和 UA —— 那是「谁在哪儿上过网」的记录，
 * 留着不看等于白留一份可泄露的东西。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

/**
 * 和 `session.ts` 里的算法一致。
 *
 * 这里重算而不是把内部函数导出去：**库里只存哈希**是那个模块的
 * 一条内部约定，导出它等于邀请别处也来算一遍。
 */
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/* ───────────────────────────────────────────────────────────────
 * UA 识别 —— 内嵌浏览器必须排在前面
 * ─────────────────────────────────────────────────────────────── */

describe("**微信被显示成了 Chrome**", async () => {
  process.env.NEKOBOT_API_KEY ??= "nk_test";
  const { describeDevice } = await import("@/lib/auth/devices");

  it("安卓微信 —— UA 里带 Chrome/ 和 Safari/，以前一直认成 Chrome", () => {
    /*
     * 这是线上真实 UA 的形状。65 个来自微信的会话里 47 个含 `Chrome/`，
     * 而 `MicroMessenger` 被排在 Chrome 后面判 —— 永远轮不到。
     */
    const ua =
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Version/4.0 Chrome/132.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.32.2300 NetType/WIFI";
    assert.equal(describeDevice(ua), "Android · 微信");
  });

  it("iPhone 微信", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.75(0x18004b57) NetType/WIFI";
    assert.equal(describeDevice(ua), "iPhone · 微信");
  });

  it("**电脑版微信也是微信** —— 线上确实有", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/132.0.0.0 Safari/537.36 NetType/WIFI MicroMessenger/7.0.20.1781";
    assert.equal(describeDevice(ua), "Windows · 微信");
  });

  it("**企业微信要排在微信前面** —— 它的 UA 里同时带 MicroMessenger", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/132.0.0.0 Mobile Safari/537.36 " +
      "MicroMessenger/7.0.1 wxwork/4.0.6 MailPlugin_Enterprise";
    assert.equal(describeDevice(ua), "Android · 企业微信");
  });

  it("真的 Chrome 还是 Chrome —— 别矫枉过正", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/150.0.0.0 Mobile Safari/537.36";
    assert.equal(describeDevice(ua), "Android · Chrome");
  });

  it("Edge 仍然先于 Chrome —— 它的 UA 里也带 Chrome/", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0";
    assert.equal(describeDevice(ua), "Windows · Edge");
  });

  it("桌面 Safari 还是 Safari", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    assert.equal(describeDevice(ua), "Mac · Safari");
  });

  it("认不出来就说未知，不瞎猜", () => {
    assert.equal(describeDevice(null), "未知设备");
    assert.equal(describeDevice("curl/8.4.0"), "未知设备");
  });

  it("**内嵌浏览器那张表排在通用判断之前**", () => {
    /*
     * 顺序在这里是语义不是风格。把这条写成结构断言，
     * 是因为「谁在前谁在后」在代码里看不出重要性 ——
     * 而调换一下就会静默地回到「所有微信都是 Chrome」。
     */
    const code = strip(src("lib/auth/devices.ts"));
    assert.ok(
      code.indexOf("IN_APP") < code.indexOf('"Edge"'),
      "内嵌浏览器表跑到通用判断后面去了",
    );
    assert.ok(
      code.indexOf("wxwork") < code.indexOf("MicroMessenger"),
      "企业微信必须排在微信前面",
    );
  });
});

/* ───────────────────────────────────────────────────────────────
 * 真数据库
 * ─────────────────────────────────────────────────────────────── */

describe("真库", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "al-session-"));
  process.env.DB_PATH = join(tmp, "test.db");
  process.env.NEKOBOT_API_KEY = "nk_test";

  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const store = await import("@/lib/settings/store");
  const session = await import("@/lib/auth/session");
  const devices = await import("@/lib/auth/devices");

  after(() => rmSync(tmp, { recursive: true, force: true }));

  const USER = "u_1";
  const setCap = (n: number) => {
    dbm.db.delete(schema.settings).run();
    dbm.db
      .insert(schema.settings)
      .values({ key: "auth.session.max_per_user", value: String(n), type: "int", category: "auth" })
      .run();
    store.invalidateSettingsCache();
  };

  const reset = () => {
    dbm.db.delete(schema.sessions).run();
    dbm.db.delete(schema.users).run();
    dbm.db.insert(schema.users).values({ id: USER, wxId: "wx_1", status: "active" }).run();
  };

  const live = () =>
    dbm.db
      .select()
      .from(schema.sessions)
      .all()
      .filter((s) => s.revokedAt === null && s.expiresAt > Date.now());

  describe("**同时登录的设备有上限**", () => {
    it("没超上限时一个都不踢", () => {
      reset();
      setCap(5);
      for (let i = 0; i < 3; i++) session.createSession(USER);
      assert.equal(live().length, 3);
    });

    it("**超了就踢，且新建的这个必须留着**", () => {
      /*
       * 踢掉刚建的那个是最坏的结果：人刚登录就被登出，
       * 而且会一直循环 —— 他会以为网站坏了。
       */
      reset();
      setCap(3);
      const tokens = Array.from({ length: 5 }, () => session.createSession(USER));
      assert.equal(live().length, 3);
      assert.ok(session.resolveSession(tokens[4]), "最后登录的那个被自己踢掉了");
    });

    it("**踢的是最久没露面的，不是最早创建的**", () => {
      /*
       * 一台天天在用的老设备，比一台上周登过一次的新设备更该留着。
       */
      reset();
      setCap(2);
      const old = session.createSession(USER);
      session.createSession(USER);
      // 老设备今天还在用
      dbm.db
        .update(schema.sessions)
        .set({ lastSeenAt: Date.now() + 60_000 })
        .where(eq(schema.sessions.tokenHash, hashToken(old)))
        .run();
      session.createSession(USER);
      assert.ok(session.resolveSession(old), "天天在用的老设备被踢了");
    });

    it("踢掉时写明原因，不是留一行空白", () => {
      reset();
      setCap(1);
      session.createSession(USER);
      session.createSession(USER);
      const revoked = dbm.db
        .select()
        .from(schema.sessions)
        .all()
        .filter((s) => s.revokedAt !== null);
      assert.equal(revoked.length, 1);
      assert.equal(revoked[0].revokeReason, "session_cap");
      assert.equal(revoked[0].revokedBy, "system:session-cap");
    });

    it("**别人的会话不受影响**", () => {
      reset();
      dbm.db.insert(schema.users).values({ id: "u_2", wxId: "wx_2", status: "active" }).run();
      setCap(1);
      const other = session.createSession("u_2");
      session.createSession(USER);
      session.createSession(USER);
      assert.ok(session.resolveSession(other), "把别人也踢了");
    });
  });

  describe("**自动下线要说出来**", () => {
    it("发生过就报得出条数和时间", () => {
      reset();
      setCap(1);
      session.createSession(USER);
      session.createSession(USER);
      const note = devices.recentAutoRevoked(USER);
      assert.equal(note?.count, 1);
    });

    it("没发生过就是 null —— 不显示一句「下线了 0 台」", () => {
      reset();
      setCap(5);
      session.createSession(USER);
      assert.equal(devices.recentAutoRevoked(USER), null);
    });

    it("久远的不再提 —— 一个月前的事没必要天天说", () => {
      reset();
      setCap(1);
      session.createSession(USER);
      session.createSession(USER);
      dbm.db
        .update(schema.sessions)
        .set({ revokedAt: Date.now() - 30 * 86_400_000 })
        .run();
      assert.equal(devices.recentAutoRevoked(USER, 7), null);
    });

    it("**手动下线的不算进来** —— 那是用户自己干的，不用解释", () => {
      reset();
      setCap(5);
      session.createSession(USER);
      dbm.db.update(schema.sessions).set({ revokedAt: Date.now(), revokeReason: "logout" }).run();
      assert.equal(devices.recentAutoRevoked(USER), null);
    });
  });

  describe("**过期的要真的删掉**", () => {
    it("过期的删", () => {
      reset();
      setCap(50);
      session.createSession(USER);
      dbm.db.update(schema.sessions).set({ expiresAt: Date.now() - 1000 }).run();
      assert.equal(session.pruneSessions(), 1);
      assert.equal(dbm.db.select().from(schema.sessions).all().length, 0);
    });

    it("没过期的不删", () => {
      reset();
      setCap(50);
      session.createSession(USER);
      assert.equal(session.pruneSessions(), 0);
    });

    it("**刚下线的留着** —— 「这台什么时候被谁下线的」还要答得上来", () => {
      reset();
      setCap(50);
      session.createSession(USER);
      dbm.db.update(schema.sessions).set({ revokedAt: Date.now(), revokeReason: "logout" }).run();
      assert.equal(session.pruneSessions(), 0, "刚下线就删了，登录历史会说不清");
    });

    it("下线很久的才删", () => {
      reset();
      setCap(50);
      session.createSession(USER);
      dbm.db
        .update(schema.sessions)
        .set({ revokedAt: Date.now() - 200 * 86_400_000, revokeReason: "logout" })
        .run();
      assert.equal(session.pruneSessions(), 1);
    });
  });
});

/* ───────────────────────────────────────────────────────────────
 * 接线
 * ─────────────────────────────────────────────────────────────── */

describe("接线", () => {
  it("清理挂在存储裁剪那一步里 —— 不单开定时器", () => {
    assert.match(strip(src("lib/storage/prune.ts")), /result\.sessionRows = pruneSessions\(now\)/);
  });

  it("上限和保留天数都是可配的，不是魔法数字", () => {
    const s = strip(src("lib/auth/session.ts"));
    assert.match(s, /getSettingInt\("auth\.session\.max_per_user"/);
    assert.match(s, /getSettingInt\("auth\.session\.revoked_keep_days"/);
  });

  it("**安全页真的把自动下线那句话显示出来了**", () => {
    const page = strip(src("app/(app)/me/security/page.tsx"));
    assert.match(page, /recentAutoRevoked\(/);
    assert.match(page, /autoRevoked=\{autoRevoked\}/);
  });

  it("先插入再收口 —— 反过来的话上限 N 实际只能有 N-1 个", () => {
    const s = strip(src("lib/auth/session.ts"));
    const insertAt = s.indexOf(".insert(sessions)");
    const capAt = s.indexOf("enforceSessionCap(userId, getSettingInt");
    assert.ok(insertAt > 0 && capAt > insertAt, "收口跑到插入前面去了");
  });
});
