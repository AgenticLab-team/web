import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  PRIVACY_DEFAULTS,
  PRIVACY_SWITCHES,
  sourceOf,
  type PrivacySettings,
  hiddenCount,
  isPrivacyKey,
  storedValue,
  switchIsOn,
  withDefaults,
} from "@/lib/privacy/rules";
import { stripComments as strip } from "./_source";

/**
 * 隐私开关。
 *
 * ─────────────────────────────────────────
 * `user_privacy` 整张表没有人用
 * ─────────────────────────────────────────
 *
 * 建表注释的原话是「群聊可检索这件事需要它来平衡」——
 * 而这张表在 schema 之外**零读零写**。四个开关，一个都没接上过。
 *
 * 也就是说：这个站把 45,000 条群聊做成了全文可检索、
 * 把发言量做成了对未登录访客公开的榜单，而当初说好用来平衡它的
 * 那个东西从来不存在。
 *
 * 这比一个坏掉的功能更糟 —— 坏掉的功能人看得出来，
 * 一个没接线的隐私开关**看起来是好的**。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("**开和藏是反的，而翻转只能有一处**", () => {
  it("字段叫 hide_*，界面问的是「要不要出现」", () => {
    // 库里 true = 藏起来；界面上 false = 不出现
    assert.equal(switchIsOn("hideFromLeaderboard", true), false);
    assert.equal(switchIsOn("hideFromLeaderboard", false), true);
  });

  it("不用翻的那个不许被翻", () => {
    assert.equal(switchIsOn("searchableByOthers", true), true);
    assert.equal(switchIsOn("searchableByOthers", false), false);
  });

  it("**来回一趟要回到原处** —— 翻两次等于没翻，少翻一次会让人点了「隐藏」反而更暴露", () => {
    for (const spec of PRIVACY_SWITCHES) {
      for (const on of [true, false]) {
        assert.equal(switchIsOn(spec.key, storedValue(spec.key, on)), on, spec.key);
      }
    }
  });

  it("界面上的标题一律是肯定句 —— 「不要不出现」没有人读得懂", () => {
    for (const spec of PRIVACY_SWITCHES) {
      // 注意别把「**别**人能搜到我的发言」误判成否定句 —— 那是主语不是否定词
      assert.equal(
        /隐藏|不出现|不要|禁止|关闭/.test(spec.label),
        false,
        `${spec.key} 的标题是否定句：${spec.label}`,
      );
    }
  });
});

describe("**默认什么都不藏**", () => {
  it("没有这一行的人按默认算 —— 绝大多数人永远不会打开这一页", () => {
    assert.deepEqual(withDefaults(null), PRIVACY_DEFAULTS);
    assert.deepEqual(withDefaults(undefined), PRIVACY_DEFAULTS);
  });

  it("默认是公开的", () => {
    /*
     * 默认隐身的话，榜单和检索一开始就是空的 ——
     * 而一个空榜单没有人会再打开第二次。
     */
    for (const spec of PRIVACY_SWITCHES) {
      assert.equal(switchIsOn(spec.key, PRIVACY_DEFAULTS[spec.key]), true, spec.key);
    }
  });

  it("有一半的行也能补齐另一半", () => {
    assert.deepEqual(withDefaults({ hideFromLeaderboard: true }), {
      directoryHidden: false,
      hideFromLeaderboard: true,
      searchableByOthers: true,
    });
  });
});

describe("开关名是从客户端来的", () => {
  it("认得真的开关", () => {
    for (const spec of PRIVACY_SWITCHES) assert.equal(isPrivacyKey(spec.key), true);
  });

  it("**`__proto__` 不许被当成合法开关** —— `in` 会走原型链", () => {
    assert.equal(isPrivacyKey("__proto__"), false);
    assert.equal(isPrivacyKey("constructor"), false);
    assert.equal(isPrivacyKey("toString"), false);
  });

  it("校验用的是自有键判断，不是 `in`", () => {
    assert.match(strip(src("lib/privacy/rules.ts")), /Object\.hasOwn/);
  });
});

