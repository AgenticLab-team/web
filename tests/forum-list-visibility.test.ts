import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

/**
 * 论坛列表**真的**按可见性过滤了吗。
 *
 * ─────────────────────────────────────────
 * 规则测得很细，调用点一条覆盖都没有
 * ─────────────────────────────────────────
 *
 * `forum-visibility.test.ts` 把 `canSeePost` 的 6 级 × 6 身份
 * 三十六种组合逐一断言过。而把 `listPosts` 里那句
 * `.filter((r) => canSeePost(...).visible)` 改成恒真 ——
 * **全量 6097 条测试一条都没红。**
 *
 * 一个被测到发亮的纯函数，加一个没人测的调用点，
 * 合起来等于没有防护。
 *
 * ─────────────────────────────────────────
 * 漏的正好是 SQL 故意放过去的那两级
 * ─────────────────────────────────────────
 *
 * `coarseVisibilityFilter` 在 SQL 里先粗筛一道，但它的注释写着
 * 「**role 与 group 交给精判**」—— 这两级是原样放进内存的。
 *
 * 所以那句 filter 一旦失效，泄露的不是全部，而是精确的两类：
 * **限某个角色的帖子、限某个群的帖子**，
 * 会出现在每一个人的论坛列表里。而这两类恰恰是最该藏住的 ——
 * 群限定那一档还挂着「群聊内容不外泄」那条硬约束。
 */

const TMP = mkdtempSync(join(tmpdir(), "al-listvis-"));
process.env.DB_PATH = join(TMP, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
process.env.SITE_URL = "https://example.test";

describe("论坛列表的可见性收口", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { listPosts } = await import("@/lib/forum/queries");

  after(() => rmSync(TMP, { recursive: true, force: true }));

  const AUTHOR = "u_author";
  const GROUP = "g_inner@chatroom";
  const ROLE = "r_vip";

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
    for (const t of [schema.posts, schema.boards, schema.groupMembers, schema.groups]) {
      dbm.db.delete(t).run();
    }
    dbm.db.insert(schema.boards).values({ id: "b1", key: "b1", name: "版块" }).run();
  }

  /** 一个普通成员：登录了，但不在那个群、也没有那个角色 */
  const member = { userId: "u_plain", kind: "member" as const, roleIds: [], groupIds: [] };
  const guest = { userId: null, kind: "guest" as const, roleIds: [], groupIds: [] };

  // listPosts 直接返回数组（没有 rows/total 包装）
  const titles = (viewer: unknown) =>
    listPosts(viewer as never, { limit: 50 }).map((p) => p.title).sort();

  it("公开帖谁都看得到", () => {
    reset();
    post({ title: "公开" });
    assert.deepEqual(titles(guest), ["公开"]);
    assert.deepEqual(titles(member), ["公开"]);
  });

  it("**限某个角色的帖子，没有那个角色的成员看不到**", () => {
    /*
     * 这一档 SQL 是故意放过去的（「role 与 group 交给精判」），
     * 所以它完全依赖内存里那句 filter。
     */
    reset();
    post({ visibility: "role", visibilityRoleId: ROLE, title: "限角色" });
    assert.deepEqual(titles(member), [], "限角色的帖子出现在了没有那个角色的人的列表里");
    assert.deepEqual(titles(guest), []);
  });

  it("有那个角色的人看得到 —— 否则测的是「全都看不到」", () => {
    reset();
    post({ visibility: "role", visibilityRoleId: ROLE, title: "限角色" });
    const vip = { userId: "u_vip", kind: "member" as const, roleIds: [ROLE], groupIds: [] };
    assert.deepEqual(titles(vip), ["限角色"]);
  });

  it("**限某个群的帖子，不在那个群的成员看不到**", () => {
    reset();
    post({ visibility: "group", visibilityGroupId: GROUP, title: "群内" });
    assert.deepEqual(titles(member), [], "群限定帖漏给了不在那个群的人");
    assert.deepEqual(titles(guest), []);
  });

  it("在那个群里的人看得到", () => {
    reset();
    post({ visibility: "group", visibilityGroupId: GROUP, title: "群内" });
    const inGroup = { userId: "u_in", kind: "member" as const, roleIds: [], groupIds: [GROUP] };
    assert.deepEqual(titles(inGroup), ["群内"]);
  });

  it("**仅成员可见的对访客不可见**", () => {
    reset();
    post({ visibility: "member", title: "仅成员" });
    assert.deepEqual(titles(guest), []);
    assert.deepEqual(titles(member), ["仅成员"]);
  });

  it("**私密帖只有作者看得到**", () => {
    reset();
    post({ visibility: "private", title: "私密" });
    assert.deepEqual(titles(member), []);
    const author = { userId: AUTHOR, kind: "member" as const, roleIds: [], groupIds: [] };
    assert.deepEqual(titles(author), ["私密"]);
  });

  it("**混在一起时只留下该留的** —— 最接近线上的形状", () => {
    /*
     * 单独测一级时，「全都过滤掉」和「过滤对了」看起来一样。
     * 混着放才分得出来。
     */
    reset();
    post({ visibility: "public", title: "公开" });
    post({ visibility: "member", title: "仅成员" });
    post({ visibility: "role", visibilityRoleId: ROLE, title: "限角色" });
    post({ visibility: "group", visibilityGroupId: GROUP, title: "群内" });
    post({ visibility: "private", title: "私密" });

    assert.deepEqual(titles(member), ["仅成员", "公开"], "普通成员看到了不该看的");
    assert.deepEqual(titles(guest), ["公开"], "访客看到了不该看的");
  });

  it("**过滤发生在切页之前** —— 否则一页里会缺几条", () => {
    /*
     * 实现是「多查一些（overFetch）→ 按可见性过滤 → 再切 limit」。
     * 顺序反过来的话，先切 20 条再过滤，最后可能只剩 3 条 ——
     * 而下一页又从第 21 条开始，中间那些看得见的就永远翻不到了。
     *
     * 这里放 5 条看不见的夹着 2 条看得见的，limit 设成 2：
     * 顺序对的话正好拿到那 2 条。
     */
    reset();
    post({ visibility: "role", visibilityRoleId: ROLE, title: "隐1" });
    post({ visibility: "public", title: "公开A" });
    post({ visibility: "group", visibilityGroupId: GROUP, title: "隐2" });
    post({ visibility: "role", visibilityRoleId: ROLE, title: "隐3" });
    post({ visibility: "public", title: "公开B" });

    const got = listPosts(member as never, { limit: 2 }).map((p) => p.title).sort();
    assert.deepEqual(got, ["公开A", "公开B"], "先切页后过滤 —— 看得见的被挤掉了");
  });
});
