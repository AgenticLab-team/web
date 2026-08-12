import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MentionCards } from "@/components/github/MentionCards";
import type { MentionCard } from "@/lib/github/mentions";

/**
 * 「这篇提到的」那几张卡片 —— **真的把它渲染出来**再看。
 *
 * ═════════════════════════════════════════
 * 为什么不满足于扫源码里有没有那几个字符串
 * ═════════════════════════════════════════
 *
 * 这个仓库里有不少「读源文件断言它包含某段字符串」的测试，
 * 那种测试守得住「这一行别被删掉」，守不住**它到底渲染成了什么**：
 * 条件写反、属性放错元素、图标和文案对不上 —— 源码里那几个字符串
 * 一个不少，页面上却是错的。
 *
 * 这个组件是纯的（没有 hook、没有 async、不读库），
 * 所以可以直接渲染成 HTML 来看，代价几乎为零。
 */

/*
 * ═════════════════════════════════════════
 * 这个文件为什么在 tests/ui/ 而不是 tests/
 * ═════════════════════════════════════════
 *
 * 主测试跑在 `--conditions=react-server` 下，那个条件下
 * **`react-dom/server` 和 `lucide-react` 都 import 不进来**
 * （前者直接报「不支持」，后者拿不到 createContext）。
 *
 * 这就是为什么这个仓库里所有和组件有关的测试都只在读源码字符串 ——
 * 不是不想渲染，是那个跑法下根本渲染不了。
 *
 * 所以分出第二条跑法：`npm run test:ui`，不带那个条件。
 * `npm test` 两条都跑，而且有一条守卫盯着这件事不许被改回去
 * （见 tests/test-lanes.test.ts）—— 一条没人跑的测试等于没有。
 */
const render = async (node: unknown): Promise<string> => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(node as never);
};

const card = (over: Partial<MentionCard> = {}): MentionCard => ({
  key: "repo:vercel/next.js",
  kind: "repo",
  url: "https://github.com/vercel/next.js",
  title: "vercel/next.js",
  summary: "JavaScript · ★ 128k — The React Framework",
  body: null,
  ...over,
});

const html = (cards: MentionCard[]) => render(MentionCards({ cards }));

describe("渲染出来长什么样", () => {
  it("标题、简介、地址都在", async () => {
    const out = await html([card()]);
    assert.match(out, /vercel\/next\.js/);
    assert.match(out, /The React Framework/);
    assert.match(out, /href="https:\/\/github\.com\/vercel\/next\.js"/);
  });

  it("**PR 和 issue 的图标与文字不一样** —— 这两件事在讨论里不是一回事", async () => {
    const pr = await html([card({ kind: "pr", key: "issue:a/b#9", title: "a/b#9" })]);
    const issue = await html([card({ kind: "issue", key: "issue:a/b#9", title: "a/b#9" })]);
    assert.match(pr, /lucide-git-pull-request/);
    assert.match(issue, /lucide-circle-dot/);
    assert.match(pr, />PR</);
    assert.match(issue, />issue</);
  });

  it("**类型是文字，不是只有图标** —— 读屏念不出一个 svg", async () => {
    const out = await html([card()]);
    assert.match(out, />仓库</);
  });

  it("**图标对读屏隐藏** —— 不然每张卡片前面都会多念一串", async () => {
    const out = await html([card()]);
    assert.equal(/<svg(?![^>]*aria-hidden)/.test(out), false, "有 svg 没有 aria-hidden");
  });

  it("**外链三件套齐全**：nofollow / noopener / noreferrer", async () => {
    /*
     * nofollow —— 这些地址是别人贴的，不替他们背书权重。
     * noopener —— 不给对方页面拿到 window.opener。
     */
    const out = await html([card()]);
    assert.match(out, /rel="noopener noreferrer nofollow"/);
  });

  it("没有简介时不留一行空的", async () => {
    const out = await html([card({ summary: null })]);
    assert.match(out, /vercel\/next\.js/);
    assert.equal(/ink-secondary\]"><\/span>/.test(out), false, "渲染出了一个空的简介行");
  });

  it("**一张都没有时整块不渲染** —— 不留一个孤零零的标题", async () => {
    assert.equal(MentionCards({ cards: [] }), null);
    assert.equal(await html([]), "");
  });

  it("**标了出处** —— 这几行字不是作者写的，读者得知道", async () => {
    assert.match(await html([card()]), /来自 GitHub/);
  });

  it("多张时每张都有自己的 key，不会互相覆盖", async () => {
    const out = await html([
      card(),
      card({ key: "repo:a/b", url: "https://github.com/a/b", title: "a/b" }),
    ]);
    assert.equal((out.match(/<a /g) ?? []).length, 2);
  });

  it("**提交和代码的图标与文字也各不相同**", async () => {
    const commit = await html([card({ kind: "commit", title: "a/b@abc1234" })]);
    assert.match(commit, /lucide-git-commit-horizontal/);
    assert.match(commit, />提交</);
  });

  it("**代码那一段整块不是链接** —— 想复制两行的人不该一选中就跳走", async () => {
    const out = await html([
      card({ kind: "code", title: "src/x.ts", summary: "a/b · 第 1 行", body: "<pre>x</pre>" }),
    ]);
    // 只有顶上那行标题是 <a>
    assert.equal((out.match(/<a /g) ?? []).length, 1);
    assert.match(out, /<pre>x<\/pre>/);
  });

  it("**代码块自己横向滚，不让整页横滚** —— 页面能横拉的话手机上每次划动都会歪", async () => {
    const out = await html([card({ kind: "code", body: "<pre>x</pre>" })]);
    assert.match(out, /overflow-x-auto/);
  });

  it("**没有代码时不走代码那条渲染** —— 一个空 pre 是半张卡片", async () => {
    const out = await html([card({ kind: "code", title: "src/x.ts", body: null })]);
    assert.equal(/<pre/.test(out), false);
    // 退回成普通那一行，整块仍然是链接
    assert.match(out, /href=/);
  });

  it("**标题过长时截在样式层，不截字符串** —— 截了就搜不到了", async () => {
    /*
     * `truncate` 是 CSS 省略号：页面上一行放不下就收起来，
     * 而 DOM 里那串字是完整的 —— 浏览器搜索、复制、读屏都拿得到全文。
     */
    const out = await html([card({ title: "some-really-long-owner/some-really-long-repo" })]);
    assert.match(out, /truncate/);
    assert.match(out, /some-really-long-owner\/some-really-long-repo/);
  });
});
