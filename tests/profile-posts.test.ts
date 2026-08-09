import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 成员主页上的「发过的帖」。
 *
 * ─────────────────────────────────────────
 * 这一段最容易漏的不是权限，是匿名
 * ─────────────────────────────────────────
 *
 * `listPosts` 的 `authorId` 这个筛选条件一直**零调用点** ——
 * 也就是说它的语义从来没被真正定过。
 *
 * 而一篇匿名帖出现在「这个人发过的帖」里，匿名当场作废。
 * 这一条比它听起来更容易漏：查询层已经把名字、头像、主页链接
 * 都抹干净了，所以那个列表**看起来是干净的** ——
 * 只是它出现在谁的主页上这件事本身就是答案。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("接线", () => {
  it("主页上真的列出来了", () => {
    assert.match(strip(src("app/(app)/members/[wxId]/page.tsx")), /listPosts\(/);
  });

  it("**复用 `listPosts`，不自己写一条**", () => {
    /*
     * 那个函数里已经有可见性收口和「按作者筛时排除匿名帖」两条。
     * 另写一份必然漏掉其中一条 —— 而漏哪一条都是泄露。
     */
    const page = strip(src("app/(app)/members/[wxId]/page.tsx"));
    assert.equal(page.includes("from(posts)"), false, "自己写查询了");
  });

  it("带上版块名 —— 这是跨版块的列表", () => {
    assert.match(strip(src("app/(app)/members/[wxId]/page.tsx")), /showBoard/);
  });

  it("**排除匿名这一条写在查询层，不是页面上**", () => {
    // 写在页面上的话，下一个用 authorId 筛的地方就会漏掉它
    const q = strip(src("lib/forum/queries.ts"));
    const block = q.slice(q.indexOf("if (options.authorId)"), q.indexOf("if (options.authorId)") + 500);
    assert.match(block, /eq\(posts\.anonymous, false\)/);
  });

  it("**这条规则没有「除了作者本人」的例外**", () => {
    /*
     * 例外听起来更周到，实际是这个仓库反复出错的形状：
     * 规则在一条路上成立、在另一条路上不成立。
     * 哪天这个列表被做成分享卡片、OG 图或者导出，
     * 那条例外就是泄露口。
     */
    const q = strip(src("lib/forum/queries.ts"));
    const block = q.slice(q.indexOf("if (options.authorId)"), q.indexOf("if (options.authorId)") + 500);
    assert.equal(/viewer\.userId/.test(block), false, "给作者本人开了例外");
  });
});

/* ───────────────────────────────────────────────────────────────
 * 真数据库
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-profile-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let q: typeof import("@/lib/forum/queries");

const BOARD = "b_1";
const AUTHOR = "u_author";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  q = await import("@/lib/forum/queries");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const viewer = (userId: string | null) =>
  ({ userId, roleIds: [], groupIds: [], canModerate: false }) as unknown as Parameters<
    typeof q.listPosts
  >[0];

const post = (id: string, over: Record<string, unknown> = {}) =>
  dbm.db
    .insert(schema.posts)
    .values({
      id,
      boardId: BOARD,
      authorId: AUTHOR,
      title: `帖子 ${id}`,
      content: "正文",
      contentHtml: "<p>正文</p>",
      status: "published",
      visibility: "public",
      shareCode: id,
      ...over,
    })
    .run();

beforeEach(() => {
  for (const t of [schema.posts, schema.boards]) dbm.db.delete(t).run();
  dbm.db.insert(schema.boards).values({ id: BOARD, key: "general", name: "综合", sort: 1 }).run();
});

describe("真库", () => {
  it("列得出他实名发的帖", () => {
    post("p1");
    const list = q.listPosts(viewer("u_other"), { authorId: AUTHOR });
    assert.deepEqual(list.map((p) => p.id), ["p1"]);
  });

  it("**匿名帖不出现在他的列表里**", () => {
    post("p1");
    post("p2", { anonymous: true });
    const list = q.listPosts(viewer("u_other"), { authorId: AUTHOR });
    assert.deepEqual(list.map((p) => p.id), ["p1"], "匿名帖漏进作者列表了");
  });

  it("**作者自己看也一样看不到** —— 这条规则没有例外", () => {
    post("p1", { anonymous: true });
    assert.deepEqual(q.listPosts(viewer(AUTHOR), { authorId: AUTHOR }), []);
  });

  it("**不按作者筛时，匿名帖照常出现在版块里** —— 它只是不署名，不是被藏起来", () => {
    post("p1", { anonymous: true });
    const list = q.listPosts(viewer("u_other"), { boardId: BOARD });
    assert.equal(list.length, 1);
    assert.equal(list[0].authorName, "匿名");
  });

  it("私密帖照旧不漏给别人", () => {
    post("p1", { visibility: "private" });
    assert.equal(q.listPosts(viewer("u_other"), { authorId: AUTHOR }).length, 0);
    assert.equal(q.listPosts(viewer(AUTHOR), { authorId: AUTHOR }).length, 1);
  });

  it("草稿只在作者自己那儿出现", () => {
    post("p1", { status: "draft" });
    assert.equal(q.listPosts(viewer("u_other"), { authorId: AUTHOR }).length, 0);
    assert.equal(q.listPosts(viewer(AUTHOR), { authorId: AUTHOR }).length, 1);
  });

  it("别人的帖子不会混进来", () => {
    post("p1");
    post("p2", { authorId: "u_someone_else" });
    assert.deepEqual(q.listPosts(viewer("u_x"), { authorId: AUTHOR }).map((p) => p.id), ["p1"]);
  });
});
