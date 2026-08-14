import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readCode } from "./_source";

/**
 * 排行榜。
 *
 * ─────────────────────────────────────────
 * 没注册过这个站的人也在榜上
 * ─────────────────────────────────────────
 *
 * 榜单按 `daily_stats` 的 wx_id 聚合 —— 也就是说**群里的每一个人
 * 都在榜上，包括从没打开过这个站的人**。线上第 4 活跃的那位就没有账号。
 *
 * 而退出榜单的开关（`user_privacy.hide_from_leaderboard`）
 * 需要一个账号才拨得动。于是暴露对所有人成立，
 * 而退出只对加入过的人开放 —— 这条不对称站不住。
 *
 * 隐私页自己写着：「这个站把发言量做成了对未登录访客公开的榜单，
 * 这是微信里不存在的暴露」。一个从没来过的人，
 * 不该因为别人建了这个站而把微信昵称和头像挂到公网上。
 *
 * ─────────────────────────────────────────
 * 隐去名字，不隐去这个人
 * ─────────────────────────────────────────
 *
 * 名次和条数照旧 —— 那是社区真实的活跃分布，抹掉它等于让榜单说假话。
 * 隐去的只有身份：名字和头像。
 *
 * 登录成员看得到全名：他们和这些人在同一批群里，
 * 那些昵称他们每天都在微信里看见，这里没有多出新的暴露。
 */

