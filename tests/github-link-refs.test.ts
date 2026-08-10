import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_MENTIONS,
  canonicalUrl,
  parseGithubUrl,
  refKey,
  refsInHtml,
} from "@/lib/github/link-refs";

/**
 * 认 GitHub 链接。
 *
 * ═════════════════════════════════════════
 * 这个文件的重心全在「不该认的」那一半
 * ═════════════════════════════════════════
 *
 * 认出来之后我们会给这条链接**盖上自己的章** —— 一张带 GitHub 图标、
 * 写着仓库名和 star 数的卡片。读者信的是这张卡片，不是那条链接。
 *
 * 所以放错一条的代价，比漏认一百条大得多：漏认只是少一张卡片，
 * 放错是我们亲手把一条钓鱼链接装扮成官方的样子。
 */

describe("正常认得出来", () => {
  it("仓库", () => {
    assert.deepEqual(parseGithubUrl("https://github.com/vercel/next.js"), {
      kind: "repo",
      owner: "vercel",
      repo: "next.js",
    });
  });

  it("issue 和 PR 分得开", () => {
    assert.deepEqual(parseGithubUrl("https://github.com/a/b/issues/12"), {
      kind: "issue",
      owner: "a",
      repo: "b",
      number: 12,
    });
    assert.deepEqual(parseGithubUrl("https://github.com/a/b/pull/12"), {
      kind: "pr",
      owner: "a",
      repo: "b",
      number: 12,
    });
  });

  it("提交", () => {
    const sha = "a".repeat(40);
    assert.deepEqual(parseGithubUrl(`https://github.com/a/b/commit/${sha}`), {
      kind: "commit",
      owner: "a",
      repo: "b",
      sha,
    });
  });

  it("代码永久链接带行号区间", () => {
    const sha = "0".repeat(40);
    assert.deepEqual(
      parseGithubUrl(`https://github.com/a/b/blob/${sha}/src/x.ts#L10-L20`),
      {
        kind: "code",
        owner: "a",
        repo: "b",
        sha,
        path: "src/x.ts",
        lines: { from: 10, to: 20 },
      },
    );
  });

  it("单行也认", () => {
    const sha = "0".repeat(40);
    const got = parseGithubUrl(`https://github.com/a/b/blob/${sha}/x.ts#L7`);
    assert.deepEqual(got && got.kind === "code" && got.lines, { from: 7, to: 7 });
  });

  it("clone 地址粘过来的 `.git` 指的是同一个仓库", () => {
    assert.deepEqual(parseGithubUrl("https://github.com/a/b.git"), {
      kind: "repo",
      owner: "a",
      repo: "b",
    });
  });

  it("查询串和末尾斜杠不影响判断", () => {
    assert.deepEqual(parseGithubUrl("https://github.com/a/b/?tab=readme#top"), {
      kind: "repo",
      owner: "a",
      repo: "b",
    });
  });
});

describe("**长得像 github.com 的一律不认**", () => {
  /*
   * 这三条是这个文件存在的第一理由。它们在人眼里都像官方域名，
   * 而我们一旦认了就会给它配一张我们自己做的卡片。
   */
  for (const [what, url] of [
    ["后缀挂了别的域", "https://github.com.evil.com/a/b"],
    ["路径里含 github.com", "https://evil.com/github.com/a/b"],
    ["userinfo 段伪装", "https://github.com@evil.com/a/b"],
    ["子域", "https://gist.github.com/a/b"],
    ["前缀粘上去", "https://notgithub.com/a/b"],
    ["同形近似", "https://githu6.com/a/b"],
  ] as const) {
    it(what, () => assert.equal(parseGithubUrl(url), null, `${url} 被认了`));
  }

  it("**http 不认** —— 中间人能改，而我们要拿它去请求", () => {
    assert.equal(parseGithubUrl("http://github.com/a/b"), null);
  });

  it("别的协议不认", () => {
    for (const u of [
      "javascript:alert(1)//github.com/a/b",
      "data:text/html,github.com/a/b",
      "ssh://git@github.com/a/b",
    ]) {
      assert.equal(parseGithubUrl(u), null, `${u} 被认了`);
    }
  });

  it("**带 userinfo 的正规域名也不认** —— 没有正当理由这么写", () => {
    assert.equal(parseGithubUrl("https://user@github.com/a/b"), null);
  });

  it("带端口不认", () => {
    assert.equal(parseGithubUrl("https://github.com:8443/a/b"), null);
  });

  it("大小写域名照样认得出是 github", () => {
    assert.deepEqual(parseGithubUrl("https://GitHub.COM/a/b"), {
      kind: "repo",
      owner: "a",
      repo: "b",
    });
  });
});

