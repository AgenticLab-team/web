import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

/**
 * 项目目录与项目页。
 *
 * ═════════════════════════════════════════
 * 这个文件几乎全是隐私断言
 * ═════════════════════════════════════════
 *
 * 这一页把「站内某个人」和「某个 GitHub 账号」摆在同一行上。
 * 那些仓库本来就在 GitHub 上公开着，**而这条对应关系是这个站拼出来的** ——
 * 漏一道门的后果不是显示得不好看，是把「这个微信群里的谁 =
 * 这个 GitHub 账号」送给了不该看的人。
 *
 * 三道门（展示开关 / 隐身 / 要登录）里，前两道在这里测，
 * 第三道在 proxy 那一层（`tests/proxy.test.ts` 盯着名单和 matcher）。
 */

const TMP = mkdtempSync(join(tmpdir(), "al-projects-"));
process.env.DB_PATH = join(TMP, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
process.env.SITE_URL = "https://example.test";

describe("项目目录", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { projectDirectory, projectHeader } = await import("@/lib/github/projects");

  after(() => rmSync(TMP, { recursive: true, force: true }));

  let seq = 0;

  function repo(over: Record<string, unknown> = {}) {
    const n = ++seq;
    return {
      id: `r${n}`,
      fullName: `owner${n}/repo${n}`,
      name: `repo${n}`,
      description: "说明",
      htmlUrl: `https://github.com/owner${n}/repo${n}`,
      language: "TypeScript",
      stars: 3,
      forks: 0,
      isFork: false,
      archived: false,
      isPrivate: false,
      createdAt: 1_000,
      pushedAt: 2_000,
      ...over,
    };
  }

  /** 一个绑了 GitHub 的成员，加上他的仓库快照 */
  function member(
    id: string,
    opts: { show?: boolean; hidden?: boolean; kind?: "member" | "bot"; repos?: unknown[] } = {},
  ) {
    dbm.db
      .insert(schema.users)
      .values({
        id,
        wxId: `wx_${id}`,
        wxNickname: `昵称${id}`,
        kind: opts.kind ?? "member",
        directoryHidden: opts.hidden ?? false,
      })
      .run();
    dbm.db
      .insert(schema.githubConnections)
      .values({
        id: `c_${id}`,
        userId: id,
        githubUserId: `gh_${id}`,
        login: `gh-${id}`,
        htmlUrl: `https://github.com/gh-${id}`,
        showOnProfile: opts.show ?? true,
      })
      .run();
    dbm.db
      .insert(schema.githubRepoCache)
      .values({ userId: id, repos: opts.repos ?? [repo()], fetchedAt: 1 })
      .run();
  }

  function reset() {
    for (const t of [
      schema.githubRepoCache,
      schema.githubConnections,
      schema.githubFacts,
      schema.posts,
      schema.boards,
      schema.users,
    ]) {
      dbm.db.delete(t).run();
    }
    dbm.db.insert(schema.boards).values({ id: "b1", key: "b1", name: "版块" }).run();
  }

  it("绑了、开了展示开关的人，项目在目录里", () => {
    reset();
    member("u1", { repos: [repo({ fullName: "a/b", name: "b" })] });
    const dir = projectDirectory();
    assert.deepEqual(dir.projects.map((p) => p.key), ["a/b"]);
    assert.equal(dir.builders, 1);
  });

  it("**没开展示开关的一个都不出现** —— 绑定不等于同意公开", () => {
    /*
     * 有人绑定只是为了那条「有新项目要不要发帖」的提醒。
     * 默认就是关的，这一页不做任何「反正他绑了」的推定。
     */
    reset();
    member("u1", { show: false });
    assert.deepEqual(projectDirectory().projects, []);
  });

  it("**隐身的人一个都不出现** —— 项目目录是一份换了维度的成员名册", () => {
    /*
     * 隐身开关自己的原话是「不出现在成员列表和搜人结果里」。
     * 一个按语言可筛的项目目录，照着项目找人和照着人找项目
     * 是同一件事 —— 漏掉这一条，刚把自己从成员目录里摘出去的人
     * 会在另一页上带着名字和头像重新出现。
     */
    reset();
    member("u1", { hidden: true });
    assert.deepEqual(projectDirectory().projects, []);
    // 项目页那一侧也不能漏
    member("u2", { hidden: true, repos: [repo({ fullName: "a/b" })] });
    assert.deepEqual(projectHeader("a", "b")!.builders, []);
  });

  it("**每一行都说得出是谁做的** —— 「不知道是谁」和「他不想让你知道」不能长成一个样", () => {
    reset();
    member("u1");
    for (const p of projectDirectory().projects) {
      assert.ok(p.builder.name.length > 0, "有一行没有作者");
    }
  });

  it("**页面拿不到 wx_id** —— 只用来算颜色的值不该进 RSC 载荷", () => {
    reset();
    member("u1");
    const [p] = projectDirectory().projects;
    assert.equal("wxId" in p.builder, false, "wx_id 被带进了组件的 props");
    assert.equal(typeof p.builder.paletteIndex, "number");
    assert.equal(p.builder.hasProfile, true);
  });

  it("机器人账号不算社区成员的项目", () => {
    reset();
    member("bot1", { kind: "bot" });
    assert.deepEqual(projectDirectory().projects, []);
  });

  describe("哪些仓库不值得摆上来", () => {
    it("**私有的一律丢掉** —— 这是写在我们自己代码里、被测试盯着的那一道", () => {
      reset();
      member("u1", { repos: [repo({ fullName: "a/secret", isPrivate: true })] });
      assert.deepEqual(projectDirectory().projects, []);
    });

    it("没有 star 的 fork 不要 —— 那多半是点了一下 fork 按钮", () => {
      reset();
      member("u1", { repos: [repo({ fullName: "a/forked", isFork: true, stars: 0 })] });
      assert.deepEqual(projectDirectory().projects, []);
    });

    it("有 star 的 fork 留着 —— 否则测的是「fork 全丢」", () => {
      reset();
      member("u1", { repos: [repo({ fullName: "a/forked", isFork: true, stars: 9 })] });
      assert.deepEqual(projectDirectory().projects.map((p) => p.key), ["a/forked"]);
    });

    it("从来没推过代码的不要 —— 空仓库在目录上和真项目长得一样", () => {
      reset();
      member("u1", { repos: [repo({ fullName: "a/empty", pushedAt: 0 })] });
      assert.deepEqual(projectDirectory().projects, []);
    });
  });

  it("**同一个仓库只出现一行** —— 两行点进去是同一页", () => {
    reset();
    member("u1", { repos: [repo({ fullName: "a/same" })] });
    member("u2", { repos: [repo({ fullName: "A/Same" })] });
    assert.deepEqual(projectDirectory().projects.map((p) => p.key), ["a/same"]);
  });

  it("按语言筛，筛选条按项目数排", () => {
    reset();
    member("u1", {
      repos: [
        repo({ fullName: "a/go1", language: "Go" }),
        repo({ fullName: "a/go2", language: "Go" }),
        repo({ fullName: "a/ts1", language: "TypeScript" }),
      ],
    });
    const dir = projectDirectory();
    assert.deepEqual(dir.facets.map((f) => f.language), ["Go", "TypeScript"]);
    assert.deepEqual(
      projectDirectory({ language: "Go" }).projects.map((p) => p.key).sort(),
      ["a/go1", "a/go2"],
    );
    // 筛完之后 total 说的仍然是「一共几个」—— 这一页要说得出自己有多空
    assert.equal(projectDirectory({ language: "Go" }).total, 3);
  });

  it("**归档的沉底**，不管哪种排法 —— 「这个社区在做什么」的答案不该是一个停更的东西", () => {
    reset();
    member("u1", {
      repos: [
        repo({ fullName: "a/old", archived: true, stars: 999, pushedAt: 9_000 }),
        repo({ fullName: "a/live", stars: 1, pushedAt: 5 }),
      ],
    });
    for (const sort of ["active", "stars", "new"] as const) {
      assert.deepEqual(
        projectDirectory({ sort }).projects.map((p) => p.key),
        ["a/live", "a/old"],
        `${sort} 排法把归档的排到了前面`,
      );
    }
  });
});

