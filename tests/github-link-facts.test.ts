import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  apiPathFor,
  clamp,
  commitLabel,
  issueFacts,
  issueLabel,
  langOf,
  pathLabel,
  repoFacts,
  repoLabel,
  shouldFetch,
  stars,
} from "@/lib/github/link-facts";
import { parseGithubUrl } from "@/lib/github/link-refs";
import { MAX_SUMMARY_CHARS, MAX_TITLE_CHARS } from "@/lib/links/enrich-rules";

/**
 * GitHub 的回答 → 资源库那两栏。
 *
 * ═════════════════════════════════════════
 * 这一层存在的理由：模型会编，GitHub 不会
 * ═════════════════════════════════════════
 *
 * 资源库原来靠模型从群里的只言片语猜「这条链接是什么」。
 * 对 GitHub 链接来说那是绕远路 —— 来源自己就会回答，而且权威。
 * 所以这里的每一条断言其实都在守同一件事：
 * **显示出来的东西必须和那条链接指的是同一个东西。**
 */

const ref = (u: string) => parseGithubUrl(u)!;
const REPO = ref("https://github.com/vercel/next.js");
const ISSUE = ref("https://github.com/vercel/next.js/issues/7");

describe("仓库", () => {
  it("标题是 owner/repo，简介带语言、star、说明", () => {
    const got = repoFacts(REPO, {
      full_name: "vercel/next.js",
      description: "The React Framework",
      language: "JavaScript",
      stargazers_count: 128_000,
    });
    assert.equal(got?.title, "vercel/next.js");
    assert.match(got!.summary!, /JavaScript/);
    assert.match(got!.summary!, /★ 128k/);
    assert.match(got!.summary!, /The React Framework/);
  });

  it("**标题以链接为准，不用接口回的 full_name**", () => {
    /*
     * 仓库改名之后 GitHub 会把老地址重定向到新名字，接口回的是新名，
     * 而帖子里那条链接写的是老名。用接口那份的话，卡片和链接对不上，
     * 读者会以为点过去是另一个东西。
     */
    const got = repoFacts(REPO, { full_name: "vercel/renamed-repo" });
    assert.equal(got?.title, "vercel/next.js");
  });

  it("**归档要说出来** —— 那是这条链接最要紧的一件事", () => {
    const got = repoFacts(REPO, { archived: true, description: "老项目" });
    assert.match(got!.summary!, /已归档/);
  });

  it("没归档就不提", () => {
    const got = repoFacts(REPO, { archived: false, description: "在维护" });
    assert.equal(got!.summary!.includes("已归档"), false);
  });

  it("什么都没有时简介为 null，不编一句", () => {
    assert.equal(repoFacts(REPO, {})?.summary, null);
  });

  it("只有 star 数也算一句", () => {
    assert.match(repoFacts(REPO, { stargazers_count: 3 })!.summary!, /★ 3/);
  });

  it("**字段类型不对当没有** —— 接口回什么都不该让我们崩", () => {
    const got = repoFacts(REPO, {
      description: 123,
      language: null,
      stargazers_count: "很多",
      archived: "true",
    });
    assert.equal(got?.title, "vercel/next.js");
    assert.equal(got?.summary, null, "把 'true' 当成了归档");
  });

  it("空白说明当没有", () => {
    assert.equal(repoFacts(REPO, { description: "   " })?.summary, null);
  });

  it("负数 star 不显示", () => {
    assert.equal(repoFacts(REPO, { stargazers_count: -5 })?.summary, null);
  });

  it("不是仓库的 ref 不处理", () => {
    assert.equal(repoFacts(ISSUE, { description: "x" }), null);
  });
});

describe("issue 与 PR", () => {
  it("issue", () => {
    const got = issueFacts(ISSUE, { title: "打不开", state: "open" });
    assert.equal(got?.title, "vercel/next.js#7");
    assert.match(got!.summary!, /issue·开着/);
    assert.match(got!.summary!, /打不开/);
  });

  it("**是不是 PR 以接口为准，不看链接写法**", () => {
    /*
     * `/issues/7` 和 `/pull/7` 指的是同一个号，两种写法都打得开 ——
     * 有人会把一个 PR 的地址写成 /issues/ 的形式。按写法认的话
     * 会把 PR 显示成 issue，而这两件事在讨论里不是一回事。
     */
    const got = issueFacts(ISSUE, { title: "修一下", state: "open", pull_request: {} });
    assert.match(got!.summary!, /PR·/);
  });

  it("**合并了说「已合并」，不说「已关闭」** —— 那是两回事", () => {
    const got = issueFacts(ISSUE, {
      title: "修一下",
      state: "closed",
      pull_request: {},
      merged_at: "2026-01-01T00:00:00Z",
    });
    assert.match(got!.summary!, /已合并/);
    assert.equal(got!.summary!.includes("已关闭"), false);
  });

  it("关掉但没合并的 PR 说「已关闭」", () => {
    const got = issueFacts(ISSUE, {
      title: "算了",
      state: "closed",
      pull_request: {},
      merged_at: null,
    });
    assert.match(got!.summary!, /已关闭/);
  });

  it("没有标题就不给事实 —— 宁可留给模型", () => {
    assert.equal(issueFacts(ISSUE, { state: "open" }), null);
  });

  it("不是 issue/PR 的 ref 不处理", () => {
    assert.equal(issueFacts(REPO, { title: "x" }), null);
  });
});

