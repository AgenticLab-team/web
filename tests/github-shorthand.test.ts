import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRepoRef, parseShorthand, repoRefKey } from "@/lib/github/link-refs";
import { MAX_SHORTHAND_LINKS, linkifyGithubShorthand } from "@/lib/github/shorthand";

import { forumWritePath, readCode, stripComments } from "./_source";

/**
 * `owner/repo#123` 自动成链。
 *
 * ═════════════════════════════════════════
 * 这个文件的重心同样在「不该认的」那一半
 * ═════════════════════════════════════════
 *
 * 认错一条的后果不是少一个链接，是**在别人的正文里插进一条
 * 指向陌生仓库的链接**，而落款是这个站。不认的后果只是那几个字
 * 保持原样 —— 读者什么都没少。两边的代价差着一个量级。
 */

const link = (text: string) => linkifyGithubShorthand(text);

describe("认得出来的那一半", () => {
  it("最普通的写法", () => {
    assert.equal(
      link("见 vercel/next.js#123 那条"),
      "见 [vercel/next.js#123](https://github.com/vercel/next.js/issues/123) 那条",
    );
  });

  it("中文里紧挨着汉字也认 —— 中文正文本来就不带空格", () => {
    assert.match(link("我看了a/b#7这条"), /\[a\/b#7\]/);
  });

  it("中文标点和中文括号里照常认", () => {
    assert.match(link("（a/b#7）"), /\[a\/b#7\]/);
    assert.match(link("修了 a/b#7。"), /\[a\/b#7\]/);
    assert.match(link("修了 a/b#7，还有别的"), /\[a\/b#7\]/);
  });

  it("**链到 /issues/ 而不是 /pull/** —— GitHub 那边 issues 打得开 PR，反过来不行", () => {
    assert.match(link("a/b#7"), /https:\/\/github\.com\/a\/b\/issues\/7/);
  });

  it("**链接文字是作者写的那串，一个字不改** —— 显示的和指向的必须是同一件东西", () => {
    // 大小写不归一：正文上出现一个作者没写过的仓库名，他自己都认不出
    assert.match(link("Vercel/Next.js#1"), /\[Vercel\/Next\.js#1\]/);
  });
});

describe("**裸 #123 一条都不认** —— 它更可能是标签或楼层", () => {
  it("单独的 #123", () => {
    assert.equal(link("回复 #123 那位"), "回复 #123 那位");
  });

  it("只有仓库名没有 owner", () => {
    assert.equal(link("next.js#123"), "next.js#123");
  });
});

describe("**长得像但不是**的那些，一条都不许改", () => {
  it("github.com 地址里的那一段", () => {
    const url = "https://github.com/a/b#123";
    assert.equal(link(url), url);
  });

  it("**别人域名里的那一段** —— 认了就等于把作者的链接换成另一件东西", () => {
    const url = "https://evil.com/a/b#123";
    assert.equal(link(url), url);
  });

  it("markdown 链接的目标（前面是 `(`）", () => {
    const src = "[看这个](a/b#1)";
    assert.equal(link(src), src);
  });

  it("已经是链接文字了（前面是 `[`）", () => {
    const src = "[a/b#1](https://example.com)";
    assert.equal(link(src), src);
  });

  it("包名 / scope 那种 `@` 开头的", () => {
    assert.equal(link("foo@a/b#1"), "foo@a/b#1");
  });

  it("路径中间的一段（前面是 `/`）", () => {
    assert.equal(link("src/a/b#1"), "src/a/b#1");
  });

  it("编号后面还粘着东西", () => {
    assert.equal(link("a/b#12a"), "a/b#12a");
    assert.equal(link("a/b#12-3"), "a/b#12-3");
    // 版本号，不是编号
    assert.equal(link("a/b#1.2"), "a/b#1.2");
  });
});

describe("编号本身的坑", () => {
  it("**前导零不认** —— 屏幕上写着 #0123、点过去是 #123 就是显示了个错的东西", () => {
    assert.equal(link("a/b#0123"), "a/b#0123");
    assert.equal(parseShorthand("a", "b", "0123"), null);
  });

  it("#0 不认", () => {
    assert.equal(link("a/b#0"), "a/b#0");
  });

  it("**科学计数法不认** —— Number(\"1e3\") 是 1000", () => {
    // 正则本来就只放数字进来，这一条钉住的是「以后别改成 Number() 判」
    assert.equal(parseShorthand("a", "b", "1e3"), null);
    assert.equal(link("a/b#1e3"), "a/b#1e3");
  });

  it("大到超出安全整数的不认", () => {
    assert.equal(parseShorthand("a", "b", "9".repeat(30)), null);
  });
});

describe("GitHub 自己占着的一级路径不是用户名", () => {
  it("features/actions#1 不认", () => {
    assert.equal(link("features/actions#1"), "features/actions#1");
    assert.equal(parseShorthand("features", "actions", "1"), null);
  });

  it("大小写变一下也不认", () => {
    assert.equal(parseShorthand("Features", "actions", "1"), null);
  });
});

describe("一段里改写的条数有上限", () => {
  it("超过上限之后原样留着 —— 一整段蓝字反而没人读", () => {
    const many = Array.from({ length: MAX_SHORTHAND_LINKS + 3 }, (_, i) => `a/b#${i + 1}`).join(" ");
    const out = link(many);
    assert.equal((out.match(/\]\(https:/g) ?? []).length, MAX_SHORTHAND_LINKS);
    // 没被改写的那几条一个字都没少
    assert.match(out, new RegExp(`a/b#${MAX_SHORTHAND_LINKS + 3}(?!\\])`));
  });
});

describe("parseRepoRef：帖子关联项目时认的那个形状", () => {
  it("owner/repo", () => {
    assert.deepEqual(parseRepoRef("vercel/next.js"), { owner: "vercel", repo: "next.js" });
  });

  it("**归一到小写** —— GitHub 那边大小写不是身份，不归一同一个项目会裂成两页", () => {
    assert.equal(repoRefKey(parseRepoRef("Textualize/Rich")!), "textualize/rich");
    assert.equal(repoRefKey(parseRepoRef("textualize/rich")!), "textualize/rich");
  });

  it("整条地址也收（人更习惯直接粘地址）", () => {
    assert.equal(repoRefKey(parseRepoRef("https://github.com/a/b")!), "a/b");
    assert.equal(repoRefKey(parseRepoRef("https://github.com/a/b/issues/3")!), "a/b");
    assert.equal(repoRefKey(parseRepoRef("github.com/a/b")!), "a/b");
    assert.equal(repoRefKey(parseRepoRef("a/b.git")!), "a/b");
  });

  it("**别的域名一律不认** —— 关联出来的项目页会挂在 github.com/… 上", () => {
    assert.equal(parseRepoRef("https://evil.com/a/b"), null);
    assert.equal(parseRepoRef("https://github.com.evil.com/a/b"), null);
  });

  it("形状不对的不认", () => {
    assert.equal(parseRepoRef(""), null);
    assert.equal(parseRepoRef("just-a-name"), null);
    assert.equal(parseRepoRef("a/b/c"), null);
    assert.equal(parseRepoRef("features/actions"), null);
    assert.equal(parseRepoRef("-bad/repo"), null);
  });
});

/**
 * 这条简写要真的接在渲染管线上。
 *
 * ─────────────────────────────────────────
 * 「函数写好了但没人调」是这个仓库最常见的失败
 * ─────────────────────────────────────────
 *
 * 上面那一堆断言全部作用在一个纯函数上 —— 把
 * `linkifyGithubShorthand(...)` 那一行从 markdown.ts 里删掉，
 * 它们**一条都不会红**，而站上一条简写也不会成链。
 */
describe("接线", () => {
  const md = readCode("lib/markdown.ts");

  it("markdown 管线真的调了它", () => {
    assert.match(md, /linkifyGithubShorthand\(/);
  });

  it("**跑在代码块被摘出去之后** —— 否则代码里的路径会被误伤", () => {
    /*
     * 顺序错了的表现很安静：代码块里的 `a/b#1` 变成一条链接，
     * 而那一段本来是要原样展示的。
     */
    assert.ok(
      md.indexOf("const withoutCode") < md.indexOf("linkifyGithubShorthand("),
      "简写改写跑在了摘代码块之前",
    );
  });

  it("**跑在 marked 解析之前** —— 产出的链接要走同一套消毒和 rel", () => {
    assert.ok(
      md.indexOf("linkifyGithubShorthand(") < md.indexOf("marked.parse"),
      "简写改写跑在了 markdown 解析之后",
    );
  });
});

/**
 * 帖子关联项目：**存进库的必须是清洗过的**。
 *
 * 不清洗的话这一列就是一个任意字符串写入口 —— 而它会被拼进
 * 项目页的地址、显示在帖子上。清洗那一处同时也是拒绝
 * `github.com.evil.com` 的地方（安全边界只有 link-refs.ts 一个文件）。
 */
describe("发帖关联项目那条路", () => {
  const write = stripComments(forumWritePath());

  it("落库前过了 parseRepoRef", () => {
    assert.match(write, /parseRepoRef\(input\.repoRef\)/);
  });

  it("**绝不把原始输入直接写进那一列**", () => {
    assert.equal(
      /repoRef:\s*input\.repoRef/.test(write),
      false,
      "前端传什么就存什么了",
    );
  });

  it("认不出来时存 null，而不是拦下整篇帖子", () => {
    // 为一个可选的补充字段把写好的帖子挡回去，是让次要的决定主要的
    assert.match(write, /repoRef: repoLink \? repoRefKey\(repoLink\) : null/);
  });
});
