import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  DISPLAYS,
  MAX_CONCURRENT_BANNERS,
  describeAudience,
  displayLabel,
  isLive,
  pickVisible,
  targeted,
} from "@/lib/broadcast/announce-rules";
import { stripComments as strip } from "./_source";

/**
 * 站内公告。
 *
 * ─────────────────────────────────────────
 * 发出去的公告没有任何人看得到
 * ─────────────────────────────────────────
 *
 * 后台可以写、提交、复核、发布，界面回一句「站内公告已发布。」，
 * 库里那行的 `sent_count` 记成 1 —— 而 `activeAnnouncements()`
 * 这个查询**零调用点**，`display` 和 `target_role_id` 同样没人读。
 *
 * 缺最后一步的结果不是「功能不全」，是**管理员以为自己通知过大家了**。
 * 真出事要广播的时候，他会以为消息已经送到了。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

const NOW = 1_786_000_000_000;

const ann = (over: Partial<{ targetRoleId: string | null; targetConvIds: string[] | null }> = {}) => ({
  targetRoleId: null,
  targetConvIds: null,
  ...over,
});

describe("**定向：轮不到的人看不到**", () => {
  it("没指定身份组 = 全体", () => {
    assert.equal(targeted(ann(), []), true);
  });

  it("指定了就只给持有那个身份组的人", () => {
    assert.equal(targeted(ann({ targetRoleId: "r_mod" }), ["r_mod", "r_member"]), true);
    assert.equal(targeted(ann({ targetRoleId: "r_mod" }), ["r_member"]), false);
  });

  it("**一个身份组都没有的人，收不到任何定向公告**", () => {
    // 「版主请注意」发给所有人，只会让所有人下次都跳过公告
    assert.equal(targeted(ann({ targetRoleId: "r_mod" }), []), false);
  });
});

describe("**定向到群**", () => {
  /*
   * 「A 群周六线下」发给全站，对另外十一个群的人来说是纯噪音 ——
   * 而且**顺带告诉了他们 A 群的存在和活动安排**，
   * 而群的事情属于群里的人。
   */
  it("没指定群 = 不限", () => {
    assert.equal(targeted(ann(), [], []), true);
    assert.equal(targeted(ann({ targetConvIds: [] }), [], []), true, "空数组也是不限");
  });

  it("指定了就只给这些群里的人", () => {
    assert.equal(targeted(ann({ targetConvIds: ["g_a"] }), [], ["g_a", "g_b"]), true);
    assert.equal(targeted(ann({ targetConvIds: ["g_a"] }), [], ["g_b"]), false);
  });

  it("**一个群都不在的人收不到**", () => {
    assert.equal(targeted(ann({ targetConvIds: ["g_a"] }), [], []), false);
  });

  it("多个群里只要中一个就算", () => {
    assert.equal(targeted(ann({ targetConvIds: ["g_a", "g_b"] }), [], ["g_b"]), true);
  });
});

describe("**两个条件同时填 = 取交集，不是并集**", () => {
  /*
   * 并集听起来「覆盖更广」，但它的失败方向是**发多了** ——
   * 而这两个维度存在的理由恰恰是发少一点、发准一点。
   * 一个用来收窄范围的东西，默认行为不该是放宽。
   *
   * 而且交集讲得清楚：「A 群里的版主」。并集要说成
   * 「A 群里的所有人，加上全站所有版主」—— 没人是这么想事情的。
   */
  const both = ann({ targetRoleId: "r_mod", targetConvIds: ["g_a"] });

  it("两个都满足才看得到", () => {
    assert.equal(targeted(both, ["r_mod"], ["g_a"]), true);
  });

  it("**只满足身份组不够**", () => {
    assert.equal(targeted(both, ["r_mod"], ["g_b"]), false);
  });

  it("**只满足群也不够**", () => {
    assert.equal(targeted(both, ["r_member"], ["g_a"]), false);
  });

  it("两个都不满足当然看不到", () => {
    assert.equal(targeted(both, [], []), false);
  });
});

