import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 帖子底下那一排「这篇提到的」—— 接上真库之后。
 *
 * ═════════════════════════════════════════
 * 这里守的两件事
 * ═════════════════════════════════════════
 *
 * ① **渲染这条路上绝不联网。** 一旦联了，GitHub 慢一秒我们的帖子
 *    就慢一秒，GitHub 挂了帖子页跟着挂 —— 换来的只是一张卡片
 *    早几分钟出现。这条不是性能偏好，是可用性边界。
 *
 * ② **缓存里没有就整块不出现。** 不显示占位骨架、不显示「加载失败」——
 *    正文里那条链接原样还在，读者什么都没少。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-ghmention-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let mentions: typeof import("@/lib/github/mentions");
let refs: typeof import("@/lib/github/link-refs");

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  mentions = await import("@/lib/github/mentions");
  refs = await import("@/lib/github/link-refs");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.githubFacts).run();
  dbm.db.delete(schema.replies).run();
  dbm.db.delete(schema.posts).run();
  dbm.db.delete(schema.boards).run();
});

const link = (u: string) => `<p>看 <a href="${u}">这个</a></p>`;
const ref = (u: string) => refs.parseGithubUrl(u)!;

function cache(row: {
  key: string;
  kind?: "repo" | "issue" | "pr";
  url?: string;
  title?: string;
  summary?: string | null;
  gone?: boolean;
}) {
  dbm.db
    .insert(schema.githubFacts)
    .values({
      key: row.key,
      kind: row.kind ?? "repo",
      url: row.url ?? "https://github.com/a/b",
      title: row.title ?? "a/b",
      summary: row.summary ?? "说明",
      checkedAt: 1,
      gone: row.gone ?? false,
    })
    .run();
}

describe("显示哪几张", () => {
  it("缓存里有就显示", () => {
    cache({ key: "repo:a/b" });
    const got = mentions.mentionsFor(link("https://github.com/a/b"));
    assert.equal(got.length, 1);
    assert.equal(got[0].title, "a/b");
  });

  it("**缓存里没有就整块不出现** —— 正文里那条链接原样还在", () => {
    const got = mentions.mentionsFor(link("https://github.com/a/b"));
    assert.deepEqual(got, []);
  });

  it("**问过了发现东西没了 —— 也不显示**", () => {
    /*
     * 仓库删了或转私有了。显示一张「找不到」的卡片比不显示更糟：
     * 它把一条本来还能点的链接框成了一个坏掉的东西。
     */
    cache({ key: "repo:a/b", gone: true, title: "" });
    assert.deepEqual(mentions.mentionsFor(link("https://github.com/a/b")), []);
  });

  it("**顺序跟着正文** —— 作者先说的排前面", () => {
    /*
     * 按缓存表的顺序返回的话，同一篇帖子每次刷新都可能换个排列 ——
     * 那是最容易让人觉得页面坏了的表现。
     */
    /*
     * 名字**故意选成正文顺序和字母序相反**：正文里是 zebra 在前，
     * 而按 key 排是 apple 在前。两者一致的话，这条测试在
     * 「改成按缓存表返回」之后照样会绿 —— 那它就什么都没守住。
     */
    cache({ key: "repo:a/apple", title: "apple" });
    cache({ key: "repo:a/zebra", title: "zebra" });
    const html = link("https://github.com/a/zebra") + link("https://github.com/a/apple");
    assert.deepEqual(
      mentions.mentionsFor(html).map((c) => c.title),
      ["zebra", "apple"],
    );
  });

  it("**PR 的地址落在 /pull/ 上** —— issue 视图看不到 diff", () => {
    cache({
      key: "issue:a/b#9",
      kind: "pr",
      url: "https://github.com/a/b/pull/9",
      title: "a/b#9",
    });
    const got = mentions.mentionsFor(link("https://github.com/a/b/issues/9"));
    assert.equal(got[0].url, "https://github.com/a/b/pull/9");
    assert.equal(got[0].kind, "pr");
  });

  it("正文里没有 GitHub 链接时不查库", () => {
    assert.deepEqual(mentions.mentionsFor("<p>没有链接</p>"), []);
  });
});

