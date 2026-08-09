import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

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

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  q = await import("@/lib/members/queries");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const table of [
    schema.userSkills,
    schema.groupMembers,
    schema.groups,
    schema.people,
    schema.users,
  ]) {
    dbm.db.delete(table).run();
  }
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
