import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  MAX_SUMMARY_CHARS,
  MAX_TITLE_CHARS,
  SYSTEM_PROMPT,
  buildEnrichPrompt,
  hasEnoughContext,
  needsEnrichment,
  parseEnrichResponse,
} from "@/lib/links/enrich-rules";
import { stripComments as strip } from "./_source";

/**
 * 用大模型给资源库补标题和简介。
 *
 * ─────────────────────────────────────────
 * 这一组测试几乎全在测「不许编」
 * ─────────────────────────────────────────
 *
 * links.ts 里那句注释写着「抓不到就留空，**不编**」。
 * 接上大模型之后这条更要紧，因为模型编出来的东西**读起来是通顺的**：
 * 一个语气笃定、格式工整、内容却是猜的简介，
 * 比一行域名危险得多 —— 域名至少诚实地说明「我们不知道这是什么」。
 */

const ctx = "群里前后的对话：\n甲：这个能查台风\n乙：收藏了";

describe("解析模型的回复", () => {
  it("正常的 JSON", () => {
    const out = parseEnrichResponse('{"known":true,"title":"台风实时路径","summary":"中央气象台的台风路径查询页"}', ctx);
    assert.equal(out.kind, "known");
    if (out.kind !== "known") return;
    assert.equal(out.title, "台风实时路径");
  });

  it("**裹了代码块围栏也要能读** —— 推理模型经常这么干", () => {
    /*
     * 直接 JSON.parse 会全军覆没，而全军覆没会被误读成「模型不可用」——
     * 实际上只是外面多了两个反引号。
     */
    const out = parseEnrichResponse(
      '```json\n{"known":true,"title":"台风路径","summary":"查台风的"}\n```',
      ctx,
    );
    assert.equal(out.kind, "known");
  });

  it("前后带了一句废话也要能读", () => {
    const out = parseEnrichResponse(
      '好的，这是结果：{"known":true,"title":"台风路径","summary":"查台风的"} 希望有帮助',
      ctx,
    );
    assert.equal(out.kind, "known");
  });

  it("**说不知道是正常结果，不是失败**", () => {
    const out = parseEnrichResponse('{"known":false}', ctx);
    assert.equal(out.kind, "unknown");
  });

  it("说知道但没给标题 —— 当成不知道，不要写半截进库", () => {
    const out = parseEnrichResponse('{"known":true,"summary":"某个网站"}', ctx);
    assert.equal(out.kind, "unknown");
  });

  it("**完全读不出 JSON 是故障，要和「不知道」分开** —— 一个要重试，一个不要", () => {
    const out = parseEnrichResponse("我觉得这个链接可能是一个天气网站。", ctx);
    assert.equal(out.kind, "unparsable");
  });

  it("空回复算故障", () => {
    assert.equal(parseEnrichResponse("", ctx).kind, "unparsable");
  });

  it("坏掉的 JSON 算故障", () => {
    assert.equal(parseEnrichResponse('{"known":true,"title":', ctx).kind, "unparsable");
  });

  it("太长的标题和简介截断，不整条丢掉", () => {
    const out = parseEnrichResponse(
      JSON.stringify({ known: true, title: "标".repeat(60), summary: "简".repeat(200) }),
      ctx,
    );
    assert.equal(out.kind, "known");
    if (out.kind !== "known") return;
    assert.equal(out.title.length, MAX_TITLE_CHARS);
    assert.equal(out.summary.length, MAX_SUMMARY_CHARS);
  });
});

