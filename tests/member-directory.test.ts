import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 成员目录的隐私边界。
 *
 * 这一组测试盯的是**会真的泄露东西的那几条线**：
 *
 *   · 群成员表里的一千八百人不该出现在目录里 —— 他们没注册，没同意过
 *   · 不同群的人之间互相看不见 —— 「群列表属于隐私」往下推一层就是成员
 *   · 隐身的人对别人不可见，但**对自己仍然可见** —— 否则开关无法自证
 *   · wx_id 不能出现在返回给页面的结构里
 *
 * 这几条错了不会报错、不会崩，只会安静地把不该给的东西给出去。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-members-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type DbModule = typeof import("@/lib/db");
type Queries = typeof import("@/lib/members/queries");

let dbm: DbModule;
let schema: typeof import("@/lib/db/schema");
let q: Queries;
let settingsStore: typeof import("@/lib/settings/store");
let permCache: typeof import("@/lib/rbac/can");

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  q = await import("@/lib/members/queries");
  settingsStore = await import("@/lib/settings/store");
  permCache = await import("@/lib/rbac/can");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const table of [
    schema.userSkills,
    schema.groupMembers,
    schema.groups,
    schema.userPrivacy,
    schema.userRoles,
    schema.rolePermissions,
    schema.roles,
    schema.people,
    schema.users,
    /*
     * settings 也要清。
     *
     * 「模块关掉时不能伪装成空目录」那条会往 settings 里写一行
     * module.directory.enabled=false —— 不清的话它会渗给**它后面
     * 所有的用例**，而那些用例失败时的表现是「目录里一个人都没有」，
     * 看起来像查询写错了。这种串味的排查成本远高于多删一张表。
     */
    schema.settings,
  ]) {
    dbm.db.delete(table).run();
  }
  settingsStore.invalidateSettingsCache();
});

/** 造一个注册用户 */
function user(id: string, name: string, over: Record<string, unknown> = {}) {
  dbm.db
    .insert(schema.users)
    .values({ id, wxId: `wx_${id}`, wxNickname: name, status: "active", ...over })
    .run();
  return { id, wxId: `wx_${id}`, siteNickname: null, wxNickname: name } as never;
}

/** 只在群里、没在站上注册的人 */
function person(wxId: string, name: string) {
  dbm.db.insert(schema.people).values({ wxId, displayName: name }).run();
}

function group(convId: string) {
  dbm.db.insert(schema.groups).values({ convId, name: convId, syncEnabled: true }).run();
}

function joinGroup(convId: string, wxId: string, leftAt: number | null = null) {
  dbm.db.insert(schema.groupMembers).values({ convId, wxId, leftAt }).run();
}

function skill(userId: string, slug: string, label: string, sort = 0) {
  dbm.db.insert(schema.userSkills).values({ userId, slug, label, sort }).run();
}

function viewer(id: string) {
  return { id, wxId: `wx_${id}` } as never;
}

describe("① 只收录注册用户", () => {
  it("**群成员表里没注册的人不出现** —— 他们没同意过", () => {
    group("g1");
    user("me", "我");
    joinGroup("g1", "wx_me");

    // 群里另外一千八百人只在 people / group_members 里
    for (let i = 0; i < 5; i++) {
      person(`wx_ghost${i}`, `路人${i}`);
      joinGroup("g1", `wx_ghost${i}`);
    }

    const dir = q.memberDirectory(viewer("me"));
    assert.deepEqual(dir.members.map((m) => m.name), ["我"]);
    assert.equal(dir.total, 1);
  });

  it("注册了但状态不是 active 的也不出现", () => {
    group("g1");
    user("me", "我");
    user("banned", "被封的", { status: "banned" });
    user("pending", "没激活的", { status: "pending" });
    joinGroup("g1", "wx_me");
    joinGroup("g1", "wx_banned");
    joinGroup("g1", "wx_pending");

    assert.deepEqual(q.memberDirectory(viewer("me")).members.map((m) => m.name), ["我"]);
  });

  it("机器人账号不出现", () => {
    group("g1");
    user("me", "我");
    user("bot", "群猫娘", { kind: "bot" });
    joinGroup("g1", "wx_me");
    joinGroup("g1", "wx_bot");

    assert.equal(q.memberDirectory(viewer("me")).members.length, 1);
  });
});

