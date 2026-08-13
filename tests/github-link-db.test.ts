import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * GitHub 绑定 —— 接上真库之后。
 *
 * ═════════════════════════════════════════
 * 为什么这几条一定要在真库上测
 * ═════════════════════════════════════════
 *
 * 「一个 GitHub 账号不能绑到两个站内账号」这句话，
 * 在代码里是一次 select、在库里是一个唯一索引。
 * **只测代码那次 select 是没有意义的** —— select 和 insert 之间
 * 有一个窗口，两个请求同时挤进去时只有约束挡得住。
 * 而约束有没有真的建出来，只有把 SQL 跑一遍才知道。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-github-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

/** 测试里用的加密密钥。32 字节 hex —— 和生产上那把没有任何关系 */
const KEY = "3f".repeat(32);

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let link: typeof import("@/lib/github/link");
let prompts: typeof import("@/lib/github/prompts");
let secret: typeof import("@/lib/github/secret");

const viewer = (id: string, login: string) => ({
  id,
  login,
  name: null,
  avatarUrl: null,
  htmlUrl: `https://github.com/${login}`,
});

const token = { accessToken: "gho_testtoken", scope: "" };

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  link = await import("@/lib/github/link");
  prompts = await import("@/lib/github/prompts");
  secret = await import("@/lib/github/secret");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.githubSharePrompts,
    schema.githubRepoCache,
    schema.githubConnections,
    schema.auditLogs,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }

  dbm.db
    .insert(schema.users)
    .values([
      { id: "user_a", wxId: "wxid_a", status: "active" },
      { id: "user_b", wxId: "wxid_b", status: "active" },
    ])
    .run();
});

describe("**一个 GitHub 账号不能绑到多个站内账号**", () => {
  /*
   * 这是身份的底线。允许一个 GitHub 同时是两个人的话，
   * 「主页上这个 GitHub 是他的」这句话就不再成立 ——
   * 而整个展示功能建立在这句话上。
   */
  it("第二个人拿同一个 GitHub 来绑，绑不上", () => {
    const first = link.linkGithub("user_a", viewer("777", "octocat"), token, KEY);
    assert.equal(first.ok, true);

    const second = link.linkGithub("user_b", viewer("777", "octocat"), token, KEY);
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, "already_linked_elsewhere");
  });

  it("失败的措辞不说是谁占着 —— 说了等于回答「某人绑没绑 GitHub」", async () => {
    const { LINK_FAILURE_MESSAGE } = await import("@/lib/github/oauth-rules");
    const msg = LINK_FAILURE_MESSAGE.already_linked_elsewhere;
    assert.doesNotMatch(msg, /user_|wxid_|谁|哪位/);
    assert.match(msg, /另一个账号/);
  });

  it("**唯一索引真的建出来了** —— 绕过代码那层判断也插不进去", () => {
    /*
     * 直接往库里插第二行，模拟「select 和 insert 之间挤进来一个并发请求」。
     * 这一步必须抛异常。不抛的话，上面那个 select 就是唯一的防线，
     * 而它挡不住并发。
     */
    link.linkGithub("user_a", viewer("777", "octocat"), token, KEY);

    assert.throws(() => {
      dbm.db
        .insert(schema.githubConnections)
        .values({
          userId: "user_b",
          githubUserId: "777",
          login: "octocat",
          htmlUrl: "https://github.com/octocat",
        })
        .run();
    }, /UNIQUE/i);
  });

  it("并发窗口撞上时给的是同一句话，不是 500", () => {
    // 先绕过代码直接占位，再走正常路径 —— 走到 catch 那一支
    dbm.db
      .insert(schema.githubConnections)
      .values({
        userId: "user_b",
        githubUserId: "888",
        login: "someone",
        htmlUrl: "https://github.com/someone",
      })
      .run();

    const result = link.linkGithub("user_a", viewer("888", "someone"), token, KEY);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "already_linked_elsewhere");
  });
});

describe("**一个站内账号只能绑一个 GitHub**", () => {
  it("换一个 GitHub 要先解绑", () => {
    link.linkGithub("user_a", viewer("111", "first"), token, KEY);
    const result = link.linkGithub("user_a", viewer("222", "second"), token, KEY);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "already_linked_here");
  });

  it("**同一个 GitHub 重复绑定不算错** —— 后退再前进会重放这个回调", () => {
    /*
     * 微信内置浏览器上「后退再前进」会重放 OAuth 回调。
     * 报一句「你已经绑过了」会让人以为出了问题，
     * 而实际上什么都没发生错。
     */
    link.linkGithub("user_a", viewer("111", "first"), token, KEY);
    const again = link.linkGithub("user_a", viewer("111", "first"), token, KEY);
    assert.equal(again.ok, true);
    assert.equal(again.ok && again.firstTime, false, "第二次不该再当成首次绑定");
  });

  it("重新授权会把改过的用户名同步过来", () => {
    link.linkGithub("user_a", viewer("111", "oldname"), token, KEY);
    link.linkGithub("user_a", viewer("111", "newname"), token, KEY);
    assert.equal(link.connectionOf("user_a")?.login, "newname");
  });
});

