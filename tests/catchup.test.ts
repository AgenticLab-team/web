import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

/**
 * 新人补课包。
 *
 * ─────────────────────────────────────────
 * 这一页会把一个群一次全端出来
 * ─────────────────────────────────────────
 *
 * 群名、成员数、常驻成员的名字和头像、活跃时段、最热闹的日子、
 * 分享过的链接 —— 全在一屏里。
 *
 * 「群列表属于隐私，登录用户也只能看到自己所在的群的信息」
 * 这条规矩在这一页上的分量比别处都重：别的页面漏一点是漏一个数字，
 * 这里漏一次是把整个群的画像交给一个不在群里的人。
 *
 * 所以下面第一组测试全是**越权**，而不是功能。
 */

const TMP = mkdtempSync(join(tmpdir(), "al-catchup-"));
process.env.DB_PATH = join(TMP, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
process.env.SITE_URL = "https://example.test";

describe("补课包", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { groupCatchup, hasEnoughToShow, peakHourOf } = await import("@/lib/onboarding/catchup");
  const { sql } = await import("drizzle-orm");

  after(() => rmSync(TMP, { recursive: true, force: true }));

  const MINE = "mine@chatroom";
  const THEIRS = "theirs@chatroom";

  /** 在群里的人 */
  const me = { id: "u_me", wxId: "wx_me" } as never;

  function reset() {
    for (const t of [
      schema.dailyStats,
      schema.messages,
      schema.groupMembers,
      schema.groups,
      schema.people,
      schema.userPrivacy,
      schema.users,
      schema.links,
      schema.linkMentions,
    ]) {
      dbm.db.delete(t).run();
    }

    for (const convId of [MINE, THEIRS]) {
      dbm.db
        .insert(schema.groups)
        .values({ convId, name: `群 ${convId}`, isGroup: true, memberCount: 10, syncEnabled: true })
        .run();
    }
    // 我只在 MINE 里
    dbm.db.insert(schema.groupMembers).values({ convId: MINE, wxId: "wx_me" }).run();
  }

  let seq = 0;
  function stat(over: {
    convId?: string;
    wxId?: string;
    date?: string;
    messages?: number;
    quality?: number;
    hours?: number[];
  }) {
    const hours = over.hours ?? new Array(24).fill(0);
    dbm.db
      .insert(schema.dailyStats)
      .values({
        convId: over.convId ?? MINE,
        wxId: over.wxId ?? "wx_a",
        date: over.date ?? "2026-06-01",
        messages: over.messages ?? 1,
        qualityMessages: over.quality ?? over.messages ?? 1,
        charsTotal: 20,
        hourHistogram: hours,
      })
      .run();
  }

  /** 补课包只在「站里真的有消息」时才成立，所以得有真消息行 */
  function message(convId = MINE) {
    dbm.db
      .insert(schema.messages)
      .values({
        id: `m${++seq}`,
        convId,
        senderWxId: "wx_a",
        type: "text",
        content: "内容",
        length: 20,
        ts: Date.UTC(2026, 5, 1, 4),
      })
      .run();
  }

  const person = (wxId: string, name: string) =>
    dbm.db
      .insert(schema.people)
      .values({ wxId, displayName: name, avatarUrl: `https://x/${wxId}.jpg` })
      .run();

  describe("**越权**", () => {
    it("**不在这个群的人拿不到它** —— 这是整页最要紧的一条", () => {
      /*
       * 第一版这里写的是 `assertGroupAccess(user, convId);` ——
       * 把返回值丢掉了。而**那个函数返回 null，不抛异常**，
       * 名字里的 assert 会骗人。
       *
       * 结果是：任何一个登录用户都能拿到任何一个群的
       * 群名、常驻成员和活跃时段。
       */
      reset();
      stat({ convId: THEIRS });
      message(THEIRS);
      assert.equal(groupCatchup(me, THEIRS), null, "把别人群的画像端出来了");
    });

    it("**访客什么也拿不到**", () => {
      reset();
      stat({});
      message();
      assert.equal(groupCatchup(null, MINE), null);
    });

    it("**退群之后立刻失去**", () => {
      reset();
      stat({});
      message();
      assert.ok(groupCatchup(me, MINE), "在群里的时候应该拿得到");

      dbm.db.update(schema.groupMembers).set({ leftAt: Date.now() }).run();
      assert.equal(groupCatchup(me, MINE), null, "退群之后还看得到这个群的画像");
    });

    it("在自己的群里正常拿得到", () => {
      reset();
      stat({});
      message();
      const pack = groupCatchup(me, MINE);
      assert.ok(pack);
      assert.equal(pack.convId, MINE);
    });
  });

  describe("**隐私开关在这一页同样生效**", () => {
    /*
     * 一个人把自己从公开榜单上摘了，结果在「谁是谁」里
     * 被当成常驻介绍给每一个新人 —— 那个开关就等于没有。
     */
    const hide = (userId: string, wxId: string) => {
      dbm.db.insert(schema.users).values({ id: userId, wxId, status: "active" }).run();
      dbm.db.insert(schema.userPrivacy).values({ userId, hideFromLeaderboard: true }).run();
    };

    it("**藏起来的人不出现在「先认识这几位」里**", () => {
      reset();
      message();
      stat({ wxId: "wx_hidden", messages: 500, quality: 500 });
      stat({ wxId: "wx_open", messages: 10, quality: 10 });
      person("wx_hidden", "藏起来的人");
      person("wx_open", "普通人");
      hide("u_hidden", "wx_hidden");

      const pack = groupCatchup(me, MINE)!;
      assert.deepEqual(
        pack.voices.map((v) => v.wxId),
        ["wx_open"],
        "把关掉开关的人当常驻介绍出去了",
      );
    });

    it("**排除之后仍然凑得满** —— 不能因为剔掉一个就少一个位置", () => {
      /*
       * 先取 8 个再剔除的话，剔掉一个就只剩 7 个 ——
       * 而第 9 名本该顶上来。这个错不会报任何错，
       * 只会让列表悄悄变短。
       */
      reset();
      message();
      for (let i = 0; i < 10; i++) {
        stat({ wxId: `wx_${i}`, messages: 100 - i, quality: 100 - i });
        person(`wx_${i}`, `第 ${i} 位`);
      }
      hide("u_0", "wx_0");

      const pack = groupCatchup(me, MINE)!;
      assert.equal(pack.voices.length, 8, "剔掉一个之后没有补齐");
      assert.equal(pack.voices.some((v) => v.wxId === "wx_0"), false);
    });

    it("**豁免判定不在这个文件里重写一遍**", () => {
      /*
       * 自己查一遍 user_privacy 的话，「管理员看得到全部」
       * 和「自己永远看得到自己」这两条例外就有了第二处实现，
       * 而漏判的方向永远是「把关掉开关的人重新暴露出去」。
       */
      const src = readFileSync(
        new URL("../src/lib/onboarding/catchup.ts", import.meta.url),
        "utf8",
      );
      assert.match(src, /leaderboardHiddenWxIds\(user\)/);
      assert.equal(src.includes("hideFromLeaderboard"), false, "自己又查了一遍 user_privacy");
      assert.equal(src.includes("bypassesPrivacy"), false, "自己又判了一遍权限");
    });

    it("**名字永远不会回落成 wx_id**", () => {
      // 没有档案的人走兜底 —— 兜底如果回落成 wx_id，微信号就上了页面
      reset();
      message();
      stat({ wxId: "wxid_secret_abc", messages: 5 });
      const pack = groupCatchup(me, MINE)!;
      for (const v of pack.voices) {
        assert.equal(v.name.includes("wxid_"), false, `名字里带了 wx_id：${v.name}`);
      }
    });
  });

  describe("节奏", () => {
    it("小时分布是 24 格，且把每一天累加起来", () => {
      reset();
      message();
      const h = new Array(24).fill(0);
      h[21] = 5;
      stat({ date: "2026-06-01", hours: h });
      stat({ date: "2026-06-02", hours: h });

      const pack = groupCatchup(me, MINE)!;
      assert.equal(pack.hours.length, 24);
      assert.equal(pack.hours[21], 10);
      assert.equal(pack.hours[3], 0);
    });

    it("**双重编码的旧行不会让整页崩** —— 那一列历史上被 stringify 过两次", () => {
      reset();
      message();
      stat({});
      // 手动写回一个「装着数组的字符串」，正是修复前的形态
      dbm.db.run(sql`UPDATE daily_stats SET hour_histogram = '"[1,2,3]"'`);
      assert.doesNotThrow(() => groupCatchup(me, MINE));
      // 崩不崩之外还要问：坏行有没有污染累加结果
      assert.equal(groupCatchup(me, MINE)!.hours.length, 24);
    });

    it("**活跃日均按有记录的天算** —— 否则长期潜水的群会被摊平成 0", () => {
      reset();
      message();
      stat({ date: "2026-06-01", messages: 100 });
      stat({ date: "2026-06-02", messages: 200 });
      const pack = groupCatchup(me, MINE)!;
      assert.equal(pack.activeDays, 2);
      assert.equal(pack.perActiveDay, 150);
    });

    it("一条记录都没有时不除以零", () => {
      reset();
      message();
      const pack = groupCatchup(me, MINE)!;
      assert.equal(pack.perActiveDay, 0);
      assert.equal(Number.isFinite(pack.perActiveDay), true);
    });

    it("最热闹的几天按条数倒序", () => {
      reset();
      message();
      stat({ date: "2026-06-01", messages: 10 });
      stat({ date: "2026-06-02", messages: 90 });
      stat({ date: "2026-06-03", messages: 50 });
      const pack = groupCatchup(me, MINE)!;
      assert.deepEqual(pack.busiestDays.map((d) => d.date), [
        "2026-06-02",
        "2026-06-03",
        "2026-06-01",
      ]);
    });

    it("**同一天多个人算作一天，人数分别数**", () => {
      reset();
      message();
      stat({ date: "2026-06-01", wxId: "wx_a", messages: 10 });
      stat({ date: "2026-06-01", wxId: "wx_b", messages: 20 });
      const pack = groupCatchup(me, MINE)!;
      assert.equal(pack.busiestDays.length, 1);
      assert.equal(pack.busiestDays[0].messages, 30);
      assert.equal(pack.busiestDays[0].speakers, 2);
    });

    it("**别的群的数据不混进来**", () => {
      reset();
      message();
      stat({ convId: MINE, messages: 10 });
      stat({ convId: THEIRS, messages: 999 });
      const pack = groupCatchup(me, MINE)!;
      assert.equal(pack.busiestDays[0].messages, 10);
    });
  });

  describe("peakHourOf", () => {
    it("挑最高的那一格", () => {
      const h = new Array(24).fill(0);
      h[9] = 3;
      h[22] = 7;
      assert.equal(peakHourOf(h), 22);
    });

    it("**全是 0 时返回 null** —— 不能把 0 点当成「他常在凌晨」", () => {
      assert.equal(peakHourOf(new Array(24).fill(0)), null);
    });

    it("形状不对就返回 null，不猜", () => {
      assert.equal(peakHourOf(null), null);
      assert.equal(peakHourOf("不是 json"), null);
      assert.equal(peakHourOf([1, 2, 3]), null);
      assert.equal(peakHourOf({}), null);
    });

    it("字符串形态的 json 也认", () => {
      const h = new Array(24).fill(0);
      h[5] = 2;
      assert.equal(peakHourOf(JSON.stringify(h)), 5);
    });
  });

  describe("空群", () => {
    it("**一条消息都没有的群不值得单独讲一页**", () => {
      /*
       * 线上真有这么一个群。端一屏「0 条 / 0 个常驻 / 没有链接」
       * 给新人看，比不显示这个群更糟 —— 它看起来像是站坏了。
       */
      reset();
      const pack = groupCatchup(me, MINE)!;
      assert.equal(hasEnoughToShow(pack), false);
    });

    it("有内容的群通过", () => {
      reset();
      message();
      stat({});
      assert.equal(hasEnoughToShow(groupCatchup(me, MINE)!), true);
    });
  });
});