describe("项目页：站里聊过它的帖子", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { listPosts } = await import("@/lib/forum/queries");
  const { projectHeader } = await import("@/lib/github/projects");

  const member = { userId: "u_plain", kind: "member" as const, roleIds: [], groupIds: [] };
  const guest = { userId: null, kind: "guest" as const, roleIds: [], groupIds: [] };

  let n = 0;
  function post(over: Partial<typeof schema.posts.$inferInsert> = {}) {
    const id = `pp${++n}`;
    dbm.db
      .insert(schema.posts)
      .values({
        id,
        boardId: "b1",
        authorId: "u_author",
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
    dbm.db.delete(schema.posts).run();
    dbm.db.delete(schema.boards).run();
    dbm.db.insert(schema.boards).values({ id: "b1", key: "b1", name: "版块" }).run();
  }

  it("按 repoRef 反查得到", () => {
    reset();
    post({ repoRef: "a/b", title: "聊 a/b" });
    post({ repoRef: "c/d", title: "聊 c/d" });
    post({ title: "没关联" });
    assert.deepEqual(
      listPosts(member as never, { repoRef: "a/b" }).map((p) => p.title),
      ["聊 a/b"],
    );
  });

  it("**关联一个项目不会让任何一篇多露出来** —— 可见性还是原来那套", () => {
    /*
     * 这一条是整个功能唯一的泄露口：项目页是一条新的「按什么筛」，
     * 而这个仓库最贵的几次错误都是同一条规则在两个地方各写了一遍。
     * 所以它走的是 listPosts 的一个选项，不是项目页自己写的一条 SQL。
     */
    reset();
    post({ repoRef: "a/b", visibility: "group", visibilityGroupId: "g@chatroom", title: "群内" });
    post({ repoRef: "a/b", visibility: "member", title: "仅成员" });
    assert.deepEqual(listPosts(guest as never, { repoRef: "a/b" }).map((p) => p.title), []);
    assert.deepEqual(listPosts(member as never, { repoRef: "a/b" }).map((p) => p.title), ["仅成员"]);
  });

  it("摘要里带着关联的项目 —— 列表上要打得出那个标记", () => {
    reset();
    post({ repoRef: "a/b" });
    assert.equal(listPosts(member as never, { limit: 5 })[0].repoRef, "a/b");
  });

  it("**没有站内成员绑过它，这一页照样打得开**", () => {
    /*
     * 有人聊一个跟这个社区毫无关系的上游仓库很正常 ——
     * 而那恰恰是「站里聊过它的」最有价值的一种情况。
     */
    const header = projectHeader("torvalds", "linux");
    assert.equal(header!.key, "torvalds/linux");
    assert.deepEqual(header!.builders, []);
    assert.equal(header!.url, "https://github.com/torvalds/linux");
  });

  it("**认不出来的名字返回 null** —— 绝不拿它去拼一条 github.com 的地址", () => {
    assert.equal(projectHeader("a", "b/c"), null);
    assert.equal(projectHeader("features", "actions"), null);
    assert.equal(projectHeader("-bad", "repo"), null);
  });

  it("大小写不同的地址落到同一页", () => {
    assert.equal(projectHeader("Torvalds", "Linux")!.key, "torvalds/linux");
  });
});
