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

  it("commit 要问 —— message 是链接上没有的那句话", () => {
    const sha = "0".repeat(40);
    assert.equal(mentions.unknownRefs([ref(`https://github.com/a/b/commit/${sha}`)]).length, 1);
  });

  it("**不带行号的代码链接不问** —— 截前 20 行是替作者选了一段他没选的代码", () => {
    const sha = "0".repeat(40);
    assert.deepEqual(mentions.unknownRefs([ref(`https://github.com/a/b/blob/${sha}/x.ts`)]), []);
    assert.equal(
      mentions.unknownRefs([ref(`https://github.com/a/b/blob/${sha}/x.ts#L2-L4`)]).length,
      1,
    );
  });
});

/**
 * commit 与代码永久链接的展开。
 *
 * ═════════════════════════════════════════
 * 这一块和别的卡片有一个关键不同
 * ═════════════════════════════════════════
 *
 * 它把内容**烤进库里**（高亮好的 HTML）。别的卡片不许这么干，
 * 因为 `★ 1.2k` 会变；而 sha 指向的代码不可能变 ——
 * 解析层只认带 40 位 sha 的链接，这一条正是那个限制换来的东西。
 */
describe("commit 与代码块展开", () => {
  const sha = "a".repeat(40);
  const rows = () => dbm.db.select().from(schema.githubFacts).all();
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const file = (text: string) => ({
    type: "file",
    encoding: "base64",
    size: Buffer.byteLength(text),
    content: b64(text),
  });

  it("commit 显示的是 message 的第一行", async () => {
    await mentions.fillMentionFacts([ref(`https://github.com/a/b/commit/${sha}`)], {
      fetcher: async () => ({ commit: { message: "修好了那个空指针\n\n详细说明……\nSigned-off-by: x" } }),
    });
    const [row] = rows();
    assert.equal(row.kind, "commit");
    assert.equal(row.title, `a/b@${sha.slice(0, 7)}`);
    assert.equal(row.summary, "修好了那个空指针");
    assert.equal(row.body, null);
  });

  it("**message 读不出来就整条不写** —— 只剩一个 sha 的卡片等于抄了一遍链接", async () => {
    const r = await mentions.fillMentionFacts([ref(`https://github.com/a/b/commit/${sha}`)], {
      fetcher: async () => ({ commit: {} }),
    });
    assert.equal(r.failed, 1);
    assert.deepEqual(rows(), []);
  });

  it("代码链接取到的是**作者圈的那几行**，不是整个文件", async () => {
    const text = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n");
    await mentions.fillMentionFacts([ref(`https://github.com/a/b/blob/${sha}/src/x.ts#L3-L5`)], {
      fetcher: async () => file(text),
    });
    const [row] = rows();
    assert.equal(row.kind, "code");
    assert.equal(row.title, "src/x.ts");
    assert.match(row.summary!, /第 3–5 行/);
    assert.match(row.body!, /line3/);
    assert.match(row.body!, /line5/);
    assert.equal(/line6/.test(row.body!), false, "多给了作者没圈的行");
    assert.equal(/line2/.test(row.body!), false, "多给了作者没圈的行");
  });

  it("**超出上限时说出来少给了多少** —— 不说的话读者会照着截断的代码讨论", async () => {
    const text = Array.from({ length: 300 }, (_, i) => `line${i + 1}`).join("\n");
    await mentions.fillMentionFacts([ref(`https://github.com/a/b/blob/${sha}/x.ts#L1-L100`)], {
      fetcher: async () => file(text),
    });
    assert.match(rows()[0].summary!, /还有 \d+ 行没展开/);
  });

  it("**高亮是烤好存进去的** —— 读的时候不再跑一次", async () => {
    await mentions.fillMentionFacts([ref(`https://github.com/a/b/blob/${sha}/x.ts#L1-L1`)], {
      fetcher: async () => file("const a = 1;"),
    });
    const body = rows()[0].body!;
    assert.match(body, /<pre/);
    // 双主题配色真的留下来了 —— 被消毒剥掉的话代码块是没有颜色的
    assert.match(body, /--shiki-light/);
  });

  it("代码里的尖括号被转义，不会当成标签", async () => {
    await mentions.fillMentionFacts([ref(`https://github.com/a/b/blob/${sha}/x.html#L1-L1`)], {
      fetcher: async () => file("<script>alert(1)</script>"),
    });
    const body = rows()[0].body!;
    assert.equal(/<script/.test(body), false, "脚本标签活着进了库");
    // 高亮器会把这一行切成好几个 span，所以尖括号和 script 不挨着 ——
    // 只断言尖括号被转义了，别去对整串
    assert.match(body, /&lt;/);
    assert.match(body, /&gt;/);
  });

  it("**消毒那一步还在** —— 它是纵深防御，行为上看不出来，所以只能钉源码", () => {
    /*
     * 上面那条测不到它：高亮器本来就把内容当文本转义，
     * 所以把 `sanitizeHtml(...)` 整个删掉，那条断言照样是绿的
     * （试过了）。一条测不出差别的断言比没有断言更糟 ——
     * 它让人以为这一块有人守着。
     *
     * 而这一步该留着：这段 HTML 的原料来自**别人的仓库**，
     * 比我们自己的输出更没有理由信任；而且「连我们自己生成的 HTML
     * 也要消毒」是 markdown 那条管线上写着的原则，不给任何东西开口子。
     *
     * 还要钉住它走的是**同一个** sanitizeHtml：另写一份白名单的话，
     * 哪天那边补了一条规则，这边不会跟着补。
     */
    const src = readFileSync(new URL("../src/lib/github/code-render.ts", import.meta.url), "utf8");
    assert.match(src, /import \{ sanitizeHtml \} from "@\/lib\/markdown"/);
    assert.match(src, /return sanitizeHtml\(/);
  });

  for (const [what, payload] of [
    ["目录（回来的是数组不是文件）", { type: "dir", encoding: "base64", size: 1, content: "eA==" }],
    ["太大的文件", { type: "file", encoding: "base64", size: 900_000, content: "eA==" }],
    ["GitHub 不给内容（1MB 以上）", { type: "file", encoding: "none", size: 10, content: "" }],
  ] as const) {
    it(`${what}：不展开，也不记成结论`, async () => {
      const r = await mentions.fillMentionFacts(
        [ref(`https://github.com/a/b/blob/${sha}/x#L1-L2`)],
        { fetcher: async () => payload as unknown as Record<string, unknown> },
      );
      assert.equal(r.failed, 1);
      assert.deepEqual(rows(), []);
    });
  }

  it("**二进制文件不展开** —— 一张 png 解成文本是一团乱码", async () => {
    const bin = "abc\u0000def";
    const r = await mentions.fillMentionFacts(
      [ref(`https://github.com/a/b/blob/${sha}/logo.png#L1-L2`)],
      { fetcher: async () => file(bin) },
    );
    assert.equal(r.failed, 1);
  });

  it("**一篇帖子里最多展开两段代码** —— 代码块的高度是别的卡片的十倍", async () => {
    const html = ["one", "two", "three"]
      .map((n) => link(`https://github.com/a/b/blob/${sha}/${n}.ts#L1-L1`))
      .join("");
    for (const n of ["one", "two", "three"]) {
      await mentions.fillMentionFacts([ref(`https://github.com/a/b/blob/${sha}/${n}.ts#L1-L1`)], {
        fetcher: async () => file("x"),
      });
    }
    assert.equal(mentions.mentionsFor(html).length, mentions.MAX_CODE_CARDS);
  });

  it("**取回来了但没有代码的那一行不显示** —— 半张卡片比没有更像坏了", () => {
    dbm.db
      .insert(schema.githubFacts)
      .values({
        key: `code:a/b@${sha}/x.ts#L1-L1`,
        kind: "code",
        url: `https://github.com/a/b/blob/${sha}/x.ts#L1-L1`,
        title: "x.ts",
        summary: "a/b · 第 1 行",
        body: null,
        checkedAt: 1,
        gone: false,
      })
      .run();
    assert.deepEqual(
      mentions.mentionsFor(link(`https://github.com/a/b/blob/${sha}/x.ts#L1-L1`)),
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