describe("**GitHub 自己占用的路径不是用户名**", () => {
  /*
   * 不排掉的话 `/features/actions` 会被当成「用户 features 的仓库
   * actions」，然后我们去请求一个不存在的仓库，拿回 404，
   * 再把这条链接降级成一张失败的卡片 —— 比不展开还糟。
   */
  for (const u of [
    "https://github.com/features/actions",
    "https://github.com/settings/profile",
    "https://github.com/topics/rust",
    "https://github.com/orgs/vercel",
    "https://github.com/search/x",
    "https://github.com/marketplace/actions",
  ]) {
    it(u, () => assert.equal(parseGithubUrl(u), null));
  }

  it("大小写也要挡住", () => {
    assert.equal(parseGithubUrl("https://github.com/Settings/x"), null);
  });
});

describe("**代码链接只认带 sha 的**", () => {
  it("分支名不认 —— 内容会在帖子底下悄悄变", () => {
    /*
     * 讨论停在旧代码上，而读者完全看不出发生过什么。
     * 这不是「稍微不准」，是把一段引用变成了一段会被改写的引用。
     */
    assert.equal(parseGithubUrl("https://github.com/a/b/blob/main/x.ts#L1"), null);
  });

  it("短 sha 也不认 —— 它不保证唯一", () => {
    assert.equal(parseGithubUrl("https://github.com/a/b/blob/abc1234/x.ts"), null);
  });

  it("大写 sha 不认 —— GitHub 自己产出的永久链接是小写", () => {
    assert.equal(parseGithubUrl(`https://github.com/a/b/blob/${"A".repeat(40)}/x.ts`), null);
  });

  it("没有文件路径不认", () => {
    assert.equal(parseGithubUrl(`https://github.com/a/b/blob/${"0".repeat(40)}`), null);
  });

  it("**看不懂的行号当没写**，而不是整条不认", () => {
    const sha = "0".repeat(40);
    const got = parseGithubUrl(`https://github.com/a/b/blob/${sha}/x.ts#Lfoo`);
    assert.deepEqual(got && got.kind === "code" && got.lines, null);
  });

  it("倒着写的区间不认", () => {
    const sha = "0".repeat(40);
    const got = parseGithubUrl(`https://github.com/a/b/blob/${sha}/x.ts#L20-L10`);
    assert.deepEqual(got && got.kind === "code" && got.lines, null);
  });

  it("行号 0 不认 —— 行号从 1 起", () => {
    const sha = "0".repeat(40);
    const got = parseGithubUrl(`https://github.com/a/b/blob/${sha}/x.ts#L0`);
    assert.deepEqual(got && got.kind === "code" && got.lines, null);
  });
});

describe("编号和名字的边界", () => {
  it("0 号和负数不认", () => {
    assert.equal(parseGithubUrl("https://github.com/a/b/issues/0"), null);
    assert.equal(parseGithubUrl("https://github.com/a/b/issues/-1"), null);
  });

  it("非数字编号不认", () => {
    assert.equal(parseGithubUrl("https://github.com/a/b/issues/1a"), null);
    assert.equal(parseGithubUrl("https://github.com/a/b/issues/1e3"), null);
  });

  it("名字里有斜杠或空格不认", () => {
    assert.equal(parseGithubUrl("https://github.com/a%2Fb/c"), null);
    assert.equal(parseGithubUrl("https://github.com/a%20b/c"), null);
  });

  it("名字不能以点或横杠开头", () => {
    assert.equal(parseGithubUrl("https://github.com/.a/b"), null);
    assert.equal(parseGithubUrl("https://github.com/-a/b"), null);
  });

  it("认不出的形状返回 null，不猜", () => {
    for (const u of [
      "https://github.com/a",
      "https://github.com/a/b/tree/main",
      "https://github.com/a/b/releases/tag/v1",
      "https://github.com/a/b/actions/runs/1",
      "https://github.com/a/b/issues",
      "not a url",
    ]) {
      assert.equal(parseGithubUrl(u), null, `${u} 被认了`);
    }
  });
});