describe("**补缓存：失败怎么记**", () => {
  const apiError = (status: number) => {
    const e = new Error(`GitHub 返回 ${status}`) as Error & { status: number };
    e.status = status;
    return e;
  };

  const rows = () => dbm.db.select().from(schema.githubFacts).all();

  it("问到了就写进去", async () => {
    const r = await mentions.fillMentionFacts([ref("https://github.com/a/b")], {
      fetcher: async () => ({ description: "说明", language: "Go", stargazers_count: 5 }),
    });
    assert.equal(r.written, 1);
    const [row] = rows();
    assert.equal(row.key, "repo:a/b");
    assert.equal(row.title, "a/b");
    assert.match(row.summary!, /Go/);
    assert.equal(row.gone, false);
  });

  it("**404 记成 gone**，下次不再问", async () => {
    await mentions.fillMentionFacts([ref("https://github.com/a/b")], {
      fetcher: async () => {
        throw apiError(404);
      },
    });
    assert.equal(rows()[0].gone, true);
    assert.deepEqual(mentions.unknownRefs([ref("https://github.com/a/b")]), []);
  });

  for (const [what, status] of [
    ["网络错误", 0],
    ["限流", 403],
    ["请求太多", 429],
    ["GitHub 挂了", 500],
  ] as const) {
    it(`**${what}：一行都不写** —— 写了就是永久放弃`, async () => {
      const r = await mentions.fillMentionFacts([ref("https://github.com/a/b")], {
        fetcher: async () => {
          throw apiError(status);
        },
      });
      assert.equal(r.failed, 1);
      assert.deepEqual(rows(), [], `${what} 被记下来了`);
      assert.equal(
        mentions.unknownRefs([ref("https://github.com/a/b")]).length,
        1,
        "下次不会再问了",
      );
    });
  }

  it("**限流之后当轮就停**", async () => {
    let calls = 0;
    const r = await mentions.fillMentionFacts(
      [
        ref("https://github.com/a/b1"),
        ref("https://github.com/a/b2"),
        ref("https://github.com/a/b3"),
      ],
      {
        fetcher: async () => {
          calls++;
          throw apiError(403);
        },
      },
    );
    assert.equal(calls, 1);
    assert.ok(r.notes.some((n) => n.includes("限流")));
  });

  it("普通失败不停 —— 一条坏的不该挡住后面的", async () => {
    let calls = 0;
    const r = await mentions.fillMentionFacts(
      [ref("https://github.com/a/bad"), ref("https://github.com/a/good")],
      {
        fetcher: async () => {
          calls++;
          if (calls === 1) throw apiError(500);
          return { description: "好的" };
        },
      },
    );
    assert.equal(r.written, 1);
    assert.equal(r.failed, 1);
  });

  it("**已经问过的不再问** —— 配额是按小时算的", () => {
    cache({ key: "repo:a/b" });
    assert.deepEqual(
      mentions.unknownRefs([ref("https://github.com/a/b"), ref("https://github.com/a/c")]),
      [ref("https://github.com/a/c")],
    );
  });

  it("**同一批里重复的只问一次**", () => {
    const same = [
      ref("https://github.com/a/b/issues/9"),
      ref("https://github.com/a/b/pull/9"),
    ];
    assert.equal(mentions.unknownRefs(same).length, 1);
  });

  it("commit / 代码链接不问 —— 问一趟拿不回更多", () => {
    const sha = "0".repeat(40);
    assert.deepEqual(
      mentions.unknownRefs([
        ref(`https://github.com/a/b/commit/${sha}`),
        ref(`https://github.com/a/b/blob/${sha}/x.ts`),
      ]),
      [],
    );
  });
});

