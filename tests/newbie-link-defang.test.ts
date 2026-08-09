import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";

import {
  COMMON_TLDS,
  countExternalLinks,
  defangHtml,
  defangText,
  defangedAuthorHint,
  isExternalHref,
  isNewbie,
  newbieLinkNotice,
} from "@/lib/moderation/link-defang-rules";

/**
 * 新人外链：从「拦」改成「降权 + 说明」。
 *
 * ─────────────────────────────────────────
 * 被拦一次的人不会再发第二次
 * ─────────────────────────────────────────
 *
 * 以前注册不满 3 天的人发带链接的内容会被直接拒掉。拦截只教会人
 * 「这里不让说话」—— 而我们要挡的是广告号，不是第一天来的人。
 *
 * 现在内容照发，链接被拆成 `example[.]com` 这种点不动的形式，
 * 并且明确告诉他「满 3 天之后再发就不会这样了」。
 * 那句话是这条规则唯一有教育意义的部分。
 */

process.env.NEKOBOT_API_KEY = "nk_test";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

const SITE = { siteHosts: ["agenticlab.sh", "localhost"] };

describe("**降权，不是删除** —— 链接还看得见，只是点不动", () => {
  it("带 scheme 的链接：点和 :// 都被包起来", () => {
    const out = defangText("看看 https://spam.top/promo 这个", SITE).text;
    assert.match(out, /https\[:\/\/\]spam\[\.\]top/);
    // 路径不动 —— host 一拆整条就已经不可点了，再动路径只会让人看不懂原本是什么
    assert.match(out, /\/promo/);
  });

  it("**裸域名也要处理** —— 复制到地址栏一样能直达", () => {
    const out = defangText("加微信看 taobaoshop.xyz 有优惠", SITE).text;
    assert.match(out, /taobaoshop\[\.\]xyz/);
  });

  it("一段里有几个就处理几个", () => {
    assert.equal(countExternalLinks("http://a.com 和 b.net 还有 https://c.org", SITE), 3);
  });
});

describe("**误伤正常句子的代价比漏一个广告大**", () => {
  const untouched = [
    ["中文句子里的句号", "今天天气不错。我们去吃饭吧。"],
    ["版本号", "升级到 v1.2.3 之后就好了"],
    ["小数", "跑出来是 3.14 秒"],
    ["文件名", "把 a.png 和 report.pdf 传上去"],
    ["代码里的属性访问", "用 Object.keys(x) 拿到键，再看 user.id 和 res.data"],
    ["常见的正则调用", "regex.test(s) 返回 true"],
    ["文件后缀正好也是 TLD", "改一下 README.md、deploy.sh 和 main.rs"],
    ["邮箱不是可点的链接", "有事发 someone@example.com"],
    ["省略号和标点", "他说……然后就走了"],
  ] as const;

  for (const [name, text] of untouched) {
    it(`不碰${name}`, () => {
      const result = defangText(text, SITE);
      assert.equal(result.text, text, `${name} 被改坏了`);
      assert.equal(result.count, 0);
    });
  }

  it("**白名单里故意不放代码里高频的那些 TLD**", () => {
    /*
     * `.id` `.name` `.is` `.host` `.email` `.store` `.run` `.app` 都是真 TLD，
     * 但在一个技术社区里 `user.id`、`Object.is`、`location.host` 出现的次数
     * 比这些域名多几个数量级。漏掉用这些后缀的裸域名只是广告文字还在，
     * 误伤一次是把别人写的东西改坏了。
     */
    for (const tld of ["id", "name", "is", "host", "email", "store", "run", "app", "md", "sh"]) {
      assert.equal(COMMON_TLDS.has(tld), false, `${tld} 不该在白名单里`);
    }
  });
});

describe("**站内链接不是外链**", () => {
  it("指向本站的不处理", () => {
    const text = "见 https://agenticlab.sh/forum/p/123";
    assert.equal(defangText(text, SITE).text, text);
  });

  it("本站的子域名也不处理", () => {
    const text = "图在 https://cdn.agenticlab.sh/a.png";
    assert.equal(defangText(text, SITE).text, text);
  });

  it("相对路径、锚点、mailto 都不算外链", () => {
    for (const href of ["/forum/p/1", "#f3", "mailto:a@b.com"]) {
      assert.equal(isExternalHref(href, SITE.siteHosts), false, href);
    }
    assert.equal(isExternalHref("https://spam.top/", SITE.siteHosts), true);
  });
});