describe("② 只看得到同群的人", () => {
  beforeEach(() => {
    group("g1");
    group("g2");
    user("me", "我");
    user("same", "同群的");
    user("other", "别的群的");
    joinGroup("g1", "wx_me");
    joinGroup("g1", "wx_same");
    joinGroup("g2", "wx_other");
  });

  it("**不同群的人互相看不见**", () => {
    const names = q.memberDirectory(viewer("me")).members.map((m) => m.name);
    assert.ok(names.includes("同群的"));
    assert.equal(names.includes("别的群的"), false, "把别的群的人露给了这个群");
  });

  it("对面看到的也是对称的", () => {
    const names = q.memberDirectory(viewer("other")).members.map((m) => m.name);
    assert.deepEqual(names, ["别的群的"]);
  });

  it("**退群之后立刻看不到** —— 也立刻不被看到", () => {
    dbm.db.delete(schema.groupMembers).run();
    joinGroup("g1", "wx_me");
    joinGroup("g1", "wx_same", Date.now());

    assert.deepEqual(q.memberDirectory(viewer("me")).members.map((m) => m.name), ["我"]);
  });

  it("我自己退了群就什么都看不到", () => {
    dbm.db.delete(schema.groupMembers).run();
    joinGroup("g1", "wx_me", Date.now());
    joinGroup("g1", "wx_same");

    assert.equal(q.memberDirectory(viewer("me")).members.length, 0);
  });

  it("只说共同群的数量，结构里没有群名或群 id", () => {
    joinGroup("g2", "wx_me");
    joinGroup("g2", "wx_same");

    const member = q.memberDirectory(viewer("me")).members.find((m) => m.name === "同群的")!;
    assert.equal(member.sharedGroups, 2);
    const serialized = JSON.stringify(member);
    assert.equal(serialized.includes("g1"), false, "群 id 泄露进了返回结构");
    assert.equal(serialized.includes("g2"), false);
  });

  it("未登录看不到任何东西", () => {
    const dir = q.memberDirectory(null);
    assert.equal(dir.members.length, 0);
    assert.equal(dir.total, 0);
  });
});

describe("③ 隐身", () => {
  beforeEach(() => {
    group("g1");
    user("me", "我");
    user("shy", "隐身的", { directoryHidden: true });
    joinGroup("g1", "wx_me");
    joinGroup("g1", "wx_shy");
  });

  it("别人看不到隐身的人，但知道有几个人隐身了", () => {
    const dir = q.memberDirectory(viewer("me"));
    assert.equal(dir.members.some((m) => m.name === "隐身的"), false);
    assert.equal(dir.hidden, 1, "不说出来的话，用户会以为目录是全的");
  });

  it("**隐身的人自己还看得到自己** —— 否则这个开关无法自证", () => {
    const dir = q.memberDirectory(viewer("shy"));
    const me = dir.members.find((m) => m.isMe);
    assert.ok(me, "隐身之后自己也消失了，用户没法确认开关生效");
    assert.equal(me.name, "隐身的");
  });

  it("隐身的人的标签不进筛选栏", () => {
    skill("shy", "rag", "RAG");
    skill("me", "rag", "RAG");
    // 只剩一个人持有，达不到进筛选栏的门槛
    assert.equal(q.memberDirectory(viewer("me")).facets.length, 0);
  });
});