describe("**长度上限跟着资源库那两栏走**", () => {
  it("超长的仓库名和说明都截断", () => {
    const long = ref(`https://github.com/${"o".repeat(40)}/${"r".repeat(40)}`);
    const got = repoFacts(long, { description: "说明".repeat(200) });
    assert.ok([...got!.title].length <= MAX_TITLE_CHARS, "标题超了");
    assert.ok([...got!.summary!].length <= MAX_SUMMARY_CHARS, "简介超了");
  });

  it("**装不下时先丢 owner，不丢仓库名**", () => {
    /*
     * `facebookresearch/videoseal` 直接截会变成
     * `facebookresearch/videos…` —— 切掉的正好是识别它的那半个，
     * 剩下的 16 个字是一句谁都知道的废话。
     */
    const got = repoFacts(ref("https://github.com/facebookresearch/videoseal"), {});
    assert.equal(got?.title, "videoseal");
  });

  it("装得下就还是 owner/repo —— owner 是有用的语境", () => {
    assert.equal(repoLabel("a", "b"), "a/b");
  });

  it("仓库名自己就超长时才截它", () => {
    const got = repoLabel("owner", "r".repeat(40));
    assert.ok([...got].length <= MAX_TITLE_CHARS);
    assert.match(got, /^r+…$/);
  });

  it("issue 的也截断", () => {
    const long = ref(`https://github.com/${"o".repeat(30)}/${"r".repeat(30)}/issues/12345`);
    const got = issueFacts(long, { title: "标题".repeat(200), state: "open" });
    assert.ok([...got!.title].length <= MAX_TITLE_CHARS);
    assert.ok([...got!.summary!].length <= MAX_SUMMARY_CHARS);
  });

  it("**编号一个字都不能少** —— 截掉一位就是指向了另一个 issue", () => {
    /*
     * 线上真出过：`open-city-ai/haidian#1061` 有 25 个字，
     * 截出来是 `open-city-ai/haidian#10…` —— 读起来是 #10，
     * 而它其实是 #1061。
     *
     * 而且同一份列表里就摆着 `open-city-ai/haidian#840`，
     * 所以 `#10…` 看上去完全正常 —— 那个仓库里真有 10 号。
     * 这不是显示得不全，是**显示了一个错的编号**。
     */
    const got = issueFacts(ref("https://github.com/open-city-ai/haidian/issues/1061"), {
      title: "城市建设不能打表演赛",
      state: "open",
    });
    assert.match(got!.title, /#1061$/);
    assert.equal(got!.title.includes("…"), false);
  });

  for (const [what, owner, repo, n, want] of [
    ["装得下就全写", "a", "b", 1, "a/b#1"],
    ["装不下先丢 owner", "open-city-ai", "haidian", 1061, "haidian#1061"],
    ["仓库名自己就超长时截它，编号留着", "o", "r".repeat(40), 7, null],
  ] as const) {
    it(what, () => {
      const got = issueLabel(owner, repo, n);
      assert.ok([...got].length <= MAX_TITLE_CHARS, `超长了：${got}`);
      assert.match(got, new RegExp(`#${n}$`), `编号丢了：${got}`);
      if (want) assert.equal(got, want);
    });
  }

  it("**截断按码点，不按 UTF-16** —— 否则 emoji 被劈成半个「�」", () => {
    /*
     * 仓库简介里 emoji 很常见。用 slice 按码元切会留下半个代理对，
     * 而半个代理对在页面上就是一个替换字符。
     */
    const out = clamp("🎉".repeat(10), 5);
    assert.equal([...out].length, 5);
    assert.equal(out.includes("�"), false);
    assert.equal(/[\uD800-\uDFFF]/.test(out.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")), false);
  });

  it("没超就一个字都不动", () => {
    assert.equal(clamp("短", 10), "短");
  });

  it("**刚好顶到上限也不动** —— 差一个字就会白截一刀", () => {
    /*
     * 写成 `<` 的话，正好 24 个字的仓库名会被截成 23 个字加省略号：
     * 一条没有超限的标题被打上了「还有更多」的记号，
     * 而那个记号是假的 —— 后面什么都没有。
     */
    assert.equal(clamp("abcde", 5), "abcde");
    assert.equal(clamp("一二三四五", 5), "一二三四五");
  });

  it("截断了要看得出来", () => {
    assert.match(clamp("abcdefghij", 5), /…$/);
  });
});

describe("star 数的写法", () => {
  it("四位以下原样", () => {
    assert.equal(stars(0), "0");
    assert.equal(stars(999), "999");
  });

  it("上千折成 k", () => {
    assert.equal(stars(1000), "1k");
    assert.equal(stars(1250), "1.3k");
    assert.equal(stars(128_000), "128k");
  });
});

describe("该问哪个接口", () => {
  it("**PR 也走 /issues/** —— /pulls/ 对普通 issue 会 404", () => {
    /*
     * issue 接口对 PR 同样返回，并且带 pull_request 字段告诉我们
     * 它其实是个 PR。反过来 /pulls/{n} 遇到普通 issue 直接 404，
     * 于是 `/issues/12` 写法的 PR 链接会整条失败。
     */
    const pr = ref("https://github.com/a/b/pull/12");
    assert.equal(apiPathFor(pr), "/repos/a/b/issues/12");
    assert.equal(apiPathFor(ref("https://github.com/a/b/issues/12")), "/repos/a/b/issues/12");
  });

  it("仓库", () => {
    assert.equal(apiPathFor(REPO), "/repos/vercel/next.js");
  });

  it("**不带行号的代码链接不问** —— 替作者选一段他没选的代码，比不展开糟", () => {
    const sha = "0".repeat(40);
    const u = `https://github.com/a/b/blob/${sha}/x.ts`;
    assert.equal(shouldFetch(ref(u)), false);
    assert.equal(apiPathFor(ref(u)), null);
  });

  it("带行号的走 contents 接口，且**按 sha 取而不是按分支**", () => {
    const sha = "0".repeat(40);
    const path = apiPathFor(ref(`https://github.com/a/b/blob/${sha}/src/x.ts#L1-L2`));
    assert.equal(path, `/repos/a/b/contents/src/x.ts?ref=${sha}`);
  });

  it("**路径逐段编码，斜杠留着** —— 整条编掉就是在请求一个名字里带斜杠的文件", () => {
    const sha = "0".repeat(40);
    const path = apiPathFor(ref(`https://github.com/a/b/blob/${sha}/a b/c%23d.ts#L1`));
    assert.match(path!, /contents\/a%20b\/c%23d\.ts\?ref=/);
  });

  it("commit 走 commits 接口", () => {
    const sha = "0".repeat(40);
    assert.equal(
      apiPathFor(ref(`https://github.com/a/b/commit/${sha}`)),
      `/repos/a/b/commits/${sha}`,
    );
    assert.equal(shouldFetch(ref(`https://github.com/a/b/commit/${sha}`)), true);
  });

  it("仓库和 issue 要问", () => {
    assert.equal(shouldFetch(REPO), true);
    assert.equal(shouldFetch(ISSUE), true);
  });
});

describe("commit 和代码的标题：被截掉的必须是无关紧要的那半个", () => {
  const sha = "abcdef1234567890abcdef1234567890abcdef12";

  it("**短 sha 一个字都不能少** —— 截半截还像个合法 sha，但它指向别处", () => {
    const label = commitLabel("some-really-long-owner", "some-really-long-repo", sha, 24);
    assert.ok(label.endsWith(`@${sha.slice(0, 7)}`), label);
    assert.ok([...label].length <= 24, label);
  });

  it("装得下时一个字不改", () => {
    assert.equal(commitLabel("a", "b", sha), `a/b@${sha.slice(0, 7)}`);
  });

  it("**路径从左边截，留住文件名** —— 被切掉的不能是识别它的那半个", () => {
    const out = pathLabel("src/lib/github/very/deep/path/link-refs.ts", 20);
    assert.ok(out.endsWith("link-refs.ts"), out);
    assert.ok(out.startsWith("…"), out);
    assert.ok([...out].length <= 20, out);
  });

  it("装得下的路径原样", () => {
    assert.equal(pathLabel("x.ts"), "x.ts");
  });
});

describe("语言靠扩展名猜，猜不出退回纯文本", () => {
  it("常见的几种", () => {
    assert.equal(langOf("a/b/x.ts"), "ts");
    assert.equal(langOf("x.PY"), "python");
    assert.equal(langOf("Dockerfile"), "docker");
  });

  it("**认不出来不是错误** —— 没有颜色和整块不出现差着一个量级", () => {
    assert.equal(langOf("x.wat"), "text");
    assert.equal(langOf("LICENSE"), "text");
  });
});
