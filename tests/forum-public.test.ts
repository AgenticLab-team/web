import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { CONDITIONAL_PREFIXES } from "@/lib/auth/routes";
import { NAV, navItemVisible, type NavItem } from "@/lib/nav";

/**
 * 「论坛允许未登录浏览」这个开关。
 *
 * ─────────────────────────────────────────
 * 它在后台摆了很久，而没有任何地方读它
 * ─────────────────────────────────────────
 *
 * `site.forum_public` 在设置页上写着「论坛允许未登录浏览」，
 * 管理员关掉它 —— **什么都不会发生**，论坛照样对所有人敞着。
 *
 * 一个关不上的开关比没有开关坏得多：它不是少了个功能，
 * 是给了一个错误的答案。管理员关掉之后不会再去验证，
 * 因为界面已经告诉他关上了。
 *
 * ─────────────────────────────────────────
 * 关门要关全部的门
 * ─────────────────────────────────────────
 *
 * 这一条最容易做成半拉子：页面拦住了，而分享卡片图还在往
 * 微信和抓取器里送标题摘要 —— 那张图是独立路由，layout 覆盖不到。
 *
 * 所以这个文件按**入口**来数，不按代码来数。
 */

const root = new URL("..", import.meta.url).pathname;
const src = (p: string) => readFileSync(join(root, "src", p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("**开关真的被读了**", () => {
  it("有一处读 site.forum_public", () => {
    assert.match(strip(src("lib/forum/public-access.ts")), /getSettingBool\("site\.forum_public"/);
  });

  it("**默认开着** —— 接一个一直没生效的开关不该顺手改掉现状", () => {
    assert.match(strip(src("lib/forum/public-access.ts")), /"site\.forum_public",\s*true/);
  });

  it("**只有一处真的去读它**", () => {
    /*
     * 两处的话迟早分叉，而分叉出来更松的那一份就是漏的那个口。
     *
     * 数的是「读」（`getSetting*`），不是「提到」——
     * `routes.ts` 的有条件前缀表里写着它归哪个开关管，那是**说明**，
     * 不是第二次判定。把说明也算成读的话，这条测试会逼着人
     * 把说明删掉，而说明正是下一个人需要的东西。
     */
    let hits = 0;
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const f = join(d, e.name);
        if (e.isDirectory()) walk(f);
        // defaults.ts 是它被**声明**的地方，不是第二个读它的地方
        else if (
          /\.(ts|tsx)$/.test(e.name) &&
          !f.endsWith("public-access.ts") &&
          !f.endsWith("settings/defaults.ts")
        ) {
          if (/getSetting\w*\(\s*"site\.forum_public"/.test(strip(readFileSync(f, "utf8")))) hits++;
        }
      }
    };
    walk(join(root, "src"));
    assert.equal(hits, 0, "还有别的地方自己读了这个配置项");
  });

  it("**有条件前缀表上写的开关名，和真正读的那个是同一个**", () => {
    /*
     * 两个地方各写一遍字符串，写错一个字母就是：
     * 表上说归 A 管、代码读的是 B，而两边看起来都对。
     */
    const forum = CONDITIONAL_PREFIXES.find((c) => c.prefix === "/forum");
    assert.ok(forum, "有条件前缀表里没有 /forum");
    assert.match(
      strip(src("lib/forum/public-access.ts")),
      new RegExp(`getSettingBool\\("${forum.setting.replace(/\./g, "\\.")}"`),
    );
  });
});

describe("**每一条读论坛的口子都被管住**", () => {
  it("页面：靠 layout 收口，不是每页各写一遍", () => {
    /*
     * `/forum` 下面有 8 条路径，而且还会再长。每页各判一次的话，
     * 漏掉的一定是最新加的那条 —— 这个仓库反复出现的形状就是
     * 「规则在一条路上成立、在另一条路上不成立」。
     */
    const layout = strip(src("app/(app)/forum/layout.tsx"));
    /*
     * 把守卫的**形状**钉死，不只是「文件里提到过这个函数」。
     *
     * 只断言函数名出现过的话，把条件改成 `if (false)` 照样绿 ——
     * 这是把这条测试拆开验证时真的发生的事。
     */
    assert.match(layout, /if\s*\(\s*!canReadForum\(user\?\.id\)\s*\)\s*\{[\s\S]{0,200}?redirect\(/);
  });

  it("**跳登录而不是 404** —— 论坛存在这件事不是秘密", () => {
    // 藏起来只会让人以为网站坏了；说清楚是要登录，人才知道下一步做什么
    assert.match(strip(src("app/(app)/forum/layout.tsx")), /\/login\?next=/);
  });

  it("**分享卡片图单独接了一次** —— layout 覆盖不到独立路由", () => {
    /*
     * 漏掉这一处的话：论坛对访客关着，而每条链接的预览图
     * 还在往微信、Telegram、抓取器里送标题和摘要。
     */
    assert.match(strip(src("app/(app)/forum/p/[id]/opengraph-image.tsx")), /canReadForum\(/);
  });

  it("短链不重复判 —— 它只跳转，落地之后由 layout 管", () => {
    // 重复判就是两套逻辑，迟早分叉
    assert.equal(strip(src("app/p/[code]/route.ts")).includes("canReadForum"), false);
  });

  it("**没有别的 API 在往外吐论坛内容**", () => {
    /*
     * 数一遍 `src/app/api` 下面涉及论坛的路由 —— 只有草稿那一条，
     * 而草稿本来就必须登录。新加一条公开的论坛接口时这一条会红。
     */
    const apis: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name === "route.ts") apis.push(f.slice(join(root, "src/app/api").length));
      }
    };
    walk(join(root, "src/app/api"));
    const forumish = apis.filter((p) => /forum|post|reply/.test(p));
    assert.deepEqual(forumish, ["/forum/draft/route.ts"], `新的论坛接口要过一遍这个开关：${forumish}`);
  });
});

describe("导航", () => {
  const forum = NAV.flatMap((s) => s.items).find((i) => i.key === "forum") as NavItem;
  const ctx = (over: Partial<Parameters<typeof navItemVisible>[1]>) => ({
    loggedIn: false,
    hasPermission: () => true,
    ...over,
  });

  it("开着的时候访客看得到入口", () => {
    assert.equal(navItemVisible(forum, ctx({ guestOpen: () => true })), true);
  });

  it("**关掉之后访客的导航里就没有它了**", () => {
    // 挂着的话，点进去弹登录，看起来像网站坏了
    assert.equal(navItemVisible(forum, ctx({ guestOpen: () => false })), false);
  });

  it("**登录用户不受影响** —— 这个开关管的是访客", () => {
    assert.equal(
      navItemVisible(forum, ctx({ loggedIn: true, guestOpen: () => false })),
      true,
    );
  });

  it("不传 guestOpen 就当开着 —— 忘了传的后果是照常显示，比反过来安全", () => {
    assert.equal(navItemVisible(forum, ctx({})), true);
  });

  it("**榜单不受它管** —— 「未登录访客还是可以看见大榜单的」", () => {
    /*
     * 榜单是这个社区对外的门面，论坛是里面的内容 —— 关门不关脸。
     * 所以这个判定挂在论坛那一项上，不做成全站中间件。
     */
    const items = NAV.flatMap((s) => s.items);
    const keyed = items.filter((i) => i.guestOpenKey);
    assert.deepEqual(
      keyed.map((i) => i.key),
      ["forum"],
      "别的入口也挂上了这个开关",
    );
  });
});

/* ───────────────────────────────────────────────────────────────
 * 真数据库 —— 结构断言看得见「写了什么」，看不见「跑起来是什么」
 * ─────────────────────────────────────────────────────────────── */

describe("真库", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "al-forum-public-"));
  process.env.DB_PATH = join(tmp, "test.db");
  process.env.NEKOBOT_API_KEY = "nk_test";

  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const store = await import("@/lib/settings/store");
  const gate = await import("@/lib/forum/public-access");

  after(() => rmSync(tmp, { recursive: true, force: true }));

  const setSwitch = (value: string) => {
    dbm.db.delete(schema.settings).run();
    dbm.db
      .insert(schema.settings)
      .values({ key: "site.forum_public", value, type: "bool", category: "site" })
      .run();
    store.invalidateSettingsCache();
  };

  it("没配过的时候是开着的 —— 现状不变", () => {
    dbm.db.delete(schema.settings).run();
    store.invalidateSettingsCache();
    assert.equal(gate.forumOpenToGuests(), true);
    assert.equal(gate.canReadForum(null), true);
  });

  it("**关掉之后访客读不了**", () => {
    setSwitch("false");
    assert.equal(gate.canReadForum(null), false);
    assert.equal(gate.canReadForum(undefined), false);
    assert.equal(gate.canReadForum(""), false, "空字符串是「没登录」，不是「登录了」");
  });

  it("**关掉之后登录用户照样读得了**", () => {
    setSwitch("false");
    assert.equal(gate.canReadForum("u_1"), true);
  });

  it("改回来立刻生效 —— 配置有缓存，别让管理员以为没保存上", () => {
    setSwitch("false");
    assert.equal(gate.canReadForum(null), false);
    setSwitch("true");
    assert.equal(gate.canReadForum(null), true);
  });
});

describe("**开关只管访客，不替代可见性**", () => {
  it("门里面每篇帖子照旧各判各的", () => {
    /*
     * 两者是与的关系，不是替代关系：开着的时候访客能看到的
     * 依然只有 public 那一档，关掉的时候访客一篇都看不到。
     *
     * 也就是说这道门**不许**碰查询层 —— 碰了就是第二套可见性。
     */
    const gate = strip(src("lib/forum/public-access.ts"));
    for (const forbidden of ["canSeePost", "visibleGroupIds", "listPosts"]) {
      assert.equal(gate.includes(forbidden), false, `这道门碰了 ${forbidden}，成了第二套可见性`);
    }
  });

  it("登录用户永远进得来", () => {
    assert.match(strip(src("lib/forum/public-access.ts")), /Boolean\(userId\) \|\|/);
  });
});