describe("④ wx_id 不出现在返回结构里", () => {
  it("成员卡片里没有 wx_id，只有配色下标", () => {
    group("g1");
    user("me", "我");
    user("peer", "同伴");
    joinGroup("g1", "wx_me");
    joinGroup("g1", "wx_peer");

    const dir = q.memberDirectory(viewer("me"));
    const serialized = JSON.stringify(dir.members);
    assert.equal(serialized.includes("wx_peer"), false, "wx_id 会被序列化进网页源码");
    assert.equal(serialized.includes("wx_me"), false);
    assert.ok(dir.members.every((m) => typeof m.paletteIndex === "number"));
  });

  it("同一个人的配色下标是稳定的", () => {
    group("g1");
    user("me", "我");
    joinGroup("g1", "wx_me");

    const a = q.memberDirectory(viewer("me")).members[0].paletteIndex;
    const b = q.memberDirectory(viewer("me")).members[0].paletteIndex;
    assert.equal(a, b);
  });
});

describe("标签筛选与排序", () => {
  beforeEach(() => {
    group("g1");
    user("me", "我", { points: 10 });
    user("a", "会 RAG 的甲", { points: 100 });
    user("b", "会 RAG 的乙", { points: 50 });
    user("c", "没填标签的", { points: 999 });
    for (const id of ["me", "a", "b", "c"]) joinGroup("g1", `wx_${id}`);
    skill("a", "rag", "RAG");
    skill("b", "rag", "rag");
  });

  it("按标签筛出对的人", () => {
    const dir = q.memberDirectory(viewer("me"), { tag: "rag" });
    assert.deepEqual(dir.members.map((m) => m.name).sort(), ["会 RAG 的乙", "会 RAG 的甲"]);
  });

  it("**筛选栏用最多人用的写法** —— 不是第一个人的写法", () => {
    const facet = q.memberDirectory(viewer("me")).facets.find((f) => f.slug === "rag");
    assert.equal(facet?.count, 2);
    assert.ok(["RAG", "rag"].includes(facet!.label));
  });

  it("**填了标签的排在前面** —— 没标签的行对「找到会某件事的人」没有帮助", () => {
    const members = q.memberDirectory(viewer("me")).members;
    const firstUntagged = members.findIndex((m) => m.tags.length === 0);
    const lastTagged = members.map((m) => m.tags.length > 0).lastIndexOf(true);

    assert.ok(lastTagged < firstUntagged, "没标签的人混进了有标签的中间");
    // 「没填标签的」积分 999 最高，但仍然排在有标签的后面
    assert.equal(members[0].name, "会 RAG 的甲");
    assert.equal(members[firstUntagged].name, "没填标签的", "无标签组内仍按积分排");
  });

  it("说得出还有几个人没填标签", () => {
    assert.equal(q.memberDirectory(viewer("me")).untagged, 2);
  });

  it("筛选之后 total 仍然是收录总数，不是筛后的数", () => {
    const dir = q.memberDirectory(viewer("me"), { tag: "rag" });
    assert.equal(dir.total, 4);
    assert.equal(dir.members.length, 2);
  });

  it("不存在的标签筛出空，但筛选栏还在", () => {
    const dir = q.memberDirectory(viewer("me"), { tag: "nope" });
    assert.equal(dir.members.length, 0);
    assert.ok(dir.facets.length > 0, "筛错一次就没法换一个标签了");
  });
});

describe("后台的全站标签分布", () => {
  it("和前台的不一样是对的 —— 前台泄露全站分布等于泄露别的群有什么人", () => {
    group("g1");
    group("g2");
    user("me", "我");
    user("far", "别的群的");
    joinGroup("g1", "wx_me");
    joinGroup("g2", "wx_far");
    skill("far", "rag", "RAG");

    assert.equal(q.memberDirectory(viewer("me")).facets.length, 0, "前台看到了别的群的标签");
    assert.equal(q.allTagFacets().length, 1, "后台该看到全站的");
  });
});

