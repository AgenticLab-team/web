import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

/**
 * 首页摘要的可见性过滤。
 *
 * ─────────────────────────────────────────
 * 这条测试是一次变异普查逼出来的
 * ─────────────────────────────────────────
 *
 * 把 `lib/queries/digest.ts` 里那句
 * `.filter((r) => canSeePost(...).visible)` 改成恒真 ——
 * **全量 6089 条测试一条都没红。**
 *
 * 而这一句是那里**唯一**的可见性收口：它的 SQL 只筛了
 * 「没删、已发布」，没有任何可见性条件（这是刻意的 ——
 * 在 SQL 里拼六级可见性等于把判定抄成第二份）。
 *
 * 也就是说：那一行一旦失效，**首页会把仅成员、仅某群、仅某角色、
 * 仅作者自己可见的帖子标题，摆给每一个打开这个站的人看** ——
 * 而首页是所有人看得最多的一页。
 *
 * ─────────────────────────────────────────
 * 测的是「过滤真的发生了」，不是 canSeePost 本身
 * ─────────────────────────────────────────
 *
 * `canSeePost` 这个纯函数早就被测得很细。缺的从来不是它，
 * 是**它有没有被调用**。所以这里必须走真库、走 buildDigest，
 * 而不是再对着那个纯函数断言一遍。
 */

const TMP = mkdtempSync(join(tmpdir(), "al-digestvis-"));
process.env.DB_PATH = join(TMP, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
process.env.SITE_URL = "https://example.test";

describe("首页摘要不许漏出看不见的帖子", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { buildDigest } = await import("@/lib/queries/digest");

  after(() => rmSync(TMP, { recursive: true, force: true }));

  const AUTHOR = "u_author";
  const OUTSIDER = "u_outsider";
  const GROUP = "g_secret@chatroom";

  let seq = 0;
  function post(over: Partial<typeof schema.posts.$inferInsert> = {}) {
    const id = `p${++seq}`;
    dbm.db
      .insert(schema.posts)
      .values({
        id,
        boardId: "b1",
        authorId: AUTHOR,
        title: `标题-${id}`,
        content: "正文",
        contentHtml: "<p>正文</p>",
        status: "published",
        visibility: "public",
        ...over,
      })
      .run();
    return id;
  }

  function reset() {
    for (const t of [schema.posts, schema.boards, schema.users, schema.groupMembers, schema.groups]) {
      dbm.db.delete(t).run();
    }
    dbm.db.insert(schema.boards).values({ id: "b1", key: "b1", name: "版块" }).run();
    dbm.db
      .insert(schema.users)
      .values([
        { id: AUTHOR, wxId: "wx_author", status: "active" },
        { id: OUTSIDER, wxId: "wx_outsider", status: "active" },
      ])
      .run();
  }

  /** 摘要里露出来的标题 —— latest 是唯一把标题渲染到页面上的地方 */
  const titles = (user: { id: string; wxId: string } | null) =>
    buildDigest(user as never, []).latest.map((p) => p.title);

  const outsider = { id: OUTSIDER, wxId: "wx_outsider" };
  const author = { id: AUTHOR, wxId: "wx_author" };

  it("公开帖对所有人可见", () => {
    reset();
    post({ title: "公开的" });
    assert.deepEqual(titles(outsider), ["公开的"]);
    assert.deepEqual(titles(null), ["公开的"]);
  });

  it("**仅成员可见的帖子，访客看不到**", () => {
    reset();
    post({ visibility: "member", title: "仅成员" });
    assert.deepEqual(titles(null), [], "访客的首页上出现了仅成员可见的帖子标题");
    assert.deepEqual(titles(outsider), ["仅成员"]);
  });

  it("**仅作者自己可见的帖子，别人一个字都看不到**", () => {
    reset();
    post({ visibility: "private", title: "只有我自己" });
    assert.deepEqual(titles(outsider), [], "私密帖的标题漏到别人首页上了");
    assert.deepEqual(titles(null), []);
    assert.deepEqual(titles(author), ["只有我自己"]);
  });

  it("**限某个群的帖子，不在那个群的人看不到**", () => {
    reset();
    post({ visibility: "group", visibilityGroupId: GROUP, title: "群内可见" });
    assert.deepEqual(titles(outsider), [], "群限定帖漏给了不在那个群的人");

    /*
     * 把 outsider 加进那个群，就该看得到了 —— 否则这条测的是「全都看不到」，
     * 而那种测试对「过滤写错成永远返回空」是绿的。
     *
     * 群本身也要建：visibleGroupIds 要求 groups 行存在且 sync_enabled，
     * 只插一行成员是进不了可见范围的。
     */
    dbm.db
      .insert(schema.groups)
      .values({ convId: GROUP, name: "秘密群", isGroup: true, syncEnabled: true })
      .run();
    dbm.db
      .insert(schema.groupMembers)
      .values({ convId: GROUP, wxId: "wx_outsider" })
      .run();
    assert.deepEqual(titles(outsider), ["群内可见"]);
  });

  it("**限某个角色的帖子，没有那个角色的人看不到**", () => {
    reset();
    post({ visibility: "role", visibilityRoleId: "r_admin", title: "限角色" });
    assert.deepEqual(titles(outsider), []);
  });

  it("**草稿不会出现在别人的摘要里**", () => {
    reset();
    post({ status: "draft", title: "还没写完" });
    assert.deepEqual(titles(outsider), []);
    assert.deepEqual(titles(null), []);
  });

  it("**混在一起时只留下该留的** —— 这一条最接近线上的样子", () => {
    /*
     * 单独测一种可见性时，「全都过滤掉」和「过滤对了」看起来一样。
     * 混着放才分得出：公开的那条必须还在，其余必须都不在。
     */
    reset();
    post({ visibility: "public", title: "公开的" });
    post({ visibility: "member", title: "仅成员" });
    post({ visibility: "private", title: "私密" });
    post({ visibility: "group", visibilityGroupId: GROUP, title: "群内" });
    post({ visibility: "role", visibilityRoleId: "r_x", title: "限角色" });

    assert.deepEqual(titles(null), ["公开的"], "访客看到了不该看的");
  });

  it("**新帖计数也走同一份过滤** —— 数字和列表不能各算各的", () => {
    /*
     * `newPosts` 那个数字和 `latest` 那三条来自同一个 visible 数组。
     * 如果哪天有人给数字单独写一条查询，就会出现
     * 「说有 5 篇新帖，点进去只有 1 篇」——
     * 而更糟的方向是数字把私密帖也数了进去。
     */
    reset();
    post({ visibility: "public", title: "公开的" });
    post({ visibility: "private", title: "私密" });
    post({ visibility: "member", title: "仅成员" });

    assert.equal(buildDigest(null as never, []).newPosts, 1, "访客的「新帖」数把看不见的也数进去了");
  });
});