describe("**满了就不再处理** —— 这是那句承诺的兑现", () => {
  const DAY = 86_400_000;
  const NOW = 1_800_000_000_000;

  it("刚注册的算新人", () => {
    assert.equal(isNewbie(NOW - 1 * DAY, 3, NOW), true);
  });

  it("**满 3 天之后不算了**", () => {
    assert.equal(isNewbie(NOW - 4 * DAY, 3, NOW), false);
  });

  it("从来没绑过的按新人算 —— 那种账号恰恰是最该防的", () => {
    assert.equal(isNewbie(null, 3, NOW), true);
  });

  it("设成 0 就是整条规则关掉", () => {
    assert.equal(isNewbie(null, 0, NOW), false);
  });
});

describe("**改在渲染那一层，所以老帖子会自己好起来**", () => {
  it("外链的 a 标签整个换成文字 —— 留着标签就还是可点的", () => {
    const html = '<p>看 <a href="https://spam.top/x" rel="nofollow">这里</a></p>';
    const out = defangHtml(html, SITE).html;
    assert.equal(/<a\b/.test(out), false, "还留着 a 标签");
    assert.match(out, /https\[:\/\/\]spam\[\.\]top/);
    // 锚文字和网址不一样时两个都留下 —— 只剩「这里」的话读的人只会莫名其妙
    assert.match(out, /这里/);
  });

  it("锚文字就是网址本身时不重复一遍", () => {
    const html = '<p><a href="https://spam.top">https://spam.top</a></p>';
    const out = defangHtml(html, SITE).html;
    assert.equal((out.match(/spam\[\.\]top/g) ?? []).length, 1);
  });

  it("站内的 a 标签原样留着", () => {
    const html = '<p><a href="/u/abc">@某人</a></p>';
    assert.equal(defangHtml(html, SITE).html, html);
  });

  it("**代码块里的不动** —— 那里本来就点不动，改坏代码倒是真的", () => {
    const html = '<pre class="shiki"><code>fetch("https://api.example.com/v1")</code></pre>';
    assert.equal(defangHtml(html, SITE).html, html);
  });

  it("行内代码也不动", () => {
    const html = "<p>执行 <code>curl https://example.com</code> 就好</p>";
    assert.equal(defangHtml(html, SITE).html, html);
  });

  it("标签属性不碰 —— 碰了会把站内地址改坏", () => {
    const html = '<p><img src="/uploads/a.b.png" alt="x"> 见 evil.top</p>';
    const out = defangHtml(html, SITE).html;
    assert.match(out, /src="\/uploads\/a\.b\.png"/);
    assert.match(out, /evil\[\.\]top/);
  });

  it("不新增任何标签 —— 出去的东西还在消毒时那个允许清单里", () => {
    const html = '<p><a href="https://spam.top/x">点这里</a></p>';
    const out = defangHtml(html, SITE).html;
    const tags = [...out.matchAll(/<\/?([a-z]+)/gi)].map((m) => m[1].toLowerCase());
    assert.deepEqual([...new Set(tags)], ["p"]);
  });
});

describe("**那句给新人的话**", () => {
  const notice = newbieLinkNotice(3, "帖子");

  it("先说东西已经发出去了 —— 人最怕的是白写一场", () => {
    assert.match(notice, /^帖子已经发出来了/);
    // 绝不能读起来像「不让发」
    assert.equal(/不能发|不让发|被拦|禁止/.test(notice), false);
  });

  it("说清楚不是针对他", () => {
    assert.match(notice, /新号都这样/);
    assert.match(notice, /不是你/);
  });

  it("**给一个确定的时间点**，而且说明老帖子会自己恢复", () => {
    assert.match(notice, /满 3 天之后再发就不会了/);
    assert.match(notice, /自己恢复/);
  });

  it("天数是配置项，不写死", () => {
    assert.match(newbieLinkNotice(7, "回复"), /不满 7 天/);
    assert.match(newbieLinkNotice(7, "回复"), /^回复已经发出来了/);
  });

  it("作者回头看自己的帖子时也有一句解释 —— 否则只会以为站坏了", () => {
    assert.match(defangedAuthorHint(3), /满 3 天之后会自己恢复/);
    assert.match(defangedAuthorHint(3), /不用重发/);
  });
});