describe("**编造检查**", () => {
  it("上下文里没提过价格，简介里冒出来 —— 降级为不知道", () => {
    /*
     * 模型最爱在价格、时间、数量这几处补细节，
     * 而这几处恰恰最容易被人当真 ——
     * 有人会照着这句话去付钱。
     */
    const out = parseEnrichResponse(
      '{"known":true,"title":"某服务","summary":"每月 99 元的 API 服务"}',
      "群里前后的对话：\n甲：这个不错\n乙：收藏",
    );
    assert.equal(out.kind, "unknown");
    if (out.kind !== "unknown") return;
    assert.match(out.reason, /99 元|承诺/);
  });

  it("**上下文真的说了这个价格 —— 那就不算编**", () => {
    const out = parseEnrichResponse(
      '{"known":true,"title":"某服务","summary":"每月 99 元的 API 服务"}',
      "群里前后的对话：\n甲：这个每月99元\n乙：不贵",
    );
    assert.equal(out.kind, "known", "上下文里明明说了，却被判成编造");
  });

  it("编造的时长承诺也拦", () => {
    const out = parseEnrichResponse(
      '{"known":true,"title":"某工具","summary":"提供 3 个月免费试用"}',
      "群里前后的对话：\n甲：分享一下",
    );
    assert.equal(out.kind, "unknown");
  });

  it("编造的功能数量也拦", () => {
    const out = parseEnrichResponse(
      '{"known":true,"title":"某工具","summary":"支持 20 种语言的翻译工具"}',
      "群里前后的对话：\n甲：看看这个",
    );
    assert.equal(out.kind, "unknown");
  });

  it("**不含数字承诺的正常简介不受影响** —— 拦太狠等于这个功能不能用", () => {
    const out = parseEnrichResponse(
      '{"known":true,"title":"台风实时路径","summary":"中央气象台的台风路径查询页，可以看实时位置"}',
      ctx,
    );
    assert.equal(out.kind, "known");
  });
});

describe("提示词", () => {
  it("**把「看不出来就说看不出来」放在最重要的位置**", () => {
    assert.match(SYSTEM_PROMPT, /最重要的一条规则/);
    assert.match(SYSTEM_PROMPT, /known.*false/);
  });

  it("给了正例和反例 —— 光说「不要编」模型照编不误", () => {
    assert.match(SYSTEM_PROMPT, /服务器被攻击/);
    assert.match(SYSTEM_PROMPT, /抢 handle/);
  });

  it("明确禁止编造价格时间数量", () => {
    assert.match(SYSTEM_PROMPT, /价格|时间|数量/);
  });

  it("带上链接、域名和上下文", () => {
    const messages = buildEnrichPrompt({
      url: "https://typhoon.nmc.cn/",
      domain: "typhoon.nmc.cn",
      currentTitle: "typhoon.nmc.cn",
      sharedIn: "可以使用此网站查询实时的台风情报",
      context: ["甲：有台风", "乙：收到"],
    });
    const user = messages.find((m) => m.role === "user")!.content;
    assert.match(user, /typhoon\.nmc\.cn/);
    assert.match(user, /台风情报/);
    assert.match(user, /甲：有台风/);
  });

  it("**标题就是域名时不重复塞进去** —— 那会诱导模型照抄", () => {
    const messages = buildEnrichPrompt({
      url: "https://box.muran.tech/",
      domain: "box.muran.tech",
      currentTitle: "box.muran.tech",
      sharedIn: null,
      context: [],
    });
    const user = messages.find((m) => m.role === "user")!.content;
    assert.doesNotMatch(user, /URL 里带的文字/);
  });

  it("URL 路径碎片有信息量，要给模型", () => {
    const messages = buildEnrichPrompt({
      url: "https://github.com/lopleec/imnotcnuser",
      domain: "github.com",
      currentTitle: "lopleec/imnotcnuser",
      sharedIn: null,
      context: [],
    });
    assert.match(messages[1].content, /lopleec\/imnotcnuser/);
  });

  it("**完全没有上下文时明说** —— 不说的话模型会以为是自己漏看了", () => {
    const messages = buildEnrichPrompt({
      url: "https://x.com/",
      domain: "x.com",
      currentTitle: "x.com",
      sharedIn: null,
      context: [],
    });
    assert.match(messages[1].content, /没有任何上下文/);
  });
});

describe("**重跑要幂等**", () => {
  const base = {
    title: "box.muran.tech",
    domain: "box.muran.tech",
    note: null,
    aiTitle: null,
    aiSummary: null,
    aiCheckedAt: null,
  };

  it("没问过的要问", () => {
    assert.equal(needsEnrichment(base), true);
  });

  it("已经有结果的不再问 —— 每次跑都换个说法，谁也说不清哪次是对的", () => {
    assert.equal(
      needsEnrichment({ ...base, aiTitle: "某服务", aiSummary: "说明", aiCheckedAt: 1 }),
      false,
    );
  });

  it("**问过但模型说不知道的，也不再问** —— 否则每次同步都重问一遍那 100 条", () => {
    assert.equal(needsEnrichment({ ...base, aiCheckedAt: 1 }), false);
  });
});