describe("「发给谁」那句话", () => {
  /*
   * 后台要显示它 —— 一条定向公告发出去之后，如果界面上只写「已发布」，
   * 管理员没有任何办法确认自己有没有选错，
   * 而选错的表现是「大家都说没收到」。
   */
  it("全站", () => {
    assert.match(describeAudience(null, 117), /全体登录用户，117 个人/);
  });

  it("只限身份组", () => {
    assert.match(describeAudience("版主", 5), /「版主」这个身份组，5 个人/);
  });

  it("只限群 —— 读起来是「某某群里的所有人」", () => {
    assert.match(describeAudience(null, 30, ["A 群"]), /A 群里的所有人，30 个人/);
  });

  it("**两个都有时要读得像交集**", () => {
    // 拼成「发给『版主』和 A 群」会被理解成并集，而实际是交集
    assert.match(describeAudience("版主", 2, ["A 群"]), /A 群里的「版主」这个身份组/);
  });

  it("群多了就不一个个念", () => {
    const s = describeAudience(null, 80, ["A", "B", "C", "D"]);
    assert.match(s, /等 4 个群里的/);
    assert.equal(s.includes("C"), false, "四个群还全念出来，那一行会撑爆");
  });
});

describe("过期", () => {
  it("没设期限的不过期", () => {
    assert.equal(isLive({ expiresAt: null }, NOW), true);
  });

  it("到点就不再出现", () => {
    assert.equal(isLive({ expiresAt: NOW + 1 }, NOW), true);
    assert.equal(isLive({ expiresAt: NOW }, NOW), false);
    assert.equal(isLive({ expiresAt: NOW - 1 }, NOW), false);
  });
});

describe("**同时最多摆几条**", () => {
  const make = (n: number, display: string) =>
    Array.from({ length: n }, (_, i) => ({ id: `a${i}`, display, createdAt: NOW - i }));

  it("横幅有上限 —— 三条叠在页面顶上等于把首屏让给公告", () => {
    // 而人只会把它们一起关掉
    assert.equal(pickVisible(make(5, "banner")).banners.length, MAX_CONCURRENT_BANNERS);
  });

  it("**打断式的只留一条**", () => {
    /*
     * 两个模态框叠着弹是任何界面里最糟的一种体验，
     * 而它恰恰只在「同时发了两条急事」那种最忙乱的时刻才会出现。
     */
    const picked = pickVisible(make(3, "modal"));
    assert.notEqual(picked.modal, null);
    assert.equal(picked.banners.length, 0, "打断式的不该同时又当横幅摆一遍");
  });

  it("新的排在前面", () => {
    const picked = pickVisible([
      { id: "old", display: "banner", createdAt: NOW - 1000 },
      { id: "new", display: "banner", createdAt: NOW },
    ]);
    assert.equal(picked.banners[0].id, "new");
  });

  it("**「只进通知」的不摆横幅** —— 它的意思就是不打扰", () => {
    assert.deepEqual(pickVisible(make(2, "inbox")).banners, []);
  });

  it("横幅和打断可以同时存在，各归各的", () => {
    const picked = pickVisible([
      { id: "m", display: "modal", createdAt: NOW },
      { id: "b", display: "banner", createdAt: NOW - 1 },
    ]);
    assert.equal(picked.modal?.id, "m");
    assert.deepEqual(picked.banners.map((b) => b.id), ["b"]);
  });
});

describe("后台要看得懂那三个选项", () => {
  it("三档都有中文名和一句「它意味着什么」", () => {
    assert.equal(DISPLAYS.length, 3);
    for (const d of DISPLAYS) {
      assert.ok(d.label.length > 0, d.key);
      assert.ok(d.detail.length > 10, `${d.key} 没说清楚它意味着什么`);
    }
  });

  it("**打断那一档要写明「用滥了就没人看」**", () => {
    // 这条限制是给发公告的人的，不是给读者的
    assert.match(DISPLAYS.find((d) => d.key === "modal")!.detail, /用滥|没人/);
  });

  it("认不出的展示形式不炸", () => {
    assert.equal(displayLabel(null), "未指定");
    assert.equal(displayLabel("nope"), "未指定");
  });

  it("「发给谁」那句话把身份组和人数都说出来", () => {
    assert.match(describeAudience("版主", 3), /版主/);
    assert.match(describeAudience("版主", 3), /3/);
    assert.match(describeAudience(null, 102), /全体/);
  });
});