describe("缓存键", () => {
  it("**issue 和 PR 共用一个键** —— 编号空间本来就是同一个", () => {
    /*
     * 同一个号既能用 /issues/ 也能用 /pull/ 打开。分两个键的结果是
     * 同一件东西抓两遍、缓存两份，而同一篇帖子里出现两种写法时，
     * 读者会看到两张自相矛盾的卡片。
     */
    const a = parseGithubUrl("https://github.com/a/b/issues/9")!;
    const b = parseGithubUrl("https://github.com/a/b/pull/9")!;
    assert.equal(refKey(a), refKey(b));
  });

  it("不同东西的键不撞", () => {
    const sha = "0".repeat(40);
    const keys = [
      "https://github.com/a/b",
      "https://github.com/a/b/issues/1",
      "https://github.com/a/b/issues/2",
      `https://github.com/a/b/commit/${sha}`,
      `https://github.com/a/b/blob/${sha}/x.ts`,
      `https://github.com/a/b/blob/${sha}/x.ts#L1-L2`,
      "https://github.com/a/c",
    ].map((u) => refKey(parseGithubUrl(u)!));
    assert.equal(new Set(keys).size, keys.length, "有两条不同的链接算出了同一个键");
  });
});

describe("规范化地址", () => {
  it("**issue 和 PR 的键一样，但地址不能一样**", () => {
    /*
     * 键相同是因为编号空间相同；而点过去要落在对的那一页上。
     * 两者都用 /issues/ 的话，一个 PR 的卡片会把人带到 issue 视图 ——
     * 看不到 diff，也看不到评审。
     */
    const pr = parseGithubUrl("https://github.com/a/b/pull/9")!;
    const issue = parseGithubUrl("https://github.com/a/b/issues/9")!;
    assert.equal(canonicalUrl(pr), "https://github.com/a/b/pull/9");
    assert.equal(canonicalUrl(issue), "https://github.com/a/b/issues/9");
  });

  it("每一种都回得去", () => {
    const sha = "0".repeat(40);
    for (const u of [
      "https://github.com/a/b",
      "https://github.com/a/b/issues/1",
      "https://github.com/a/b/pull/2",
      `https://github.com/a/b/commit/${sha}`,
      `https://github.com/a/b/blob/${sha}/src/x.ts`,
      `https://github.com/a/b/blob/${sha}/src/x.ts#L1-L2`,
    ]) {
      assert.equal(canonicalUrl(parseGithubUrl(u)!), u, `${u} 转不回去`);
    }
  });

  it("**规范化过的地址还能再解析一次** —— 不然缓存和链接会错位", () => {
    const ref = parseGithubUrl("https://github.com/a/b.git")!;
    const back = parseGithubUrl(canonicalUrl(ref))!;
    assert.equal(refKey(back), refKey(ref));
  });
});

describe("从正文 HTML 里捞", () => {
  it("捞得出来", () => {
    const html = '<p>看这个 <a href="https://github.com/a/b">a/b</a></p>';
    assert.deepEqual(refsInHtml(html), [{ kind: "repo", owner: "a", repo: "b" }]);
  });

  it("**同一个东西只算一次** —— 贴两遍不该出两张卡", () => {
    const html =
      '<a href="https://github.com/a/b">x</a><a href="https://github.com/a/b/">y</a>';
    assert.equal(refsInHtml(html).length, 1);
  });

  it("issue 和 PR 两种写法也只算一次", () => {
    const html =
      '<a href="https://github.com/a/b/issues/9">x</a><a href="https://github.com/a/b/pull/9">y</a>';
    assert.equal(refsInHtml(html).length, 1);
  });

  it("不是 GitHub 的链接不捞", () => {
    assert.deepEqual(refsInHtml('<a href="https://example.com/a/b">x</a>'), []);
  });

  it("**长得像的也不捞** —— 这一层同样不能成为绕过口", () => {
    assert.deepEqual(refsInHtml('<a href="https://github.com.evil.com/a/b">x</a>'), []);
  });

  it("**`&amp;` 要还原** —— 不还原的话带查询串的地址解析出来是错的", () => {
    const html = '<a href="https://github.com/a/b?x=1&amp;y=2">x</a>';
    assert.deepEqual(refsInHtml(html), [{ kind: "repo", owner: "a", repo: "b" }]);
  });

  it("**有上限** —— 三十张卡片跟在帖子底下就不是帖子了", () => {
    const html = Array.from(
      { length: 30 },
      (_, i) => `<a href="https://github.com/a/r${i}">x</a>`,
    ).join("");
    assert.equal(refsInHtml(html).length, MAX_MENTIONS);
  });

  it("**超了取前几条，不是一张都不给** —— 一张都不给读者会以为漏了", () => {
    const html = Array.from(
      { length: 10 },
      (_, i) => `<a href="https://github.com/a/r${i}">x</a>`,
    ).join("");
    const got = refsInHtml(html);
    assert.ok(got.length > 0);
    assert.equal(got[0].kind === "repo" && got[0].repo, "r0", "取的不是最前面那几条");
  });

  it("空正文不出错", () => {
    assert.deepEqual(refsInHtml(""), []);
  });
});
