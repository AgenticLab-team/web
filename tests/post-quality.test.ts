import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { evaluateEligibility, type Rule } from "@/lib/activities/eligibility";
import { formatLeft, isUrgent, tickInterval } from "@/lib/activities/countdown";
import { MIN_POST_CHARS, judgePost, substantiveChars } from "@/lib/activities/post-quality";

/**
 * 「在论坛认真写一篇」这条并行门槛。
 *
 * ─────────────────────────────────────────
 * 为什么要有这条路
 * ─────────────────────────────────────────
 *
 * 域名活动原来只有一条门槛：群里 20 条高质量发言。
 * 那对**来得晚的人**是关死的 —— 20 条不是努力一下就能补上的，
 * 它需要时间，而活动不等人。
 *
 * ─────────────────────────────────────────
 * 判定必须偏向放行
 * ─────────────────────────────────────────
 *
 * 误判的两个方向不对称：
 *
 * · 放过一篇灌水 → 多发一个域名，代价是几十块钱
 * · 拦下一篇真心写的 → 一个人认真写了几百字被机器判成灌水，
 *   而且多半没有申诉的地方
 *
 * 所以这一组测试里，「不许误伤」的条数比「要拦住」的多。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

const REAL_POST = {
  title: "记一次接第三方接口的踩坑",
  content:
    "最近在给项目接一个第三方接口，文档写得很含糊，花了大半天才弄明白。\n\n" +
    "问题出在鉴权那一步：文档说传 token，实际上要传的是 base64 之后的 token 再拼一个时间戳。\n\n" +
    "后来是翻他们的 SDK 源码才看出来的。把过程记下来，免得后面有人再踩一遍。",
};

describe("算「实打实的正文」有多少字", () => {
  it("正常中文按字数算", () => {
    assert.equal(substantiveChars({ title: "", content: "一二三四五" }), 5);
  });

  it("**空白不算** —— 一百个换行不该顶一百个字", () => {
    assert.equal(substantiveChars({ title: "", content: "一\n\n\n二   三\t\t" }), 3);
  });

  it("**链接地址不算** —— 那不是写的字", () => {
    const withLinks = substantiveChars({
      title: "",
      content: "看这个 https://example.com/a/very/long/path?with=query&more=params 就懂了",
    });
    assert.ok(withLinks < 15, `链接被算进去了：${withLinks}`);
  });

  it("Markdown 链接保留文字、去掉地址", () => {
    const n = substantiveChars({ title: "", content: "[这是链接文字](https://example.com/xxxxxxxxxxxx)" });
    assert.equal(n, 6);
  });

  it("**代码块不算字数** —— 但也不扣分", () => {
    /*
     * 一篇「三百字讲解 + 一段代码」是这个社区最该鼓励的帖子。
     * 代码不计入门槛，但绝不能因为有代码就判成灌水。
     */
    const n = substantiveChars({ title: "", content: "说明\n```js\nconst a = 1;\nconsole.log(a);\n```" });
    assert.equal(n, 2);
  });

  it("标题算进去 —— 标题也是写的字", () => {
    assert.ok(substantiveChars({ title: "一个标题", content: "正文" }) > substantiveChars({ title: "", content: "正文" }));
  });
});