describe("接线", () => {
  it("**发帖和回帖都不再因为外链失败**", () => {
    const actions = strip(src("lib/forum/actions.ts"));
    assert.equal(/暂时不能发外链/.test(actions), false, "还留着拦截那句话");
    assert.equal(/violatesNewbieLinkRule/.test(actions), false, "还留着拦截那个函数");
    // 两条路都要把那句说明带回去
    assert.equal((actions.match(/newbieLinkNote\(/g) ?? []).length, 3, "发帖、回帖各一次 + 定义");
    assert.match(actions, /note: linkNote \?\? undefined/);
  });

  it("**降权在查询层做，不在写入层做** —— 库里存的是原文", () => {
    /*
     * 写入时拆的话，人满 3 天之后回头看，自己的链接永远是残废的 ——
     * 而那正是「再等等就好」这句承诺的反面。
     */
    const queries = strip(src("lib/forum/queries.ts"));
    assert.match(queries, /defangHtml\(/);
    // 两个 contentHtml 出口都要经过它
    assert.equal((queries.match(/defangFor\(/g) ?? []).length, 3, "单帖、楼层各一次 + 定义");

    const actions = strip(src("lib/forum/actions.ts"));
    assert.equal(/defangHtml/.test(actions), false, "写入层不该动内容");
  });

  it("时钟在查询层读 —— 渲染期读会被 React 编译器拦，拦得对", () => {
    const queries = strip(src("lib/forum/queries.ts"));
    assert.match(queries, /defangFor\(row\.post\.contentHtml, author\?\.firstBoundAt, Date\.now\(\)\)/);
    // 楼层用的是列表开头读的那一个 now，一屏之内口径一致
    assert.match(queries, /defangFor\(r\.contentHtml, author\?\.firstBoundAt, now\)/);
    assert.equal(/Date\.now\(\)/.test(strip(src("app/(app)/forum/p/[id]/page.tsx"))), false);
  });

  it("**那句解释只给作者自己看** —— 给别人看只是示众", () => {
    const page = strip(src("app/(app)/forum/p/[id]/page.tsx"));
    assert.match(page, /post\.linkNotice && user\?\.id === post\.authorId/);
    assert.match(page, /reply\.linkNotice && reply\.isMine/);
  });

  it("提交那一刻也要说一句 —— 两个入口都接上了", () => {
    assert.match(src("components/forum/ReplyForm.tsx"), /result\.note/);
    assert.match(src("components/forum/ComposeForm.tsx"), /result\.note/);
    // 发帖那条路会马上跳走，所以走 toast（Provider 在布局上，跳过去还在）
    assert.match(src("components/forum/ComposeForm.tsx"), /toast\.show\(\{ message: result\.note/);
  });

  it("**规则层是纯的** —— 外链处理天然就该是个纯函数", () => {
    const rules = src("lib/moderation/link-defang-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(rules.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });

  it("后台那个开关的说明也跟着改了 —— 否则管理员以为还在拦", () => {
    const defaults = src("lib/settings/defaults.ts");
    assert.equal(/新人多少天内不能发外链/.test(defaults), false);
    assert.match(defaults, /新人多少天内发外链会被降权/);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 真的渲染一遍：对着 markdown 管线的实际输出验
 * ─────────────────────────────────────────────────────────────── */

type MdModule = typeof import("@/lib/markdown");
let md: MdModule;

before(async () => {
  md = await import("@/lib/markdown");
});

describe("对着真实渲染结果（不是手写的 HTML）", () => {
  it("**渲染出来的可点链接一个都不剩**", async () => {
    const source = [
      "去 https://spam.top/promo 看看，或者 taobaoshop.xyz",
      "",
      "[点这里](https://evil.example/x) 有惊喜",
    ].join("\n");

    const rendered = await md.renderMarkdown(source);
    // 前提：管线确实把它变成了可点的
    assert.match(rendered.html, /<a[^>]+href="https:\/\/spam\.top/);

    const out = defangHtml(rendered.html, SITE).html;
    assert.equal(/href="https?:\/\//.test(out), false, "还留着可点的外链");
    assert.match(out, /spam\[\.\]top/);
    assert.match(out, /taobaoshop\[\.\]xyz/);
    assert.match(out, /evil\[\.\]example/);
  });

  it("站内链接和 @提及照常可点", async () => {
    const rendered = await md.renderMarkdown("看 @张三 说的", {
      resolveMention: (name) => (name === "张三" ? "u_1" : null),
    });
    const out = defangHtml(rendered.html, SITE).html;
    assert.match(out, /href="\/u\/u_1"/);
  });

  it("**代码块里的 URL 原样保留** —— 那是别人的代码", async () => {
    const rendered = await md.renderMarkdown('```js\nfetch("https://api.example.com/v1");\n```');
    const out = defangHtml(rendered.html, SITE).html;
    assert.match(out, /https:\/\/api\.example\.com\/v1/);
    assert.equal(/\[\.\]/.test(out), false, "代码被改坏了");
  });

  it("正常的中文帖子渲染完一个字都不变", async () => {
    const rendered = await md.renderMarkdown(
      "今天升级到 v1.2.3 了。改了 README.md，顺便把 user.id 的类型修了一下。",
    );
    const out = defangHtml(rendered.html, SITE);
    assert.equal(out.html, rendered.html);
    assert.equal(out.count, 0);
  });
});