describe("扫最近的帖子", () => {
  let n = 0;
  function addPost(html: string, table: "posts" | "replies" = "posts") {
    const id = `x_${++n}`;
    if (table === "posts") {
      dbm.db
        .insert(schema.posts)
        .values({
          id,
          boardId: "b1",
          authorId: "u1",
          title: "t",
          content: "c",
          contentHtml: html,
          createdAt: n,
        })
        .run();
    } else {
      dbm.db
        .insert(schema.replies)
        .values({
          id,
          postId: "x_1",
          authorId: "u1",
          floor: n,
          content: "c",
          contentHtml: html,
          createdAt: n,
        })
        .run();
    }
  }

  it("帖子和回复都扫", async () => {
    addPost(link("https://github.com/a/inpost"));
    addPost(link("https://github.com/a/inreply"), "replies");

    const asked: string[] = [];
    await mentions.fillRecentMentions({
      fetcher: async (p) => {
        asked.push(p);
        return { description: "x" };
      },
    });
    assert.deepEqual(asked.sort(), ["/repos/a/inpost", "/repos/a/inreply"]);
  });

  it("**已经在缓存里的不再问**", async () => {
    cache({ key: "repo:a/known" });
    addPost(link("https://github.com/a/known"));

    const asked: string[] = [];
    await mentions.fillRecentMentions({
      fetcher: async (p) => {
        asked.push(p);
        return {};
      },
    });
    assert.deepEqual(asked, []);
  });

  it("**一轮有上限** —— 配额按小时算，烧干了新帖子反而排最后", async () => {
    for (let i = 0; i < 30; i++) addPost(link(`https://github.com/a/r${i}`));
    const asked: string[] = [];
    await mentions.fillRecentMentions({
      refs: 3,
      fetcher: async (p) => {
        asked.push(p);
        return { description: "x" };
      },
    });
    assert.equal(asked.length, 3);
  });

  it("**先扫最新的** —— 有人正在读的是那些", async () => {
    addPost(link("https://github.com/a/old"));
    addPost(link("https://github.com/a/new"));

    const asked: string[] = [];
    await mentions.fillRecentMentions({
      refs: 1,
      fetcher: async (p) => {
        asked.push(p);
        return { description: "x" };
      },
    });
    assert.deepEqual(asked, ["/repos/a/new"]);
  });

  it("没有帖子时不出错", async () => {
    const r = await mentions.fillRecentMentions({ fetcher: async () => ({}) });
    assert.equal(r.asked, 0);
  });
});

describe("接线", () => {
  const read = (p: string) =>
    readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

  it("**帖子页真的渲染了它** —— 只测函数不测接线，等于测了个没人调用的东西", () => {
    const page = read("app/(app)/forum/p/[id]/page.tsx");
    assert.match(page, /mentionsFor\(post\.contentHtml\)/);
    assert.match(page, /<MentionCards cards=\{mentions\}/);
  });

  it("**排在正文之后** —— 读完了才补充，不打断阅读", () => {
    const page = read("app/(app)/forum/p/[id]/page.tsx");
    const body = page.indexOf("__html: post.contentHtml");
    const cards = page.indexOf("<MentionCards");
    assert.ok(body > 0 && cards > 0);
    assert.ok(cards > body, "卡片跑到正文前面去了");
  });

  it("**卡片链接带 nofollow** —— 这些地址是别人贴的，不替他们背书", () => {
    assert.match(read("components/github/MentionCards.tsx"), /nofollow/);
  });

  it("**类型有文字，不只有图标** —— 读屏念不出图标", () => {
    /*
     * 而「这是 PR 还是 issue」正是这张卡片最要紧的一件事。
     */
    const c = read("components/github/MentionCards.tsx");
    assert.match(c, /const LABELS = \{/);
    assert.match(c, /\{LABELS\[card\.kind\]\}/);
  });

  it("**标了出处** —— 这几行字不是作者写的", () => {
    assert.match(read("components/github/MentionCards.tsx"), /来自 GitHub/);
  });

  it("**没有卡片时整块不渲染** —— 不留一个空标题", () => {
    assert.match(
      read("components/github/MentionCards.tsx"),
      /cards\.length === 0\) return null/,
    );
  });

  it("**定时任务会补** —— 不然缓存永远是空的，卡片永远不出现", () => {
    const script = readFileSync(new URL("../scripts/links.ts", import.meta.url), "utf8");
    assert.match(script, /fillRecentMentions\(\)/);
  });
});