describe("**不许误伤认真写的帖子**", () => {
  it("一篇正常的经验帖过", () => {
    const v = judgePost(REAL_POST);
    assert.equal(v.ok, true, v.reason);
    assert.ok(v.chars >= MIN_POST_CHARS);
  });

  it("带代码块的技术帖过 —— 只要文字部分够", () => {
    const v = judgePost({
      title: REAL_POST.title,
      content: `${REAL_POST.content}\n\n\`\`\`ts\nconst token = btoa(raw) + Date.now();\n\`\`\``,
    });
    assert.equal(v.ok, true, v.reason);
  });

  it("带列表和小标题的过 —— Markdown 记号不该被算成灌水", () => {
    const v = judgePost({
      title: "整理一下这次的几个坑",
      content:
        "## 鉴权\n\n- 文档说传 token，实际要 base64 之后再拼时间戳\n" +
        "- 时间戳是秒不是毫秒，差三位数debug了一小时\n\n" +
        "## 分页\n\n- 页码从 1 开始，但返回里的 offset 是从 0 算的\n" +
        "- 最后一页的 has_more 永远是 true，得自己判长度\n\n" +
        "写下来给后面的人省点时间。",
    });
    assert.equal(v.ok, true, v.reason);
  });

  it("**引用别人的话之后接着写自己的，不算灌水**", () => {
    const v = judgePost({
      title: "关于上面那个问题",
      content:
        "> 文档说传 token，实际上要传 base64 之后的\n\n" +
        "补充一下，这个坑我也踩过，而且还有个更隐蔽的地方：他们的沙箱环境和生产环境的时间戳精度不一样，" +
        "沙箱用秒、生产用毫秒，同一份代码切过去就会一直报鉴权失败，而错误码是通用的 401，完全看不出来。",
    });
    assert.equal(v.ok, true, v.reason);
  });

  it("刚好到线就过，不多要一个字", () => {
    // 用一段真的有内容的话切到刚好 100 字 —— 一百个「字」字本身就是灌水
    const source =
      "今天试着把项目里那段处理时区的逻辑重写了一遍，原来的写法在跨月的时候会算错一天，" +
      "原因是先取了月份再做偏移，而偏移之后月份已经变了。换成先转成毫秒再统一处理就好了，" +
      "顺便把相关的几个测试补上，免得以后又有人改回去。";
    const exact = source.slice(0, MIN_POST_CHARS);
    const v = judgePost({ title: "", content: exact });
    assert.equal(v.chars, MIN_POST_CHARS);
    assert.equal(v.ok, true, v.reason);
  });

  it("**短就说短，不要说人在灌水**", () => {
    /*
     * 「支持一下」只有 4 个不同的字，撞得上防「啊啊啊」那条判据。
     * 先判长度再判灌水，这个人得到的才是他能照着改的那句话。
     */
    const v = judgePost({ title: "顶", content: "支持一下" });
    assert.equal(v.ok, false);
    assert.match(v.reason!, /还差/);
    assert.doesNotMatch(v.reason!, /灌水|反复出现/);
  });
});

describe("拦住明显在凑数的", () => {
  it("太短的拒，并说清楚还差多少", () => {
    const v = judgePost({ title: "顶", content: "支持一下" });
    assert.equal(v.ok, false);
    assert.match(v.reason!, /还差 \d+ 个字/);
    // 说清楚哪些不算，否则人会反复贴链接凑数然后困惑
    assert.match(v.reason!, /链接、代码块和空行不算/);
  });

  it("**整篇只有几个字反复出现** —— 「啊啊啊…」", () => {
    assert.equal(judgePost({ title: "顶", content: "啊".repeat(300) }).ok, false);
    assert.equal(judgePost({ title: "顶", content: "1234".repeat(100) }).ok, false);
  });

  it("**同一段复制粘贴很多遍**", () => {
    const v = judgePost({ title: "分享", content: "这是一段用来凑字数的内容\n".repeat(20) });
    assert.equal(v.ok, false);
    assert.match(v.reason!, /重复/);
  });

  it("一串链接凑长度不算写作", () => {
    const links = Array.from({ length: 30 }, (_, i) => `https://example.com/page/${i}`).join("\n");
    assert.equal(judgePost({ title: "收藏夹", content: links }).ok, false);
  });

  it("空的拒", () => {
    assert.equal(judgePost({ title: "", content: "   \n\n  " }).ok, false);
  });
});