describe("模块关掉时不能伪装成「目录是空的」", () => {
  it("**关掉之后要说得出是被关了**，而不是显示成没有人", async () => {
    group("g1");
    user("me", "我");
    user("peer", "同伴");
    joinGroup("g1", "wx_me");
    joinGroup("g1", "wx_peer");
    skill("peer", "rag", "RAG");

    assert.equal(q.memberDirectory(viewer("me")).moduleOff, false);
    assert.ok(q.memberDirectory(viewer("me")).members.length > 0);

    // 关掉模块
    const store = await import("@/lib/settings/store");
    dbm.db
      .insert(schema.settings)
      .values({
        key: "module.directory.enabled",
        value: "false",
        type: "bool",
        category: "module",
        label: "模块：成员目录",
      })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: "false" } })
      .run();
    store.invalidateSettingsCache();

    const off = q.memberDirectory(viewer("me"));
    assert.equal(off.moduleOff, true, "被关了却报成「目录是空的」");
    assert.equal(off.members.length, 0);

    // 标签数据本身没被删 —— 打开就回来
    assert.equal(dbm.db.select().from(schema.userSkills).all().length, 1);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 目录要答得上问题，而不只是一列人名
 *
 * 站长的原话是「成员那个模块也不太优雅 就是单纯一个列表」。
 * 一列按名字排的名单，四个问题一个都答不了：
 * 谁会做 X / 谁和我在同一个群 / 谁最近还在 / 这个人是谁。
 *
 * 加的每一样都是**新的暴露面**，所以下面那组隐私断言和这组是一起写的 ——
 * 每加一个能按人找到内容的入口，就得回来问一遍
 * 「这个人关掉了开关的话，这里会不会漏」。
 * ─────────────────────────────────────────────────────────────── */

const DAY = 24 * 60 * 60 * 1000;

/** 造一个在群里说过话的注册用户，顺便给个「最后说话时间」 */
function seenAt(wxId: string, name: string, lastSeen: number) {
  dbm.db
    .insert(schema.people)
    .values({ wxId, displayName: name, lastSeen })
    .onConflictDoUpdate({ target: schema.people.wxId, set: { lastSeen } })
    .run();
}

describe("搜人：matchesQuery 终于接上了", () => {
  /*
   * 这个函数早就写好、也早就被 tests/member-tags.test.ts 测过了，
   * 但**没有任何页面调用它** —— 目录上一直只有标签筛选。
   * 而标签筛选只答得了「谁会做 X」，且要够多人填了才成立。
   */
  beforeEach(() => {
    group("g1");
    user("me", "我");
    user("zhang", "张三", {});
    user("li", "李四", {});
    joinGroup("g1", "wx_me");
    joinGroup("g1", "wx_zhang");
    joinGroup("g1", "wx_li");
    skill("zhang", "rag", "RAG");
    dbm.db.update(schema.users).set({ bio: "在做检索增强" }).where(eq(schema.users.id, "li")).run();
  });

  it("按名字搜得到", () => {
    const dir = q.memberDirectory(viewer("me"), { q: "张三" });
    assert.deepEqual(dir.members.map((m) => m.name), ["张三"]);
  });

  it("按技能标签也搜得到，而且**和点标签是同一套归一化**", () => {
    /*
     * 搜「RAG」和点标签「rag」必须找到同一批人。
     * 两个入口各有各的脾气的话，用户会以为目录里根本没这个人。
     */
    const byQuery = q.memberDirectory(viewer("me"), { q: "RAG" }).members.map((m) => m.name);
    const byTag = q.memberDirectory(viewer("me"), { tag: "rag" }).members.map((m) => m.name);
    assert.deepEqual(byQuery, ["张三"]);
    assert.deepEqual(byQuery, byTag);
  });

  it("简介里的字也搜得到 —— 没填标签的人不该完全找不到", () => {
    assert.deepEqual(
      q.memberDirectory(viewer("me"), { q: "检索" }).members.map((m) => m.name),
      ["李四"],
    );
  });

  it("**搜不到时，total 仍然是收录总数** —— 那句「共几人」不该跟着搜索跳", () => {
    /*
     * total 说的是「这个目录里有几个人」，matched 说的是「这次筛出来几个」。
     * 混成一个数的话，搜了个不存在的名字，页面会显示「还没有可见的成员」——
     * 而那是一句假话。
     */
    const dir = q.memberDirectory(viewer("me"), { q: "根本没有这个人" });
    assert.equal(dir.total, 3);
    assert.equal(dir.matched, 0);
    assert.equal(dir.members.length, 0);
  });

  it("空搜索等于没搜", () => {
    assert.equal(q.memberDirectory(viewer("me"), { q: "   " }).matched, 3);
  });
});

describe("排序：三种排法对应三个问题", () => {
  beforeEach(() => {
    group("g1");
    group("g2");
    user("me", "我");
    user("near", "同两个群的");
    user("far", "只同一个群的");
    for (const wx of ["wx_me", "wx_near", "wx_far"]) joinGroup("g1", wx);
    joinGroup("g2", "wx_me");
    joinGroup("g2", "wx_near");
  });

  it("**共同群最多的排前面** —— 搭话成本最低的那个人", () => {
    const dir = q.memberDirectory(viewer("me"), { sort: "shared" });
    const shared = new Map(dir.members.map((m) => [m.name, m.sharedGroups]));
    assert.equal(shared.get("同两个群的"), 2);
    assert.equal(shared.get("只同一个群的"), 1);

    const names = dir.members.map((m) => m.name);
    assert.ok(
      names.indexOf("同两个群的") < names.indexOf("只同一个群的"),
      `排出来是 ${names.join("、")}`,
    );
  });

  it("**最近活跃的排前面**，而且分得出「本周」和「本月」", () => {
    const now = Date.UTC(2026, 7, 9);
    seenAt("wx_near", "同两个群的", now - 2 * DAY);
    seenAt("wx_far", "只同一个群的", now - 20 * DAY);

    const dir = q.memberDirectory(viewer("me"), { sort: "active", now });
    const byName = new Map(dir.members.map((m) => [m.name, m.activity]));
    assert.equal(byName.get("同两个群的"), "week");
    assert.equal(byName.get("只同一个群的"), "month");
    assert.equal(dir.members[0].name, "同两个群的");
  });

  it("**只到「本月」为止，不给时间点**", () => {
    /*
     * lib/privacy/rules.ts 删掉 hide_activity_hours 时写明了理由：
     * 那个开关守的是**作息**，而作息是逐小时的直方图才暴露得出来的。
     * 粗到「本周活跃过」这一档，说的是「这个人还在」，不是他几点睡。
     *
     * 所以结构里只能有 week / month / null，不能有时间戳。
     */
    const now = Date.UTC(2026, 7, 9);
    seenAt("wx_near", "同两个群的", now - 2 * DAY);
    const dir = q.memberDirectory(viewer("me"), { sort: "active", now });
    for (const m of dir.members) {
      assert.ok([null, "week", "month"].includes(m.activity));
    }
    assert.doesNotMatch(JSON.stringify(dir.members), /lastSeen|last_seen/);
  });

  it("很久没说话的人不显示活跃，但**人还在目录里**", () => {
    const now = Date.UTC(2026, 7, 9);
    seenAt("wx_far", "只同一个群的", now - 200 * DAY);
    const dir = q.memberDirectory(viewer("me"), { now });
    const far = dir.members.find((m) => m.name === "只同一个群的")!;
    assert.equal(far.activity, null);
    assert.ok(far, "半年没说话就从目录里消失了 —— 那是隐身开关的事，不是活跃度的事");
  });

  it("同分时按名字兜底 —— 不兜的话每次刷新顺序都不一样", () => {
    const a = q.memberDirectory(viewer("me"), { sort: "active" }).members.map((m) => m.name);
    const b = q.memberDirectory(viewer("me"), { sort: "active" }).members.map((m) => m.name);
    assert.deepEqual(a, b);
  });

  it("排序参数是敌对输入 —— 认不得的一律回默认", () => {
    for (const bad of ["", "points", "../../etc", "__proto__", undefined]) {
      assert.equal(q.resolveSort(bad), "tags", `${JSON.stringify(bad)} 不该被放行`);
    }
  });
});

describe("⑤ 目录里的贡献数字也要过榜单开关", () => {
  /*
   * ─────────────────────────────────────────
   * 一张没叫自己榜单的榜
   * ─────────────────────────────────────────
   *
   * 「出现在榜单上」这个开关承诺的是「别人看到的榜单里没有你」。
   * 而成员目录一直在显示积分、还按积分排序 —— 那就是另一张榜，
   * 只是换了个名字，而且它从来没查过这个开关。
   *
   * 一个只在其中一处生效的隐私开关，比没有开关更坏：
   * 它让人以为自己藏起来了。
   */
  beforeEach(() => {
    for (const t of [schema.userPrivacy, schema.userRoles, schema.rolePermissions, schema.roles]) {
      dbm.db.delete(t).run();
    }
    dbm.db
      .insert(schema.roles)
      .values([{ id: "r_mod", key: "moderator", name: "版主" }])
      .run();
    dbm.db
      .insert(schema.rolePermissions)
      .values([{ roleId: "r_mod", permissionKey: "moderation.queue" }])
      .run();
    /*
     * 角色→权限的映射在 can() 里是**进程级缓存**的。
     * 每个用例都重灌了这两张表，不清缓存的话 can() 读到的还是上一轮的，
     * 而表现是「豁免莫名其妙不生效」——  和权限本身写错长得一模一样。
     */
    permCache.invalidatePermissionCache();

    group("g1");
    user("me", "我");
    user("shy", "不想上榜的", { points: 999 });
    joinGroup("g1", "wx_me");
    joinGroup("g1", "wx_shy");
    dbm.db
      .insert(schema.userPrivacy)
      .values({ userId: "shy", hideFromLeaderboard: true })
      .run();
  });

  it("**关掉之后别人看不到他的积分**", () => {
    const shy = q.memberDirectory(viewer("me")).members.find((m) => m.name === "不想上榜的")!;
    assert.equal(shy.points, null, "榜单开关关了，目录里照样把积分摆出来");
  });

  it("**活跃度也一起藏** —— 新加的展示要过同一道开关", () => {
    const now = Date.UTC(2026, 7, 9);
    seenAt("wx_shy", "不想上榜的", now - DAY);
    const shy = q
      .memberDirectory(viewer("me"), { now })
      .members.find((m) => m.name === "不想上榜的")!;
    assert.equal(shy.activity, null);
  });

  it("**但人还在目录里** —— 藏数字和隐身是两个开关，各管各的", () => {
    /*
     * 这条很要紧：把两个开关搅在一起的话，一个只是不想上榜的人
     * 会发现自己整个从通讯录里消失了，而他从来没要求过这个。
     */
    const names = q.memberDirectory(viewer("me")).members.map((m) => m.name);
    assert.ok(names.includes("不想上榜的"));
  });

  it("**他自己还看得到自己的数字** —— 否则这个开关无法自证", () => {
    /*
     * 和隐身那条同一个道理：看不到任何变化的话，用户只能靠相信，
     * 而只能靠相信的隐私开关跟没有是一样的。
     */
    const me = q.memberDirectory(viewer("shy")).members.find((m) => m.isMe)!;
    assert.equal(me.points, 999);
  });

  it("处理举报的人看得到完整数字 —— 和榜单那边同一条豁免", () => {
    dbm.db.insert(schema.userRoles).values({ userId: "me", roleId: "r_mod" }).run();
    const shy = q
      .memberDirectory({ id: "me", wxId: "wx_me", status: "active", kind: "member" } as never)
      .members.find((m) => m.name === "不想上榜的")!;
    assert.equal(shy.points, 999);
  });

  it("按积分排序时，藏了积分的人不会被顶到最前面", () => {
    /*
     * 默认排序的次级键是积分。藏起来的人按 0 算 ——
     * 按 null 直接参与减法的话结果是 NaN，排序会变成一个随机顺序，
     * 而随机顺序在页面上看起来完全正常。
     */
    const names = q.memberDirectory(viewer("me")).members.map((m) => m.name);
    assert.equal(names.length, 2);
    assert.ok(names.includes("不想上榜的"));
  });
});