describe("接线", () => {
  it("**外壳上真的挂了** —— 这一整块的病根就是没人读那个查询", () => {
    assert.match(strip(src("components/shell/AppShell.tsx")), /announcementsFor\(/);
  });

  it("规则层是纯的", () => {
    const rules = src("lib/broadcast/announce-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(rules.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });

  it("**关掉的状态存服务端，不存 localStorage**", () => {
    /*
     * 存本地的话换个设备、清一次缓存，关掉的公告全都回来了。
     * 这个项目刚修过一个同类的 bug（通知重复弹出），
     * 根因正是「已读」有两份、而其中一份活不过刷新。
     */
    const cmp = strip(src("components/shell/Announcements.tsx"));
    assert.equal(cmp.includes("localStorage"), false);
    assert.match(strip(src("lib/broadcast/announce-actions.ts")), /dismissAnnouncement\(/);
  });

  it("关掉用的是真身 —— 预览态下会记到别人头上", () => {
    assert.match(strip(src("lib/broadcast/announce-actions.ts")), /getRealUser\(\)/);
  });

  it("**未登录访客不看公告**", () => {
    // 他没有身份也就没有「已读」，那条横幅每次刷新都回来而他关不掉
    assert.match(strip(src("lib/broadcast/announce.ts")), /if \(!user\) return empty;/);
  });

  it("正文走和帖子同一条消毒管线", () => {
    // 另写一套的话，站外图片降级那些规则要重新踩一遍
    assert.match(strip(src("components/shell/AppShell.tsx")), /renderMarkdown\(/);
  });

  it("后台能选定向，而且这个值真的存进去了", () => {
    assert.match(strip(src("components/admin/BroadcastComposer.tsx")), /targetRoleId:/);
    assert.match(strip(src("lib/broadcast/actions.ts")), /targetRoleId: input\.targetRoleId/);
  });

  it("**后台不拿「已送达 1」当人数** —— 那个 1 是「发布成功」", () => {
    const page = strip(src("app/(app)/admin/broadcast/page.tsx"));
    // 站内公告那一行说的是「发给谁」和「多少人看过」
    assert.match(page, /describeAudience\(/);
    assert.match(page, /dismissedCount\(/);
  });

  it("拖到最后：announce.ts 里不许再有零调用点的函数", () => {
    /*
     * 这一整块的病根就是「写了没人调」。
     * 每个导出都要在别处出现过 —— 否则下一轮又是一个死开关。
     */
    const body = src("lib/broadcast/announce.ts");
    const exported = [...body.matchAll(/export function (\w+)/g)].map((m) => m[1]);
    assert.ok(exported.length > 0);

    const elsewhere = [
      src("components/shell/AppShell.tsx"),
      src("lib/broadcast/announce-actions.ts"),
      src("app/(app)/admin/broadcast/page.tsx"),
    ].join("\n");

    for (const name of exported) {
      assert.match(elsewhere, new RegExp(`\\b${name}\\b`), `${name} 没有任何调用点`);
    }
  });
});

/* ───────────────────────────────────────────────────────────────
 * 真数据库
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-announce-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let mod: typeof import("@/lib/broadcast/announce");

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  mod = await import("@/lib/broadcast/announce");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const user = (id: string) =>
  ({ id, wxId: `wx_${id}`, status: "active", kind: "member" }) as unknown as Parameters<
    typeof mod.announcementsFor
  >[0];

const post = (over: {
  id: string;
  display?: string;
  targetRoleId?: string | null;
  targetConvIds?: string[] | null;
  expiresAt?: number | null;
  status?: string;
  createdAt?: number;
}) =>
  dbm.db
    .insert(schema.broadcasts)
    .values({
      id: over.id,
      channel: "site",
      content: `公告 ${over.id}`,
      display: (over.display ?? "banner") as "banner",
      targetRoleId: over.targetRoleId ?? null,
      targetConvIds: over.targetConvIds ?? null,
      expiresAt: over.expiresAt ?? null,
      status: (over.status ?? "sent") as "sent",
      createdAt: over.createdAt ?? NOW,
      createdBy: "u_admin",
    })
    .run();

beforeEach(() => {
  for (const t of [
    schema.announcementDismissals,
    schema.broadcasts,
    schema.userRoles,
    schema.roles,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }
  for (const t of [schema.groupMembers, schema.groups]) dbm.db.delete(t).run();
  dbm.db.insert(schema.roles).values({ id: "r_mod", key: "moderator", name: "版主" }).run();
  for (const id of ["u_a", "u_b"]) {
    dbm.db.insert(schema.users).values({ id, wxId: `wx_${id}`, status: "active" }).run();
  }
  // u_a 在 A 群，u_b 在 B 群
  for (const [conv, name] of [["g_a", "A 群"], ["g_b", "B 群"]]) {
    dbm.db.insert(schema.groups).values({ convId: conv, name, isGroup: true }).run();
  }
  dbm.db.insert(schema.groupMembers).values({ convId: "g_a", wxId: "wx_u_a" }).run();
  dbm.db.insert(schema.groupMembers).values({ convId: "g_b", wxId: "wx_u_b" }).run();
});

describe("真库", () => {
  it("发布之后看得到 —— 这一条就是整个功能", () => {
    post({ id: "b1" });
    assert.equal(mod.announcementsFor(user("u_a"), NOW).banners.length, 1);
  });

  it("**还没发布的看不到**", () => {
    post({ id: "b1", status: "draft" });
    post({ id: "b2", status: "approved" });
    assert.equal(mod.announcementsFor(user("u_a"), NOW).banners.length, 0);
  });

  it("过期的看不到", () => {
    post({ id: "b1", expiresAt: NOW - 1 });
    assert.equal(mod.announcementsFor(user("u_a"), NOW).banners.length, 0);
  });

  it("**关掉之后就不再出现，而且只对关的人**", () => {
    post({ id: "b1" });
    mod.dismissAnnouncement("u_a", "b1");
    assert.equal(mod.announcementsFor(user("u_a"), NOW).banners.length, 0);
    assert.equal(mod.announcementsFor(user("u_b"), NOW).banners.length, 1, "别人被连坐了");
  });

  it("重复关不会插两行", () => {
    post({ id: "b1" });
    mod.dismissAnnouncement("u_a", "b1");
    mod.dismissAnnouncement("u_a", "b1");
    assert.equal(mod.dismissedCount("b1"), 1);
  });

  it("**定向公告只给那个身份组** —— 真库这一条最容易写错", () => {
    post({ id: "b1", targetRoleId: "r_mod" });
    dbm.db.insert(schema.userRoles).values({ userId: "u_a", roleId: "r_mod" }).run();

    assert.equal(mod.announcementsFor(user("u_a"), NOW).banners.length, 1);
    assert.equal(mod.announcementsFor(user("u_b"), NOW).banners.length, 0);
  });

  it("撤销过的身份组不算数", () => {
    post({ id: "b1", targetRoleId: "r_mod" });
    dbm.db
      .insert(schema.userRoles)
      .values({ userId: "u_a", roleId: "r_mod", revokedAt: NOW - 1 })
      .run();
    assert.equal(mod.announcementsFor(user("u_a"), NOW).banners.length, 0);
  });

  it("未登录访客拿到空的", () => {
    post({ id: "b1" });
    assert.deepEqual(mod.announcementsFor(null, NOW), { modal: null, banners: [] });
  });

  it("发给谁：全体按活跃用户算，定向按身份组算", () => {
    dbm.db.insert(schema.userRoles).values({ userId: "u_a", roleId: "r_mod" }).run();
    assert.equal(mod.audienceSize(null), 2);
    assert.equal(mod.audienceSize("r_mod"), 1);
  });

  it("微信群发那一条不会混进站内公告", () => {
    dbm.db
      .insert(schema.broadcasts)
      .values({
        id: "w1",
        channel: "wechat",
        content: "群发",
        status: "sent",
        createdAt: NOW,
        createdBy: "u_admin",
      })
      .run();
    assert.equal(mod.announcementsFor(user("u_a"), NOW).banners.length, 0);
  });
});

describe("**真库：定向到群**", () => {
  it("只发给 A 群 —— B 群的人看不到", () => {
    post({ id: "b1", targetConvIds: ["g_a"] });
    assert.equal(mod.announcementsFor(user("u_a"), NOW).banners.length, 1);
    assert.equal(mod.announcementsFor(user("u_b"), NOW).banners.length, 0);
  });

  it("不限群时两个人都看得到", () => {
    post({ id: "b1" });
    assert.equal(mod.announcementsFor(user("u_a"), NOW).banners.length, 1);
    assert.equal(mod.announcementsFor(user("u_b"), NOW).banners.length, 1);
  });

  it("**退群的人不再收到那个群的公告**", () => {
    /*
     * 一条发给 A 群的公告出现在上个月退群的人面前，
     * 既是噪音，也是在告诉他那个群还在做什么。
     */
    post({ id: "b1", targetConvIds: ["g_a"] });
    dbm.db.update(schema.groupMembers).set({ leftAt: NOW - 1000 }).run();
    assert.equal(mod.announcementsFor(user("u_a"), NOW).banners.length, 0);
  });

  it("**身份组 + 群 = 交集**", () => {
    dbm.db.insert(schema.userRoles).values({ userId: "u_a", roleId: "r_mod" }).run();
    dbm.db.insert(schema.userRoles).values({ userId: "u_b", roleId: "r_mod" }).run();
    // u_a：在 A 群 + 是版主 → 看得到；u_b：是版主但不在 A 群 → 看不到
    post({ id: "b1", targetRoleId: "r_mod", targetConvIds: ["g_a"] });
    assert.equal(mod.announcementsFor(user("u_a"), NOW).banners.length, 1);
    assert.equal(mod.announcementsFor(user("u_b"), NOW).banners.length, 0);
  });
});

describe("**真库：受众人数不能算多**", () => {
  /*
   * 分开算再相加会得出一个比真实值大得多的数 ——
   * 而管理员看到「发给 117 个人」之后就不会再核对了。
   * 一个偏大的受众数比没有这个数更坏：它让人以为通知到位了。
   */
  it("全站 = 所有活跃用户", () => {
    assert.equal(mod.audienceSize(null), 2);
  });

  it("限群 = 群里的人", () => {
    assert.equal(mod.audienceSize(null, ["g_a"]), 1);
  });

  it("**限身份组 + 限群 = 交集，不是两边相加**", () => {
    dbm.db.insert(schema.userRoles).values({ userId: "u_a", roleId: "r_mod" }).run();
    dbm.db.insert(schema.userRoles).values({ userId: "u_b", roleId: "r_mod" }).run();
    // 版主 2 人、A 群 1 人；相加是 3，交集是 1
    assert.equal(mod.audienceSize("r_mod", ["g_a"]), 1);
  });

  it("退群的不算", () => {
    dbm.db.update(schema.groupMembers).set({ leftAt: NOW - 1000 }).run();
    assert.equal(mod.audienceSize(null, ["g_a"]), 0);
  });

  it("停用的账号不算", () => {
    dbm.db.update(schema.users).set({ status: "suspended" }).run();
    assert.equal(mod.audienceSize(null), 0);
  });
});

describe("**真库：可定向的群**", () => {
  it("列出来的是站里认得的群，带人数", () => {
    const list = mod.targetableGroups();
    assert.deepEqual(list.map((g) => g.convId).sort(), ["g_a", "g_b"]);
    assert.equal(list[0].members, 1);
  });

  it("**空群不出现在选项里** —— 选中它的结果是发给 0 个人", () => {
    dbm.db.delete(schema.groupMembers).run();
    assert.deepEqual(mod.targetableGroups(), []);
  });

  it("群名查得出来 —— 后台要把「发给谁」讲清楚", () => {
    assert.deepEqual(mod.groupNamesOf(["g_a"]), ["A 群"]);
    assert.deepEqual(mod.groupNamesOf(null), []);
  });
});

describe("**后台说的人数 = 真的看得到的人数**", () => {
  /*
   * 这是这个功能最坏的失败方式：受众数偏大。
   *
   * 管理员看到「发给 30 个人」之后就不会再核对了 ——
   * 而如果实际一个人都没看到，他会以为通知已经送到。
   * 那比没有这个数字糟得多。
   *
   * 两边曾经真的不一致过：`audienceSize` 按群成员算，
   * 而 `announcementsFor` 一开始用的是「消息可见的群」
   * （要求 sync_enabled）—— 一个没开同步的群，
   * 后台会说「发给 1 个人」而那个人什么也看不到。
   */
  const seenBy = (ids: string[], id: string) =>
    ids.filter((u) => mod.announcementsFor(user(u), NOW).banners.some((b) => b.id === id)).length;

  const ALL = ["u_a", "u_b"];

  it("全站", () => {
    post({ id: "b1" });
    assert.equal(seenBy(ALL, "b1"), mod.audienceSize(null));
  });

  it("限群", () => {
    post({ id: "b1", targetConvIds: ["g_a"] });
    assert.equal(seenBy(ALL, "b1"), mod.audienceSize(null, ["g_a"]));
  });

  it("限身份组", () => {
    dbm.db.insert(schema.userRoles).values({ userId: "u_a", roleId: "r_mod" }).run();
    post({ id: "b1", targetRoleId: "r_mod" });
    assert.equal(seenBy(ALL, "b1"), mod.audienceSize("r_mod"));
  });

  it("两个都限", () => {
    dbm.db.insert(schema.userRoles).values({ userId: "u_a", roleId: "r_mod" }).run();
    dbm.db.insert(schema.userRoles).values({ userId: "u_b", roleId: "r_mod" }).run();
    post({ id: "b1", targetRoleId: "r_mod", targetConvIds: ["g_a"] });
    assert.equal(seenBy(ALL, "b1"), mod.audienceSize("r_mod", ["g_a"]));
  });

  it("**没开同步的群也算** —— 同步开关管的是消息归档，不是群还存不存在", () => {
    dbm.db.update(schema.groups).set({ syncEnabled: false }).run();
    post({ id: "b1", targetConvIds: ["g_a"] });
    assert.equal(seenBy(ALL, "b1"), 1);
    assert.equal(mod.audienceSize(null, ["g_a"]), 1);
  });
});

describe("接线：定向到群", () => {
  it("站内公告分支真的能选群", () => {
    assert.match(strip(src("components/admin/BroadcastComposer.tsx")), /siteGroups\.map/);
  });

  it("**换渠道要清掉已选的群** —— 两个渠道的「选群」是两个意思", () => {
    const composer = strip(src("components/admin/BroadcastComposer.tsx"));
    assert.match(composer, /setTargets\(new Set\(\)\);[\s\S]{0,40}setChannel\(c\)/);
  });

  it("**两份群名单分开传** —— 发得进去的 ≠ 站里认得的", () => {
    const page = strip(src("app/(app)/admin/broadcast/page.tsx"));
    assert.match(page, /groups=\{sendable/);
    assert.match(page, /siteGroups=\{targetableGroups\(\)/);
  });

  it("**站内公告的群目标也校验** —— 以前只在微信那一支查", () => {
    /*
     * 只在微信那支查的时候，站内公告的 targetConvIds 完全没人校验：
     * 一个手写的请求可以塞进任意 id，存下来是一条谁也匹配不上的公告，
     * 而界面只会说「已发布」。
     */
    /*
     * 判「在不在某个分支里」看**缩进**，不是看它出现在哪两个字符串之间 ——
     * 按位置切的话，切出来的那一段会连带包含分支后面的代码，
     * 而那正是这条断言第一次误报的原因。
     *
     * 函数体顶层是两个空格；四个空格说明它在 `if` 里。
     */
    const line = strip(src("lib/broadcast/rules.ts"))
      .split("\n")
      .find((l) => l.includes("const unknown = input.targetConvIds.filter"));
    assert.ok(line, "找不到目标校验那一行");
    assert.match(line, /^ {2}const unknown/, "目标校验还锁在微信分支里");
  });

  it("两个渠道各用各的合法群集合", () => {
    assert.match(
      strip(src("lib/broadcast/actions.ts")),
      /input\.channel === "wechat"[\s\S]{0,120}sendableGroups\(\)[\s\S]{0,120}targetableGroups\(\)/,
    );
  });
});