describe("每个开关都要说清楚它**不管**什么", () => {
  /*
   * 一个隐私开关最坏的形态不是没有，是让人以为它管得比实际多 ——
   * 那样他会照着一个不存在的保护去说话。
   */
  for (const spec of PRIVACY_SWITCHES) {
    it(`${spec.key} 有 exposure 和 limit 两段话`, () => {
      assert.ok(spec.exposure.length > 10, "没说清楚现在暴露的是什么");
      assert.ok(spec.limit.length > 10, "没说清楚它不管什么");
    });
  }

  it("检索那条要明说「按天翻仍然看得到」", () => {
    const spec = PRIVACY_SWITCHES.find((s) => s.key === "searchableByOthers")!;
    assert.match(spec.limit, /翻|回看|记录/);
  });

  it("「不管什么」只在关掉之后才显示", () => {
    // 一直显示的话，从来没打算关的人要先读两段免责声明
    assert.match(src("components/me/PrivacyToggle.tsx"), /\{!on && \(/);
  });
});

describe("摘要", () => {
  const settings = (over: Partial<PrivacySettings> = {}): PrivacySettings => ({
    directoryHidden: false,
    hideFromLeaderboard: false,
    searchableByOthers: true,
    ...over,
  });

  it("藏了几样就说几样", () => {
    assert.equal(hiddenCount(settings()), 0);
    assert.equal(hiddenCount(settings({ hideFromLeaderboard: true })), 1);
    assert.equal(hiddenCount(settings({ hideFromLeaderboard: true, searchableByOthers: false })), 2);
  });

  it("**隐身也算一样** —— 它和另外两个是同一件事", () => {
    assert.equal(hiddenCount(settings({ directoryHidden: true })), 1);
    assert.equal(
      hiddenCount(settings({ directoryHidden: true, hideFromLeaderboard: true, searchableByOthers: false })),
      3,
    );
  });
});

describe("**三个开关在一处**", () => {
  /*
   * 「隐身」原来单独摆在个人资料页上，另外两个在隐私页 ——
   * 而三个问的是同一件事：谁看得见我。
   *
   * 分成两页的后果不是多点一次，是**有人设了其中一个就以为设完了**。
   * 而这一页顶上那句话已经说清了这种失败：一个隐私开关最坏的形态
   * 不是没有，是让人以为它管得比实际多。
   */
  it("清单里就是这三个", () => {
    assert.deepEqual(
      PRIVACY_SWITCHES.map((s) => s.key),
      ["directoryHidden", "hideFromLeaderboard", "searchableByOthers"],
    );
  });

  it("**每个都说明自己存在哪张表**", () => {
    // 隐身在 users.directory_hidden，另两个在 user_privacy
    assert.equal(sourceOf("directoryHidden"), "users");
    assert.equal(sourceOf("hideFromLeaderboard"), "user_privacy");
    assert.equal(sourceOf("searchableByOthers"), "user_privacy");
  });

  it("**写入按 source 分流，界面不知道有两张表**", () => {
    /*
     * 界面知道的话，下一个加开关的人得先搞清楚它该写哪儿，
     * 而写错的表现是「拨了没反应」。
     */
    const actions = src("lib/privacy/actions.ts");
    assert.match(actions, /sourceOf\(column\) === "users"/);
    assert.match(actions, /db[\s\S]{0,20}\.update\(users\)/);
  });

  it("**旧的那条写路已经删掉了** —— 两条写同一列迟早分叉", () => {
    // 先去注释：那个文件里留了一段说明它为什么被删，正好含这个名字
    assert.equal(strip(src("lib/members/actions.ts")).includes("setDirectoryHidden"), false);
  });

  it("个人资料页只显示状态，不再自己改", () => {
    const profile = src("app/(app)/me/profile/page.tsx");
    assert.equal(profile.includes("DirectoryToggle"), false);
    assert.match(profile, /href="\/me\/privacy"/);
  });

  it("隐身那一条要说清楚**它不管已经发过的内容**", () => {
    // 藏的是「被列出来」，不是发言 —— 不说的话有人会以为帖子也一起藏了
    const spec = PRIVACY_SWITCHES.find((s) => s.key === "directoryHidden")!;
    assert.match(spec.limit, /不管|已经发过|帖子/);
  });
});

describe("接线", () => {
  it("规则层是纯的", () => {
    const rules = src("lib/privacy/rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(rules.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });

  it("**「我的」页面上有入口** —— 一个到不了的隐私页等于没有", () => {
    assert.match(src("app/(app)/me/page.tsx"), /href="\/me\/privacy"/);
  });

  it("摘要说的是「藏起来了几样」，不是「已开启」", () => {
    /*
     * 一个三个月前关过某个开关的人根本想不起来自己关过，
     * 然后会来问「为什么我不在榜上」。
     */
    assert.match(src("app/(app)/me/page.tsx"), /藏起来了 \$\{privacyHidden\}/);
  });

  it("**拨开关不记审计**", () => {
    /*
     * 审计表只增不删、owner 都删不掉。把「谁在什么时候把自己藏起来了」
     * 记成一条永久记录，恰好是这个功能要避免的事 —— 那比不给开关更糟。
     */
    const actions = strip(src("lib/privacy/actions.ts"));
    assert.equal(actions.includes("audit("), false, "隐私开关居然记了审计");
  });

  it("写库走 upsert —— 「先查再插」在两个设备上同时拨会撞主键", () => {
    assert.match(strip(src("lib/privacy/actions.ts")), /onConflictDoUpdate/);
  });

  it("保存失败要把界面拨回去", () => {
    // 隐私开关尤其不能「点了看起来生效了、其实没存上」—— 那正是这一整块要治的病
    assert.match(src("components/me/PrivacyToggle.tsx"), /setOn\(!next\)/);
  });
});

describe("**每一条检索路径都要接上，一条都不能漏**", () => {
  /*
   * 漏掉一条的后果不是「少了个功能」，是这个开关整个是假的 ——
   * 而用户看不出来，他会照着一个不存在的保护去说话。
   */
  for (const [what, file] of [
    ["关键词检索", "lib/search/messages.ts"],
    ["语义检索", "lib/search/semantic.ts"],
    ["整理成帖子里的检索", "lib/forum/convert-source.ts"],
    /*
     * 关键词雷达是**第五个**入口，一开始被漏掉了。
     *
     * 漏掉的原因很典型：雷达写在这个开关之前，而接线那一轮
     * 心里的全集是「四个检索出口」—— 连 privacy/queries.ts 的注释
     * 都写着「四个调用点」。一个写在开关之前的功能，
     * 不会因为它叫「雷达」而不是「搜索」就不是搜索。
     *
     * 它甚至比搜索更进一步：命中会**主动推送**给订阅者，
     * 带昵称和高亮片段，还常驻在他的雷达页上 —— 对方连搜都不用搜。
     */
    ["关键词雷达", "lib/radar/engine.ts"],
  ] as const) {
    it(`${what}接上了`, () => {
      assert.match(strip(src(file)), /unsearchableWxIds\(/, `${file} 没有过滤`);
    });
  }

  it("榜单接上了", () => {
    /*
     * 榜单走的是 `leaderboardPrivacy` —— 它一次算完两件事：
     * 「该排除谁」和「哪几行别人看不到」（后者只给管理员）。
     *
     * 分成两次调用的话，权限解析要跑两遍，一次榜单查询多三条 SQL；
     * 而且豁免判定就散成了两处。
     */
    assert.match(strip(src("lib/queries/leaderboard.ts")), /leaderboardPrivacy\(/);
  });

  it("**关键词检索的过滤落在 SQL 里**，不是查出来再 filter", () => {
    /*
     * total 是单独一条 count 查询。两边口径不一致的话会出现
     * 「共 30 条」但只列出 24 条，翻到第二页是空的。
     */
    const s = strip(src("lib/search/messages.ts"));
    assert.match(s, /filters\.push\(`m\.sender_wx_id NOT IN/);
  });

  it("**榜单的过滤落在聚合之前**", () => {
    /*
     * 查完再 filter 的话名次会错：第 3 名被滤掉之后，
     * 原来的第 4 名仍然显示「第 4 名」，而榜上只有 49 行 ——
     * 那等于把「有人藏起来了」这件事本身广播出去。
     */
    assert.match(strip(src("lib/queries/leaderboard.ts")), /notInArray\(dailyStats\.wxId/);
  });

  it("上一周期用同一份排除名单 —— 两边口径不同的话升降箭头会指向一个没出现过的名次", () => {
    const s = strip(src("lib/queries/leaderboard.ts"));
    /*
     * 两个**调用点**都要把 hidden 传进去。
     * 结尾必须写成 `, hidden)` 才算 —— 只匹配 `hidden` 的话，
     * 函数定义里那个 `hiddenWxIds` 参数也会被算进来，
     * 于是这条断言在只传了一处的情况下照样是绿的。
     */
    assert.equal((s.match(/aggregate\([^)]*, hidden\)/g) ?? []).length, 2);
  });

  it("**按天回看不加这个过滤**，而且这件事是写下来了的", () => {
    /*
     * 那是同群的人在看自己群里的记录 —— 那些话他们本来就在微信里看过。
     * 开关管的是「搜」。这一条要写在代码里，
     * 否则下一个人会以为是漏了，顺手加上，而那会让「按天回看」出现空洞。
     */
    const raw = src("lib/forum/convert-source.ts");
    assert.match(raw, /messagesOfDay[\s\S]*不加这个过滤|按天翻那条路[\s\S]*不加/);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 真数据库
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-privacy-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let pq: typeof import("@/lib/privacy/queries");
let board: typeof import("@/lib/queries/leaderboard");

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  pq = await import("@/lib/privacy/queries");
  board = await import("@/lib/queries/leaderboard");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const CONV = "conv_1";

/**
 * 造一个「看榜的人」。
 *
 * 默认没有任何权限 —— 豁免是管理员才有的，
 * 用一个自带权限的假 user 去测「普通人看不到」，那条断言就是摆设。
 */
const userOf = (id: string, wxId: string | null, roleKey?: string) =>
  ({ id, wxId, status: "active", kind: "member", roleKey }) as unknown as Parameters<
    typeof board.getMyRank
  >[0];
const today = () => {
  const d = new Date(1786000000000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

beforeEach(() => {
  for (const t of [
    schema.userPrivacy,
    schema.userRoles,
    schema.rolePermissions,
    schema.roles,
    schema.users,
    schema.dailyStats,
    schema.people,
  ]) {
    dbm.db.delete(t).run();
  }

  /*
   * 真的建一个有 moderation.queue 的身份组，而不是伪造一个「看起来像管理员」
   * 的对象 —— 豁免是靠 `can()` 判的，用假对象测等于什么都没测。
   */
  dbm.db
    .insert(schema.roles)
    .values([
      { id: "r_member", key: "member", name: "成员" },
      { id: "r_mod", key: "moderator", name: "版主" },
    ])
    .run();
  dbm.db
    .insert(schema.rolePermissions)
    .values([{ roleId: "r_mod", permissionKey: "moderation.queue" }])
    .run();

  for (const [id, wx] of [
    ["u_a", "wx_a"],
    ["u_b", "wx_b"],
    ["u_c", "wx_c"],
  ] as const) {
    dbm.db.insert(schema.users).values({ id, wxId: wx, status: "active" }).run();
    dbm.db.insert(schema.people).values({ wxId: wx, displayName: `人${wx.at(-1)}` }).run();
  }
});

const stat = (wxId: string, quality: number) =>
  dbm.db
    .insert(schema.dailyStats)
    .values({ wxId, convId: CONV, date: today(), messages: quality, qualityMessages: quality })
    .run();

const hide = (userId: string, field: "hideFromLeaderboard" | "searchableByOthers", value: boolean) =>
  dbm.db
    .insert(schema.userPrivacy)
    .values({ userId, [field]: value, updatedAt: 1 })
    .onConflictDoUpdate({ target: schema.userPrivacy.userId, set: { [field]: value } })
    .run();

describe("榜单（真库）", () => {
  it("没人藏的时候三个人都在", () => {
    stat("wx_a", 30);
    stat("wx_b", 20);
    stat("wx_c", 10);
    assert.equal(board.getLeaderboard({ period: "all", convIds: [CONV] }).length, 3);
  });

  it("**藏起来的人在别人眼里没有，而且名次不留洞**", () => {
    stat("wx_a", 30);
    stat("wx_b", 20);
    stat("wx_c", 10);
    hide("u_b", "hideFromLeaderboard", true);

    const seen = board.getLeaderboard({ period: "all", convIds: [CONV], viewer: userOf("u_a", "wx_a") });
    assert.deepEqual(
      seen.map((e) => e.wxId),
      ["wx_a", "wx_c"],
    );
    // 名次连续 —— 不连续等于把「有人藏起来了」广播出去
    assert.deepEqual(
      seen.map((e) => e.rank),
      [1, 2],
    );
  });

  it("**自己永远看得到自己**", () => {
    /*
     * 否则拨了开关的人没有任何办法确认它生效了，只能靠相信 ——
     * 而只能靠相信的隐私开关，跟没有是一样的。
     */
    stat("wx_a", 30);
    stat("wx_b", 20);
    hide("u_b", "hideFromLeaderboard", true);

    const mine = board.getMyRank(userOf("u_b", "wx_b"), { period: "all", convIds: [CONV] });
    assert.notEqual(mine, null, "藏起来之后连自己都看不到自己了");
    assert.equal(mine!.wxId, "wx_b");
  });

  it("未登录访客看到的是「所有人都藏起来之后」的那一份", () => {
    stat("wx_a", 30);
    stat("wx_b", 20);
    hide("u_b", "hideFromLeaderboard", true);

    const guest = board.getLeaderboard({ period: "all", convIds: [CONV], viewer: null });
    assert.deepEqual(
      guest.map((e) => e.wxId),
      ["wx_a"],
    );
  });

  it("改回公开就立刻回来了 —— 不用等缓存过期", () => {
    stat("wx_a", 30);
    stat("wx_b", 20);
    hide("u_b", "hideFromLeaderboard", true);
    assert.equal(board.getLeaderboard({ period: "all", convIds: [CONV] }).length, 1);
    hide("u_b", "hideFromLeaderboard", false);
    assert.equal(board.getLeaderboard({ period: "all", convIds: [CONV] }).length, 2);
  });
});

describe("名单（真库）", () => {
  it("排除自己", () => {
    hide("u_a", "searchableByOthers", false);
    hide("u_b", "searchableByOthers", false);
    assert.deepEqual(pq.unsearchableWxIds(userOf("u_a", "wx_a")).sort(), ["wx_b"]);
    assert.deepEqual(pq.unsearchableWxIds(null).sort(), ["wx_a", "wx_b"]);
  });

  it("没绑微信的人不进名单 —— 那串 id 会被塞进 SQL 的 NOT IN", () => {
    dbm.db.insert(schema.users).values({ id: "u_nowx", status: "active" }).run();
    hide("u_nowx", "searchableByOthers", false);
    assert.deepEqual(pq.unsearchableWxIds(null), []);
  });

  it("查一个人的设置，没有行时给默认值", () => {
    assert.deepEqual(pq.privacyOf("u_a"), PRIVACY_DEFAULTS);
    hide("u_a", "hideFromLeaderboard", true);
    assert.equal(pq.privacyOf("u_a").hideFromLeaderboard, true);
  });

});

describe("**管理员不受这两个开关的限制**", () => {
  /*
   * 有人举报一条发言，而发言的人关掉了「别人能搜到我的发言」——
   * 处理举报的人找不到那条内容，举报就处理不了。
   * **一个能被当事人自己关掉的审核，等于没有审核。**
   */
  const admin = () => {
    dbm.db.insert(schema.userRoles).values({ userId: "u_c", roleId: "r_mod" }).run();
    return userOf("u_c", "wx_c");
  };

  it("管理员搜得到关掉了开关的人", () => {
    hide("u_a", "searchableByOthers", false);
    assert.deepEqual(pq.unsearchableWxIds(admin()), [], "管理员那里应该一个都不排");
  });

  it("**普通成员照样搜不到** —— 豁免不能顺手放给所有登录用户", () => {
    hide("u_a", "searchableByOthers", false);
    assert.deepEqual(pq.unsearchableWxIds(userOf("u_b", "wx_b")), ["wx_a"]);
  });

  it("未登录访客当然也搜不到", () => {
    hide("u_a", "searchableByOthers", false);
    assert.deepEqual(pq.unsearchableWxIds(null), ["wx_a"]);
  });

  it("管理员看到的是完整的榜", () => {
    stat("wx_a", 30);
    stat("wx_b", 20);
    hide("u_b", "hideFromLeaderboard", true);

    const seen = board.getLeaderboard({ period: "all", convIds: [CONV], viewer: admin() });
    assert.deepEqual(
      seen.map((e) => e.wxId),
      ["wx_a", "wx_b"],
    );
  });

  it("**被封的管理员没有豁免** —— can() 第一条就把封禁挡在外面", () => {
    dbm.db.insert(schema.userRoles).values({ userId: "u_c", roleId: "r_mod" }).run();
    const banned = userOf("u_c", "wx_c");
    (banned as { status: string }).status = "banned";
    hide("u_a", "searchableByOthers", false);
    assert.deepEqual(pq.unsearchableWxIds(banned), ["wx_a"]);
  });

  it("豁免用的是 moderation.queue，不是「进得了后台」", () => {
    /*
     * `system.dashboard` 宽得多 —— 一个只看仪表盘数字的人
     * 没有理由绕过别人的隐私设置。
     */
    assert.equal(pq.PRIVACY_BYPASS_PERMISSION, "moderation.queue");
  });

  it("**豁免只写在一个地方** —— 四个调用点各写一遍，迟早有一处漏判", () => {
    // 漏判的方向是「把关掉开关的人重新暴露出去」，而且没有人看得出来
    for (const file of [
      "lib/search/messages.ts",
      "lib/search/semantic.ts",
      "lib/forum/convert-source.ts",
      "lib/queries/leaderboard.ts",
    ]) {
      const body = strip(src(file));
      assert.equal(
        /moderation\.queue|bypassesPrivacy/.test(body),
        false,
        `${file} 自己判了一遍权限，应该交给 privacy/queries.ts`,
      );
    }
  });

  it("**开关的说明里要写明管理员搜得到**", () => {
    /*
     * 只写在代码里不算。让人以为管理员也搜不到，
     * 他会照着一个不存在的保护去说话 —— 那比不给开关更糟。
     */
    const spec = PRIVACY_SWITCHES.find((s) => s.key === "searchableByOthers")!;
    assert.match(spec.limit, /管理员|站长|审核/);
  });
});

describe("**关键词雷达也是一个搜索**", () => {
  /*
   * 这一组是一次对抗性审计查出来的：雷达整条链路没接隐私开关。
   * 一个关掉了「别人能搜到我的发言」的人一开口，他的昵称和一段
   * 高亮片段会被主动推给同群的订阅者 —— 而开关的说明写的是
   * 「别人搜关键词、搜语义都搜不到你说过的话」。
   */
  it("匹配循环里排掉了藏起来的人", () => {
    const engine = strip(src("lib/radar/engine.ts"));
    assert.match(engine, /hiddenSet\.has\(message\.senderWxId\)/);
  });

  it("**名单在循环外面取一次** —— 那是「每批消息 × 每个订阅」的双重循环", () => {
    const engine = strip(src("lib/radar/engine.ts"));
    // 只切 scanMessages 这一段。切到文件末尾的话会把 estimateHits7d
    // 里那次合法的查询也算进来 —— 断言范围划错，红的是对的代码
    const loop = engine.slice(
      engine.indexOf("for (const message of rows)"),
      engine.indexOf("function recordHit"),
    );
    assert.equal(loop.includes("unsearchableWxIds("), false, "名单在循环里查库了");
  });

  it("管理员的雷达不受限，而且这个判断也在循环外面算", () => {
    const engine = strip(src("lib/radar/engine.ts"));
    assert.match(engine, /bypassesPrivacy: boolean/);
    const loop = engine.slice(
      engine.indexOf("for (const message of rows)"),
      engine.indexOf("function recordHit"),
    );
    assert.match(loop, /!watcher\.bypassesPrivacy/);
    assert.equal(loop.includes("bypassesPrivacy({"), false, "在循环里判权限了");
  });

  it("**预估那条也要过** —— 同一个词在两处返回的数不一样，本身就是信息", () => {
    /*
     * 差值等于「有被藏起来的人说过这句」。而那条 Server Action
     * 只要求登录、没有限流，可以反复问。
     */
    const engine = strip(src("lib/radar/engine.ts"));
    const fn = engine.slice(engine.indexOf("export function estimateHits7d"));
    assert.match(fn, /sender_wx_id NOT IN/);
  });

  it("拼 SQL 时对 sender_wx_id 为空的消息要放行 —— NOT IN 遇到 NULL 会把整行判掉", () => {
    const engine = strip(src("lib/radar/engine.ts"));
    assert.match(engine, /sender_wx_id IS NULL OR sender_wx_id NOT IN/);
  });
});

describe("**故意不过滤的地方，理由要写下来**", () => {
  /*
   * 这个项目的规矩：凡是故意跳过隐私过滤的路径，都要有
   * （a）代码旁的理由注释、（b）一条锁住那段注释的测试。
   *
   * 这条规矩不是形式主义 —— 一次对抗性审计正是靠它区分出
   * 「按天回看是有意的」和「关键词雷达是漏的」。
   * 没有留痕的跳过，下一轮审计只能当成遗漏再报一次，
   * 而每一次重新纠结都要花掉一个人半天。
   */
  it("按天回看：理由在", () => {
    assert.match(src("lib/forum/convert-source.ts"), /按天翻那条路[\s\S]{0,200}不加/);
  });

  it("资源库：理由在，而且划出了边界", () => {
    const body = src("lib/links/queries.ts");
    assert.match(body, /不过[\s\S]{0,60}开关/);
    // 边界要写明：能按发言人筛、或能搜到正文，它就变成搜索了
    assert.match(body, /发言人|正文/);
  });

  it("**资源库确实还没有变成消息搜索**", () => {
    /*
     * 上面那条注释只有在这一条也成立时才算数。
     * 哪天有人给它加了按发言人筛选，这条会红。
     */
    const body = strip(src("lib/links/queries.ts"));
    assert.equal(body.includes("messages_fts"), false, "资源库开始搜消息正文了");
    assert.equal(/sharerWxId.*needle|needle.*sharerWxId/.test(body), false, "资源库能按分享者搜了");
  });
});
