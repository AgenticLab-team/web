import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

process.env.NEKOBOT_API_KEY = "nk_test";

type MdModule = typeof import("@/lib/markdown");
let md: MdModule;

/**
 * Markdown 渲染的安全测试。
 *
 * 论坛的正文是**用户可控且要展示给所有人**的内容 ——
 * 这里漏一个 XSS，等于把整个社区的会话拱手让人。
 *
 * 用允许清单而不是黑名单，所以测试的重点是：
 * 没在清单里的东西是不是真的都被剥掉了。
 */

before(async () => {
  md = await import("@/lib/markdown");
});

describe("HTML 消毒", () => {
  const cases: [string, string][] = [
    ["script 标签", "<script>alert(1)</script>"],
    ["img onerror", '<img src=x onerror="alert(1)">'],
    ["svg onload", '<svg onload="alert(1)"></svg>'],
    ["iframe", '<iframe src="https://evil.com"></iframe>'],
    ["form", '<form action="https://evil.com"><input name="p"></form>'],
    ["object", '<object data="evil.swf"></object>'],
    ["style 标签", "<style>body{display:none}</style>"],
    ["meta 跳转", '<meta http-equiv="refresh" content="0;url=https://evil.com">'],
    ["base 标签", '<base href="https://evil.com/">'],
    ["details onclick", '<details ontoggle="alert(1)"><summary>x</summary></details>'],
  ];

  for (const [name, payload] of cases) {
    it(`剥掉 ${name}`, () => {
      const out = md.sanitizeHtml(payload);
      assert.ok(!/<script/i.test(out), "不该留下 script");
      assert.ok(!/on\w+\s*=/i.test(out), `不该留下事件属性：${out}`);
      assert.ok(!/<iframe|<object|<embed|<form|<meta|<base/i.test(out), `残留危险标签：${out}`);
    });
  }

  it("javascript: 伪协议被拒绝", () => {
    const out = md.sanitizeHtml('<a href="javascript:alert(1)">点我</a>');
    assert.ok(!/javascript:/i.test(out), `残留伪协议：${out}`);
  });

  it("大小写与空白混淆也拦得住", () => {
    const out = md.sanitizeHtml('<a href="JaVaScRiPt&#58;alert(1)">x</a>');
    assert.ok(!/javascript/i.test(out.replace(/&#\d+;/g, "")), `绕过成功：${out}`);
  });

  it("data: 伪协议被拒绝", () => {
    const out = md.sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    assert.ok(!/data:text\/html/i.test(out), `残留 data 协议：${out}`);
  });

  it("保留正常的排版标签", () => {
    const out = md.sanitizeHtml(
      "<p><strong>粗</strong><em>斜</em><code>码</code></p><ul><li>项</li></ul>",
    );
    assert.ok(out.includes("<strong>"));
    assert.ok(out.includes("<em>"));
    assert.ok(out.includes("<code>"));
    assert.ok(out.includes("<li>"));
  });

  it("站外链接加上 noopener，切断反向控制", () => {
    const out = md.sanitizeHtml('<a href="https://example.com">外链</a>');
    assert.ok(out.includes('rel="noopener noreferrer nofollow ugc"'), out);
    assert.ok(out.includes('target="_blank"'), out);
  });

  it("站内链接不强开新窗口", () => {
    const out = md.sanitizeHtml('<a href="/forum/p/123">内链</a>');
    assert.ok(!out.includes('target="_blank"'), out);
  });

  it("危险的 style 被整条移除", () => {
    // 全放开 style 就能用 position:fixed 覆盖整页做钓鱼
    const out = md.sanitizeHtml('<span style="position:fixed;top:0;left:0;width:100vw">x</span>');
    assert.ok(!out.includes("position"), out);
  });

  it("shiki 用的配色 style 被保留", () => {
    const out = md.sanitizeHtml('<span style="color:#ff0000">红</span>');
    assert.ok(out.includes("color"), out);
  });

  it("style 里的 url() 被拒绝", () => {
    // background:url() 可以用来探测访问者是否加载了资源
    const out = md.sanitizeHtml('<span style="background-image:url(https://evil.com/t.png)">x</span>');
    assert.ok(!out.includes("url("), out);
  });
});

describe("Markdown 渲染", () => {
  it("基本语法正常", async () => {
    const { html } = await md.renderMarkdown("# 标题\n\n**粗体** 与 *斜体*");
    assert.ok(html.includes("<h1"));
    assert.ok(html.includes("<strong>"));
  });

  it("正文里的裸 HTML 不会被执行", async () => {
    const { html } = await md.renderMarkdown('普通文字 <img src=x onerror="alert(1)"> 后续');
    assert.ok(!/onerror/i.test(html), html);
  });

  it("代码块被高亮且内容不被当作 HTML", async () => {
    const { html } = await md.renderMarkdown('```html\n<script>alert(1)</script>\n```');
    // 代码内容必须以文本呈现，不能变成真的 script 标签
    assert.ok(!/<script>alert/i.test(html), `代码块内容被当成了 HTML：${html.slice(0, 200)}`);
    assert.ok(html.includes("<pre"), "应该渲染成 pre");
  });

  it("未知语言不会让整篇渲染失败", async () => {
    const { html } = await md.renderMarkdown("```这不是语言\nsome code\n```");
    assert.ok(html.includes("<pre"), html.slice(0, 120));
  });

  it("@提及能解析成链接", async () => {
    const { html, mentions } = await md.renderMarkdown("你好 @jmr 请看", {
      resolveMention: (name) => (name === "jmr" ? "user-1" : null),
    });
    assert.ok(html.includes("/u/user-1"), html);
    assert.deepEqual(mentions, ["user-1"]);
  });

  it("认不出的提及保持原样，不产生死链", async () => {
    const { html, mentions } = await md.renderMarkdown("@不存在的人 你好", {
      resolveMention: () => null,
    });
    assert.ok(html.includes("@不存在的人"), html);
    assert.deepEqual(mentions, []);
  });

  it("代码块里的 @ 不被当成提及", async () => {
    // 邮件地址、装饰器、注解里全是 @，误伤会很难看
    const { mentions } = await md.renderMarkdown("```py\n@decorator\ndef f(): pass\n```", {
      resolveMention: () => "user-1",
    });
    assert.deepEqual(mentions, [], "代码里的 @ 不该产生提及");
  });

  it("行内代码里的 @ 也不算提及", async () => {
    const { mentions } = await md.renderMarkdown("用 `@media` 查询", {
      resolveMention: () => "user-1",
    });
    assert.deepEqual(mentions, []);
  });

  it("同一个人被多次提及只算一次", async () => {
    const { mentions } = await md.renderMarkdown("@a 和 @a 还有 @a", {
      resolveMention: () => "user-1",
    });
    assert.deepEqual(mentions, ["user-1"]);
  });
});

describe("摘要生成", () => {
  it("剥掉标记只留文字", () => {
    assert.equal(md.makeExcerpt("# 标题\n\n**粗体**内容"), "标题 粗体内容");
  });

  it("代码块与图片替换成占位而不是原样塞进去", () => {
    assert.ok(md.makeExcerpt("看这个\n```js\nlet x=1\n```").includes("[代码]"));
    assert.ok(md.makeExcerpt("![截图](https://x/y.png)").includes("[图片]"));
  });

  it("链接只保留文字", () => {
    assert.equal(md.makeExcerpt("参见 [文档](https://example.com/very/long/url)"), "参见 文档");
  });

  it("超长内容截断并加省略号", () => {
    const out = md.makeExcerpt("啊".repeat(300), 50);
    assert.equal(out.length, 51);
    assert.ok(out.endsWith("…"));
  });
});