describe("真库", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "al-board-"));
  process.env.DB_PATH = join(tmp, "test.db");
  process.env.NEKOBOT_API_KEY = "nk_test";

  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const board = await import("@/lib/queries/leaderboard");
  const { todayKey } = await import("@/lib/time");

  after(() => rmSync(tmp, { recursive: true, force: true }));

  const CONV = "g_a";
  const reset = () => {
    for (const t of [
      schema.dailyStats,
      schema.people,
      schema.userPrivacy,
      schema.users,
      schema.groups,
    ]) {
      dbm.db.delete(t).run();
    }
    dbm.db.insert(schema.groups).values({ convId: CONV, name: "A 群", isGroup: true }).run();
  };

  /** 一行当天统计 —— 榜单是从这张表聚合出来的 */
  const stat = (wxId: string, quality: number) =>
    dbm.db
      .insert(schema.dailyStats)
      .values({
        wxId,
        convId: CONV,
        date: todayKey(),
        messages: quality,
        qualityMessages: quality,
        charsTotal: quality * 20,
      })
      .run();

  /** 群成员档案（来自上游同步）—— 有档案不代表有账号 */
  const person = (wxId: string, name: string) =>
    dbm.db
      .insert(schema.people)
      .values({ wxId, displayName: name, avatarUrl: `https://x/${wxId}.jpg` })
      .run();

  /** 真的注册过这个站 */
  const account = (id: string, wxId: string) =>
    dbm.db.insert(schema.users).values({ id, wxId, status: "active" }).run();

  const guest = () => board.getLeaderboard({ period: "all", convIds: [CONV], viewer: null });
  const member = () =>
    board.getLeaderboard({
      period: "all",
      convIds: [CONV],
      viewer: { id: "u_me", wxId: "wx_me" } as never,
    });

  describe("**访客看到的榜单**", () => {
    it("**没账号的人不具名**", () => {
      reset();
      stat("wx_ghost", 100);
      person("wx_ghost", "群里的老王");
      const [row] = guest();
      assert.equal(row.name, "群成员");
      assert.equal(row.avatarUrl, null);
    });

    it("**名次和条数照旧是真的** —— 抹掉它等于让榜单说假话", () => {
      reset();
      stat("wx_ghost", 100);
      person("wx_ghost", "群里的老王");
      const [row] = guest();
      assert.equal(row.rank, 1);
      assert.equal(row.quality, 100);
    });

    it("有账号的人照常显示名字", () => {
      reset();
      stat("wx_a", 100);
      person("wx_a", "小明");
      account("u_a", "wx_a");
      assert.equal(guest()[0].name, "小明");
    });

    it("**登录成员看得到全名** —— 那些昵称他们每天在微信里都看见", () => {
      reset();
      stat("wx_ghost", 100);
      person("wx_ghost", "群里的老王");
      assert.equal(member()[0].name, "群里的老王");
    });

    it("匿名不改变排序", () => {
      reset();
      stat("wx_ghost", 200);
      person("wx_ghost", "老王");
      stat("wx_a", 100);
      person("wx_a", "小明");
      account("u_a", "wx_a");
      assert.deepEqual(guest().map((r) => r.quality), [200, 100]);
      assert.deepEqual(guest().map((r) => r.name), ["群成员", "小明"]);
    });

    it("**wx_id 永远不会出现在名字里** —— 那是隐私事故", () => {
      /*
       * 没有档案的人走 resolveDisplayName 的兜底。
       * 兜底如果回落成 wx_id，榜单就把微信号发到公网上了。
       */
      reset();
      stat("wxid_secret_abc", 50);
      for (const row of guest()) {
        assert.equal(row.name.includes("wxid_"), false, `名字里带了 wx_id：${row.name}`);
      }
    });
  });

  describe("**藏起来的人对谁都不出现，「谁藏了自己」谁都拿不到**", () => {
    /*
     * 这里原来是反的：管理员看到完整的榜，藏起来的那几行标着「仅你可见」。
     * 理由写的是「不然他会以为公开的榜就长这样」——
     * 而那句话是反的，公开的榜**就是**长这样。
     *
     * 站长自己把自己藏了、换个有管理权限的账号一看还在榜上，
     * 这条才被翻出来。榜单开关对用户说的是
     * 「关掉之后别人看到的榜单里没有你」，一句没有例外的话。
     *
     * 「谁藏了自己」这个答案现在谁都拿不到 —— 它一旦被显示出来，
     * 藏起来的人反而比不藏更显眼。
     */
    const hide = (userId: string) =>
      dbm.db
        .insert(schema.userPrivacy)
        .values({ userId, hideFromLeaderboard: true })
        .run();

    it("**「谁藏了自己」这个字段已经不存在了** —— 连管理员也没有", () => {
      /*
       * 不是「不给普通成员」，是**根本不产出**。
       * 只要它还在响应里，就总有一天会被渲染出来。
       */
      const q = readFileSync(
        new URL("../src/lib/queries/leaderboard.ts", import.meta.url),
        "utf8",
      );
      assert.equal(q.includes("hiddenFromOthers"), false);
      const list = readFileSync(
        new URL("../src/components/LeaderboardList.tsx", import.meta.url),
        "utf8",
      );
      assert.equal(list.includes("仅你可见"), false, "界面上还标着别人藏没藏");
    });

    it("**普通成员的结果里没有审计字段**", () => {
      /*
       * 用一个**没藏起来**的人来测 —— 藏起来的那个对谁都不出现，
       * 拿它测的话，测的是「排除生效了」而不是「字段没漏」。
       */
      reset();
      stat("wx_a", 100);
      person("wx_a", "小明");
      account("u_a", "wx_a");
      const [row] = member();
      assert.equal("hiddenFromOthers" in row, false, "把「谁藏了自己」告诉普通成员了");
      assert.equal("anonymousToGuests" in row, false);
    });

    it("**访客那一侧同样没有审计字段**", () => {
      reset();
      stat("wx_ghost", 100);
      const [row] = guest();
      assert.equal("hiddenFromOthers" in row, false);
      assert.equal("anonymousToGuests" in row, false);
    });

    it("**字段只在特权视角下才加** —— 判定写在查询层", () => {
      /*
       * 靠页面记得不渲染是不行的：这两个字段一旦进了响应，
       * 任何一个能看网络面板的成员都拿得到。
       */
      const q = readFileSync(
        new URL("../src/lib/queries/leaderboard.ts", import.meta.url),
        "utf8",
      );
      assert.match(q, /const privacy = leaderboardPrivacy\(options\.viewer \?\? null\)/);
      assert.match(q, /\.\.\.\(privileged[\s\S]{0,20}\?[\s\S]{0,10}\{/);
    });

    it("**权限只在 privacy/queries.ts 里判一次**", () => {
      /*
       * 分开调的话 `bypassesPrivacy` 会被判两遍 ——
       * 而它背后是一次完整的权限解析，一次榜单查询因此多花三条 SQL。
       *
       * 更要紧的是漏判的方向：调用点各写一遍的话，
       * 漏的永远是「把关掉开关的人重新暴露出去」。
       */
      const pq = readFileSync(
        new URL("../src/lib/privacy/queries.ts", import.meta.url),
        "utf8",
      );
      assert.match(pq, /export function leaderboardPrivacy\(/);

      const q = readFileSync(
        new URL("../src/lib/queries/leaderboard.ts", import.meta.url),
        "utf8",
      );
      assert.equal(q.includes("bypassesPrivacy"), false, "榜单自己又判了一遍权限");
    });

    it("**排除名单不看视角有没有权限** —— 管理员和普通成员拿到同一份", () => {
      /*
       * 带真角色的那一版在 `tests/privacy-switches.test.ts` 里
       * （那边有 RBAC 夹具）。这里盯的是更硬的一条：
       * 这个函数**根本不问权限**，所以不存在「谁能绕过」这个问题。
       */
      // 必须去注释：那个函数上面**写着**当年那条豁免长什么样
      const pq = readCode("lib/privacy/queries.ts");
      const start = pq.indexOf("export function leaderboardHiddenWxIds");
      const body = pq.slice(start, pq.indexOf("\nexport ", start + 1));
      assert.notEqual(start, -1);
      assert.equal(
        /bypassesPrivacy|exemptFrom|moderation\.queue/.test(body),
        false,
        "榜单排除名单又开始看视角的权限了",
      );
    });

    it("**藏起来的人对普通成员根本不出现** —— 那才是开关的本意", () => {
      reset();
      stat("wx_a", 100);
      person("wx_a", "小明");
      account("u_a", "wx_a");
      hide("u_a");
      assert.deepEqual(member().map((r) => r.wxId), []);
    });

    it("访客那一侧同样看不到藏起来的人", () => {
      reset();
      stat("wx_a", 100);
      person("wx_a", "小明");
      account("u_a", "wx_a");
      hide("u_a");
      assert.deepEqual(guest().map((r) => r.wxId), []);
    });
  });

  describe("看不到任何群的人拿到空榜", () => {
    it("不传群 = 空榜，不是全量榜", () => {
      reset();
      stat("wx_a", 100);
      assert.deepEqual(board.getLeaderboard({ period: "all", convIds: [], viewer: null }), []);
    });
  });
});

describe("接线", () => {
  it("**页面上说明了不具名这件事** —— 不说的话一串「群成员」看起来像数据坏了", () => {
    const page = readFileSync(
      new URL("../src/app/(app)/leaderboard/page.tsx", import.meta.url),
      "utf8",
    );
    assert.match(page, /不具名/);
  });

  it("**匿名只针对访客** —— 判定写在查询层，不靠页面记得传", () => {
    const q = readFileSync(new URL("../src/lib/queries/leaderboard.ts", import.meta.url), "utf8");
    assert.match(q, /const anonymize = !options\.viewer;/);
  });
});

describe("**界面上的两个标**", () => {
  const list = readFileSync(
    new URL("../src/components/LeaderboardList.tsx", import.meta.url),
    "utf8",
  );

  it("**自己藏起来时，自己那一行标着「仅自己可见」**", () => {
    /*
     * 藏起来的人榜上还看得到自己（排除名单里没有自己）。
     * 不标的话，他看到的榜和没藏时一模一样，也就没有任何办法
     * 确认那一下拨生效了 —— 而只能靠相信的隐私开关跟没有是一样的。
     */
    assert.match(list, /meHidden \? "仅自己可见" : "你"/);
  });

  it("「访客不具名」标出没注册过本站的人", () => {
    assert.match(list, /entry\.anonymousToGuests &&/);
    assert.match(list, /访客不具名/);
  });

  it("**组件不自己判权限** —— 字段在查询层就只给特权视角", () => {
    /*
     * 组件里再判一次的话，就有两处在决定「谁看得到这个信息」，
     * 而两处迟早分叉。更要紧的是：字段一旦进了响应，
     * 任何一个能看网络面板的成员都拿得到 —— 藏在组件里没有用。
     */
    assert.equal(list.includes("moderation.queue"), false);
    assert.equal(list.includes("bypassesPrivacy"), false);
  });

  it("**「访客不具名」说的不是隐私开关** —— 别让人以为管理员多看到了什么", () => {
    /*
     * 这是榜上唯一一个「管理员多看到的东西」，而它多出来的信息是
     * 「这个账号存不存在」，不是任何人拨的开关。
     */
    assert.match(list, /访客不具名/);
    assert.equal(list.includes("仅你可见"), false);
  });
});