describe("**token 落库是密文**", () => {
  it("库里那一列读出来不是明文，但解得开", () => {
    link.linkGithub("user_a", viewer("111", "me"), token, KEY);
    const stored = link.connectionOf("user_a")!.accessToken!;
    assert.doesNotMatch(stored, /gho_testtoken/);
    assert.equal(secret.decryptToken(stored, KEY), "gho_testtoken");
  });

  it("审计里记了 login，但没有 token", () => {
    link.linkGithub("user_a", viewer("111", "me"), token, KEY);
    const rows = dbm.db.select().from(schema.auditLogs).all();
    const entry = rows.find((r) => r.action === "user.github.link");
    assert.ok(entry, "绑定没留审计");
    assert.doesNotMatch(JSON.stringify(entry), /gho_testtoken/);
    assert.match(JSON.stringify(entry), /"login":"me"/);
  });
});

describe("**展示开关**", () => {
  it("刚绑上时是开着的", () => {
    /*
     * ── 2026-08 口径变了 ──────────────────────
     *
     * 原来默认是**关**的，理由是「绑定 ≠ 同意展示」：有人绑定只是想要
     * 那个「有新项目要不要发帖」的提醒。那个顾虑本身没错。
     *
     * 但站长定了另一个口径：这是技术社区，绑 GitHub 的人绝大多数
     * 就是想让人看见，而默认关着的结果是绑完主页上什么都没有，
     * 他会以为绑失败了 —— 一个功能最糟的失败方式。
     *
     * 保住那个顾虑的做法不是默认关，是**绑定时当场说清楚** +
     * 开关就在旁边一键可关。知情且可退出 > 默认关闭但没人找得到。
     */
    link.linkGithub("user_a", viewer("111", "me"), token, KEY);
    assert.equal(link.connectionOf("user_a")?.showOnProfile, true);
  });

  it("**关掉之后 publicConnectionOf 当作没有绑定**", () => {
    /*
     * 默认变了，但这条没变，而且它现在更重要 ——
     * 它是那个「一键可关」真的有效的唯一保证。
     *
     * 主页那一栏只认 publicConnectionOf。判定收在这一个函数里，
     * 页面那边只管「拿到 null 就整块不渲染」——
     * 让每个页面自己判断的话，两个页面早晚会判断出两套结果。
     */
    link.linkGithub("user_a", viewer("111", "me"), token, KEY);
    link.setShowOnProfile("user_a", false);
    assert.equal(link.publicConnectionOf("user_a"), null);

    link.setShowOnProfile("user_a", true);
    assert.equal(link.publicConnectionOf("user_a")?.login, "me");
  });

  it("提示开关默认是开的 —— 大多数人来绑就是为了这个", () => {
    link.linkGithub("user_a", viewer("111", "me"), token, KEY);
    assert.equal(link.connectionOf("user_a")?.promptEnabled, true);
  });
});

describe("**解绑要把跟着的数据一起清干净**", () => {
  it("缓存和提示记录一起没", () => {
    /*
     * 只删绑定行的话，那个人的仓库快照还躺在库里，
     * 而「我已经解绑了」的人合理地认为那些数据不存在了。
     */
    link.linkGithub("user_a", viewer("111", "me"), token, KEY);
    dbm.db
      .insert(schema.githubRepoCache)
      .values({ userId: "user_a", repos: [], fetchedAt: Date.now() })
      .run();
    prompts.recordPrompts("user_a", [
      {
        kind: "repo",
        subjectKey: "repo:1",
        title: "t",
        url: "u",
        summary: null,
        repoFullName: "me/t",
        subjectAt: Date.now(),
        status: "pending",
      },
    ]);

    assert.equal(link.unlinkGithub("user_a"), true);

    assert.equal(link.connectionOf("user_a"), null);
    assert.equal(dbm.db.select().from(schema.githubRepoCache).all().length, 0);
    assert.equal(dbm.db.select().from(schema.githubSharePrompts).all().length, 0);
  });

  it("解绑之后可以重新绑上（包括绑别的 GitHub）", () => {
    link.linkGithub("user_a", viewer("111", "first"), token, KEY);
    link.unlinkGithub("user_a");
    const again = link.linkGithub("user_a", viewer("222", "second"), token, KEY);
    assert.equal(again.ok, true);
  });

  it("那个 GitHub 解绑后可以被别人绑走", () => {
    link.linkGithub("user_a", viewer("111", "shared"), token, KEY);
    link.unlinkGithub("user_a");
    assert.equal(link.linkGithub("user_b", viewer("111", "shared"), token, KEY).ok, true);
  });

  it("解绑也留审计", () => {
    link.linkGithub("user_a", viewer("111", "me"), token, KEY);
    link.unlinkGithub("user_a");
    const actions = dbm.db.select().from(schema.auditLogs).all().map((r) => r.action);
    assert.ok(actions.includes("user.github.unlink"));
  });
});