describe("规则层不碰 IO", () => {
  it("纯函数 —— 提示词和解析要能离线测", () => {
    const src = readFileSync(new URL("../src/lib/links/enrich-rules.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*/g, "");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm", "fetch(", "@/lib/llm"]) {
      assert.equal(src.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});

describe("**没有语境就不用问**", () => {
  /*
   * 生产上第一次跑就撞上了：`box.muran.tech` 既没有分享时的原话、
   * 前后也没有相关对话，模型返回了一段空内容 ——
   * 既不是「知道」也不是规规矩矩的「不知道」，于是被记成一次故障。
   *
   * 但它其实不是故障：没有语境的时候，答案必然是「不知道」。
   */
  const base = { currentTitle: "box.muran.tech", domain: "box.muran.tech" };

  it("什么语境都没有 —— 不问", () => {
    assert.equal(hasEnoughContext({ ...base, sharedIn: null, context: [] }), false);
  });

  it("分享时说了句话 —— 问", () => {
    assert.equal(
      hasEnoughContext({ ...base, sharedIn: "可以使用此网站查询实时的台风情报", context: [] }),
      true,
    );
  });

  it("原话没有但前后有人在聊 —— 也问", () => {
    assert.equal(
      hasEnoughContext({ ...base, sharedIn: null, context: ["甲：这个群是干嘛的", "乙：直播那个活动"] }),
      true,
    );
  });

  it("**URL 路径本身带信息也算语境** —— `lopleec/imnotcnuser` 够说明问题", () => {
    assert.equal(
      hasEnoughContext({
        currentTitle: "lopleec/imnotcnuser",
        domain: "github.com",
        sharedIn: null,
        context: [],
      }),
      true,
    );
  });

  it("标题就是域名、又没别的 —— 不问", () => {
    assert.equal(
      hasEnoughContext({ currentTitle: "x.com", domain: "x.com", sharedIn: null, context: [] }),
      false,
    );
  });

  it("只有一两个字的原话不算语境", () => {
    assert.equal(hasEnoughContext({ ...base, sharedIn: "看", context: [] }), false);
  });

  it("空白凑不出语境", () => {
    assert.equal(hasEnoughContext({ ...base, sharedIn: "    ", context: ["  ", " "] }), false);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 「最有用」不能只靠点赞
 *
 * 线上 213 条链接，**被赞过的只有 2 条** —— 也就是说那一档
 * 实际上是在按时间排。而这一页的价值恰恰是
 * 「两百条里值得看的就那么十几条」。
 *
 * 「有几个人在群里贴过它」这个信号一直就在数据里，
 * 不需要任何人动手。
 * ─────────────────────────────────────────────────────────────── */

describe("**按分享次数排**", () => {
  const q = strip(readFileSync(new URL("../src/lib/links/queries.ts", import.meta.url), "utf8"));
  const page = strip(
    readFileSync(new URL("../src/app/(app)/links/page.tsx", import.meta.url), "utf8"),
  );

  it("多了一档 shares", () => {
    assert.match(q, /export type LinkSort = "recent" \| "votes" \| "shares"/);
  });

  it("**用 visibleShares，不是 shareCount**", () => {
    /*
     * 后者是全站次数。拿它排序的话，顺序本身就泄露了别的群的热度：
     * 一条你在自己群里从没见过的链接排在最前面，
     * 这件事等于告诉你「别处有人在热议它」。
     *
     * 这一页别处早就只显示 visibleShares 了 ——
     * 排序漏掉的话，前面所有的小心都白做。
     */
    const block = q.slice(q.indexOf('query.sort === "shares"'));
    assert.match(block.slice(0, 300), /b\.visibleShares - a\.visibleShares/);
    assert.equal(/b\.shareCount - a\.shareCount/.test(block.slice(0, 300)), false, "拿全站次数排了");
  });

  it("同分时按最近分享 —— 否则同分的顺序会随新消息乱跳", () => {
    const block = q.slice(q.indexOf('query.sort === "shares"'));
    assert.match(block.slice(0, 300), /b\.lastSharedAt - a\.lastSharedAt/);
  });

  it("**它是默认档** —— 这一页是资源库，不是时间线", () => {
    assert.match(page, /: "shares";/);
  });

  it("最近分享还在，一键就能切回去", () => {
    assert.match(page, /query\(\{ sort: "recent" \}\)/);
  });

  it("三档都指得出自己是哪一档 —— 不能有两个同时高亮", () => {
    for (const key of ["shares", "recent", "votes"]) {
      assert.match(page, new RegExp(`bySort === "${key}"`), `${key} 那一档没接上`);
    }
  });
});