describe("**阈值定得宽 —— 拿不准一律算过**", () => {
  it("不同字符 8 个就够 —— 一篇正常中文轻松过几十", () => {
    /*
     * 这条是防「啊啊啊啊」的，不是防「用词简单」的。
     * 定高了会误伤那种句式重复但内容真实的帖子（比如逐条报 bug）。
     */
    const simple = "好的收到明白谢谢辛苦了".repeat(12);
    assert.equal(judgePost({ title: "回复", content: simple }).ok, true, "误伤了用词简单但真的写了的");
  });

  it("重复行的阈值是三成 —— 逐条列表里句式重复不算灌水", () => {
    const listy = [
      "第一条：接口返回的时间戳是秒，而文档里写的是毫秒，差三位数",
      "第二条：分页的 offset 从 0 开始，但页码是从 1 开始的，很容易错位",
      "第三条：错误码全都是 401，看不出到底是哪一步失败的",
      "第四条：沙箱和生产的时间戳精度不一样，同一份代码切过去就挂",
      "第五条：文档上的示例请求少了一个必填头，照抄会一直 400",
    ].join("\n");
    const v = judgePost({ title: "几个坑", content: listy });
    assert.equal(v.ok, true, `${v.reason}（${v.chars} 字）`);
  });

  it("**判定里没有「内容好不好」这种判断**", () => {
    /*
     * 那不是机器该做的判断，做了也会做错。这里只回答两件事：
     * 够不够长、是不是明显在凑数。真正的把关在管理员那一侧。
     */
    const code = src("lib/activities/post-quality.ts");
    for (const forbidden of ["llm", "LLM", "chat(", "openai", "embedding"]) {
      assert.equal(code.includes(forbidden), false, `判定里引了 ${forbidden}`);
    }
  });

  it("规则层不碰数据库", () => {
    const code = src("lib/activities/post-quality.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(code.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});

describe("**两条路是「或」，谁先够谁算**", () => {
  const RELAXED: Rule = {
    any: [
      { metric: "quality_messages", op: ">=", value: 20 },
      { metric: "forum_quality_posts", op: ">=", value: 1, label: "论坛认真写的帖子" },
    ],
  };

  it("群里够了就行，一篇帖子没写也够格", () => {
    const r = evaluateEligibility(RELAXED, { quality_messages: 25, forum_quality_posts: 0 });
    assert.equal(r.eligible, true);
  });

  it("**群里不够但写了一篇 —— 也够格**", () => {
    const r = evaluateEligibility(RELAXED, { quality_messages: 3, forum_quality_posts: 1 });
    assert.equal(r.eligible, true);
  });

  it("两条都不够就是不够", () => {
    const r = evaluateEligibility(RELAXED, { quality_messages: 3, forum_quality_posts: 0 });
    assert.equal(r.eligible, false);
  });

  it("**两条路各自带进度，不折叠成一句话**", () => {
    /*
     * 折叠的话，人得在一行长句子里自己找哪条最接近 ——
     * 而那正是他唯一想知道的事。
     */
    const r = evaluateEligibility(RELAXED, { quality_messages: 12, forum_quality_posts: 0 });
    const branches = r.outcomes[0].anyOf;
    assert.ok(branches, "没带出各条路");
    assert.equal(branches!.length, 2);
    assert.equal(branches![0].current, 12);
    assert.equal(branches![0].target, 20);
    assert.equal(branches![1].current, 0);
    assert.equal(branches![1].target, 1);
  });

  it("差距取最近的那条路 —— 排序该按「离够格最近」算", () => {
    const r = evaluateEligibility(RELAXED, { quality_messages: 19, forum_quality_posts: 0 });
    assert.equal(r.outcomes[0].gap, 1);
  });

  it("「至多」这种规则不给进度条 —— 画出来是反的", () => {
    const capped: Rule = { metric: "forum_posts", op: "<=", value: 5 };
    const r = evaluateEligibility(capped, { forum_posts: 2 });
    assert.equal(r.outcomes[0].current, undefined);
  });
});

describe("界面", () => {
  it("进度条画的是 current / target", () => {
    const bars = src("components/activities/EligibilityBars.tsx");
    assert.match(bars, /outcome\.current! \/ outcome\.target!/);
    assert.match(bars, /role="progressbar"/);
  });

  it("**达标之后进度条留着** —— 撤掉的话人不知道自己要保持什么", () => {
    const bars = src("components/activities/EligibilityBars.tsx");
    // 没有「passed 就不渲染进度条」这种分支
    assert.doesNotMatch(bars, /outcome\.passed \?\s*null/);
  });

  it("名额进度和资格进度是两条 —— 「够不够格」和「抢不抢得到」不是一回事", () => {
    const page = src("app/(app)/activities/page.tsx");
    assert.match(page, /<QuotaBar/);
    assert.match(page, /<EligibilityBars/);
  });

  it("**没设截止时间就不显示倒计时** —— 挂一个空的比不挂更糟", () => {
    const page = src("app/(app)/activities/page.tsx");
    assert.match(page, /activity\.closesAt !== null && \(/);
  });

  it("倒计时不在服务端算 —— 首屏那个数字本来就是错的，还会 hydration 报错", () => {
    const c = src("components/activities/Countdown.tsx");
    assert.match(c, /useState<number \| null>\(null\)/);
  });

  it("**三天倒计时不跳秒** —— 那种紧迫感是假的", () => {
    assert.equal(tickInterval(3 * 86400_000), 60_000);
    assert.equal(tickInterval(30 * 60_000), 1000);
  });

  it("不到一天才变色", () => {
    assert.equal(isUrgent(2 * 86400_000), false);
    assert.equal(isUrgent(3 * 3600_000), true);
  });

  it("只说到有意义的那一位", () => {
    assert.equal(formatLeft(2 * 86400_000 + 3 * 3600_000 + 17 * 60_000), "2 天 3 小时");
    assert.equal(formatLeft(3 * 3600_000 + 17 * 60_000 + 4000), "3 小时 17 分");
    assert.equal(formatLeft(17 * 60_000 + 4000), "17 分 4 秒");
    assert.equal(formatLeft(4000), "4 秒");
  });
});
