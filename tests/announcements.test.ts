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
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

const NOW = 1_786_000_000_000;

describe("**定向：轮不到的人看不到**", () => {
  it("没指定身份组 = 全体", () => {
    assert.equal(targeted({ targetRoleId: null }, []), true);
  });

  it("指定了就只给持有那个身份组的人", () => {
    assert.equal(targeted({ targetRoleId: "r_mod" }, ["r_mod", "r_member"]), true);
    assert.equal(targeted({ targetRoleId: "r_mod" }, ["r_member"]), false);
  });

  it("**一个身份组都没有的人，收不到任何定向公告**", () => {
    // 「版主请注意」发给所有人，只会让所有人下次都跳过公告
    assert.equal(targeted({ targetRoleId: "r_mod" }, []), false);
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
  dbm.db.insert(schema.roles).values({ id: "r_mod", key: "moderator", name: "版主" }).run();
  for (const id of ["u_a", "u_b"]) {
    dbm.db.insert(schema.users).values({ id, wxId: `wx_${id}`, status: "active" }).run();
  }
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