describe("**提示：提过一次就不会再提第二次**", () => {
  const p = (key: string, status: "pending" | "baseline" = "pending") => ({
    kind: "repo" as const,
    subjectKey: key,
    title: "t",
    url: "https://github.com/me/t",
    summary: null,
    repoFullName: "me/t",
    subjectAt: Date.now(),
    status,
  });

  it("同一个 subjectKey 写第二遍会被唯一索引挡掉，而且不报错", () => {
    assert.equal(prompts.recordPrompts("user_a", [p("repo:1")]), 1);
    assert.equal(prompts.recordPrompts("user_a", [p("repo:1")]), 0, "第二次不该再写进去");
    assert.equal(prompts.listPendingPrompts("user_a").length, 1);
  });

  it("**点了「不用了」之后，同一个仓库再也不会出现**", () => {
    prompts.recordPrompts("user_a", [p("repo:1")]);
    const id = prompts.listPendingPrompts("user_a")[0].id;
    assert.equal(prompts.dismissPrompt("user_a", id), true);
    assert.deepEqual(prompts.listPendingPrompts("user_a"), []);

    // 下一轮检测再来一遍 —— 记录还在，所以什么都不会发生
    assert.equal(prompts.recordPrompts("user_a", [p("repo:1")]), 0);
    assert.deepEqual(prompts.listPendingPrompts("user_a"), []);
    assert.ok(prompts.knownSubjectKeys("user_a").has("repo:1"));
  });

  it("拒绝的记录**留在库里**，不是删掉", () => {
    // 删掉的话下一轮会以为没见过，于是又提示一遍
    prompts.recordPrompts("user_a", [p("repo:1")]);
    prompts.dismissPrompt("user_a", prompts.listPendingPrompts("user_a")[0].id);
    const rows = dbm.db.select().from(schema.githubSharePrompts).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "dismissed");
    assert.ok(rows[0].resolvedAt);
  });

  it("同一个 key 换个人是两条 —— 唯一约束是 (user_id, subject_key)", () => {
    assert.equal(prompts.recordPrompts("user_a", [p("repo:1")]), 1);
    assert.equal(prompts.recordPrompts("user_b", [p("repo:1")]), 1);
  });

  it("baseline 的那些不出现在页面上，但照样算「见过了」", () => {
    prompts.recordPrompts("user_a", [p("repo:9", "baseline")]);
    assert.deepEqual(prompts.listPendingPrompts("user_a"), []);
    assert.ok(prompts.knownSubjectKeys("user_a").has("repo:9"));
  });

  it("挂太久的自动收起来，之后也不会复活", () => {
    prompts.recordPrompts("user_a", [p("repo:1")]);
    const future = Date.now() + 30 * 86_400_000;
    assert.equal(prompts.expireStalePrompts("user_a", future), 1);
    assert.deepEqual(prompts.listPendingPrompts("user_a"), []);
    assert.equal(prompts.recordPrompts("user_a", [p("repo:1")]), 0);
  });
});

describe("**提示是私事 —— 拿别人的 id 什么都拿不到**", () => {
  it("promptFor 必须 user 和 id 都对上", () => {
    /*
     * 只按 id 查的话，这个 id 就成了一个「输入 id、
     * 返回别人还没公开的新仓库名」的接口。
     * id 是 ULID、猜不到，但「猜不到」不是访问控制。
     */
    prompts.recordPrompts("user_a", [
      {
        kind: "repo",
        subjectKey: "repo:secret",
        title: "还没公开的新项目",
        url: "https://github.com/me/secret",
        summary: null,
        repoFullName: "me/secret",
        subjectAt: Date.now(),
        status: "pending",
      },
    ]);
    const id = prompts.listPendingPrompts("user_a")[0].id;

    assert.ok(prompts.promptFor("user_a", id));
    assert.equal(prompts.promptFor("user_b", id), null, "别人拿同一个 id 读到了内容");
  });

  it("dismiss 也一样 —— 别人改不动你的提示", () => {
    prompts.recordPrompts("user_a", [
      {
        kind: "repo",
        subjectKey: "repo:1",
        title: "t",
        url: "u",
        summary: null,
        repoFullName: null,
        subjectAt: Date.now(),
        status: "pending",
      },
    ]);
    const id = prompts.listPendingPrompts("user_a")[0].id;
    assert.equal(prompts.dismissPrompt("user_b", id), false);
    assert.equal(prompts.listPendingPrompts("user_a").length, 1);
  });
});