describe("接线", () => {
  const page = readFileSync(
    new URL("../src/app/(app)/welcome/page.tsx", import.meta.url),
    "utf8",
  );

  it("**这一页在登录名单里** —— 页面里的 redirect 不算数", () => {
    /*
     * 只靠页面 redirect 的话，访客拿到的是 200 加一个空壳，
     * 地址栏、标题、加载过程全都发生过一遍。
     * 论坛那道门线上实测就是这样。
     */
    const routes = readFileSync(new URL("../src/lib/auth/routes.ts", import.meta.url), "utf8");
    assert.match(routes, /"\/welcome"/);
    const proxy = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");
    assert.match(proxy, /"\/welcome"/);
  });

  it("**每个群的可见性单独判一次** —— 不是拿到列表就全信", () => {
    assert.match(page, /groupCatchup\(user, g\.convId\)/);
  });

  it("**空群被过滤掉**", () => {
    assert.match(page, /hasEnoughToShow/);
  });

  it("**有入口** —— 到不了的页面等于没有", () => {
    const home = readFileSync(new URL("../src/app/(app)/page.tsx", import.meta.url), "utf8");
    const onboarding = readFileSync(
      new URL("../src/app/onboarding/page.tsx", import.meta.url),
      "utf8",
    );
    assert.match(home, /href="\/welcome"/);
    assert.match(onboarding, /href="\/welcome"/);
  });

  it("**页面说清楚了这里没有「精选」**", () => {
    /*
     * 这一页刻意不做「历史精华 Top 20」：is_quality 只是长度的代理，
     * reply_to_id 全表为空。不说明的话，人会以为这个站
     * 判断不出好内容 —— 而事实是它诚实地没有编。
     */
    assert.match(page, /没有「精选」/);
  });
});
