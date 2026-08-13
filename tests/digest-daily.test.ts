import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DAILY_MAX_ITEMS,
  DAILY_MIN_ENGAGEMENT,
  renderDaily,
  selectDaily,
  shouldSendDaily,
} from "@/lib/digest/daily";
import { MIN_ENGAGEMENT } from "@/lib/digest/weekly";
import type { DigestCandidate } from "@/lib/digest/weekly";

import { readCode, readSource } from "./_source";

/**
 * 每天晚上那一条。
 *
 * ═════════════════════════════════════════
 * 这是全站唯一一个没有人复核就发出去的东西
 * ═════════════════════════════════════════
 *
 * `broadcasts` 上有一条刻意的约束：复核人必须和创建人不是同一个人。
 * 周报因此只备草稿。站长要每天 20:00 自动发，于是这条路上没有人按 ——
 * 所以下面每一条测的都不是「功能对不对」，是**它能不能说出
 * 不该说的话**。
 */

const post = (over: Partial<DigestCandidate> = {}): DigestCandidate => ({
  id: "p1",
  title: "一篇长文",
  excerpt: "摘要",
  visibility: "public",
  status: "published",
  featured: false,
  replyCount: 5,
  reactionCount: 5,
  viewCount: 50,
  createdAt: Date.now(),
  authorId: "u1",
  authorName: "小明",
  fromGroupChat: false,
  charCount: 400,
  ...over,
});

describe("**不该说的话，一句都出不去**", () => {
  it("只在部分人可见的帖子进不来", () => {
    /*
     * 这条消息发进**所有**群，内容对每个群都一样。
     * 只要有一条是「仅 A 群可见」的，它就会被念给 B 群听。
     * 白名单不是黑名单：新增一个可见性级别时，黑名单会默认放行。
     */
    for (const v of ["group", "role", "private"] as const) {
      const got = selectDaily([post({ visibility: v })], new Set());
      assert.equal(got.items.length, 0, `${v} 漏出去了`);
    }
  });

  it("没发布的进不来", () => {
    for (const s of ["draft", "hidden", "deleted", "locked"] as const) {
      assert.equal(selectDaily([post({ status: s })], new Set()).items.length, 0, `${s} 漏出去了`);
    }
  });

  it("**周报推过的，日报不再推**", () => {
    /*
     * 两边共用同一份「已推送」记录。分两份的话，周一早上周报推过的
     * 文章，周一晚上会被日报再推一次 —— 那是让人开始忽略这个消息的第一步。
     */
    assert.equal(selectDaily([post()], new Set(["p1"])).items.length, 0);
  });
});

describe("宁缺毋滥", () => {
  it("**一条都没有就不发**", () => {
    const v = shouldSendDaily({ items: [], rejected: [] });
    assert.equal(v.send, false);
    assert.match(v.reason, /宁可不发/);
  });

  it("**一条就发** —— 日报和周报在这里不一样", () => {
    /*
     * 周报要求至少两条（凑不满说明这周确实没什么）。
     * 日报一条就发：它的意义是「今天有人写了这个」，一篇好文就够了；
     * 要求两条会让很多天变成没有，于是这件事重新变成「有时候有」。
     */
    assert.equal(shouldSendDaily({ items: [post() as never], rejected: [] }).send, true);
  });

  it("**门槛比周报高** —— 日报每天都来，凑数的代价是复利的", () => {
    assert.ok(
      DAILY_MIN_ENGAGEMENT > MIN_ENGAGEMENT,
      `日报门槛 ${DAILY_MIN_ENGAGEMENT} 不该低于或等于周报的 ${MIN_ENGAGEMENT}`,
    );
    // 刚好差一点的进不来
    const weak = post({ replyCount: 1, reactionCount: 1 });
    assert.equal(selectDaily([weak], new Set()).items.length, 0);
  });

  it("精华帖免检 —— 那是人工挑过的", () => {
    const featured = post({ featured: true, replyCount: 0, reactionCount: 0 });
    assert.equal(selectDaily([featured], new Set()).items.length, 1);
  });

  it(`最多 ${DAILY_MAX_ITEMS} 条 —— 五条会变成刷屏`, () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      post({ id: `p${i}`, authorId: `u${i}`, authorName: `人${i}` }),
    );
    assert.equal(selectDaily(many, new Set()).items.length, DAILY_MAX_ITEMS);
  });
});

describe("那条消息长什么样", () => {
  const items = [
    { id: "p1", title: "标题一", excerpt: "摘要一", authorName: "小明", reason: "3 条回复" },
    { id: "p2", title: "标题二", excerpt: null, authorName: "小红", reason: "精华" },
  ];

  it("**「回到群里」那半句在最后** —— 先给东西，再给去处", () => {
    /*
     * 把提醒放前面的话，这条消息第一眼就是在要东西 ——
     * 而一条开口就要东西的自动消息，第三天就没人往下看了。
     */
    const text = renderDaily(items as never, {
      siteUrl: "https://x.test",
      dateLabel: "8 月 13 日",
    });
    const lines = text.trim().split("\n");
    assert.match(lines[lines.length - 1], /更多在/);
    assert.match(lines[0], /今天值得读的/);
  });

  it("超长时少放一条，不从中间截断 —— 截断会切出半个链接", () => {
    const long = Array.from({ length: 3 }, (_, i) => ({
      id: `p${i}`,
      title: "标".repeat(120),
      excerpt: "摘".repeat(120),
      authorName: "人",
      reason: "理由",
    }));
    const text = renderDaily(long as never, {
      siteUrl: "https://x.test",
      dateLabel: "8 月 13 日",
      maxLength: 400,
    });
    assert.ok(text.length <= 400);
    assert.equal(text.includes("https://x.test/forum/p/p2"), false, "应该少放了最后一条");
    // 留下来的那条链接必须是完整的
    assert.ok(text.includes("https://x.test/forum/p/p0"));
  });
});

describe("自动发这件事本身", () => {
  const src = readCode("lib/digest/build-daily.ts");
  /** 带注释的原文 —— 「有没有写明」这件事只能在原文里查 */
  const raw = readSource("lib/digest/build-daily.ts");

  it("**它确实绕过了双人复核，而且写明了**", () => {
    /*
     * 不是要它别绕 —— 站长要的就是自动发。
     * 这一条要的是「绕过这件事没有被藏起来」：
     * 下一个读这个文件的人必须一眼看见它，而不是从 status 字段里推出来。
     *
     * 两个断言分别查两份源码：**代码**查剥掉注释的（注释里出现
     * `status: "sending"` 不算数），**说明**查原文（`readCode` 会把
     * 注释整段剥掉，拿它查「有没有解释」永远是假）。
     * 这个仓库在这条上栽过好几次。
     */
    assert.match(src, /status: "sending"/);
    assert.match(raw, /复核/);
  });

  it("**有独立开关**，不复用周报那个", () => {
    /*
     * 复用的话，站长想停掉「自动发」就得连周报一起停 ——
     * 而周报只备草稿，本来没有停的理由。
     * 一个开关管两件危险程度差一个量级的事，最后一定没人敢动。
     */
    assert.match(src, /isModuleEnabled\("digest_daily"\)/);
    assert.match(src, /isModuleEnabled\("broadcast"\)/);
  });

  it("**默认是关的** —— 打开它的那一次知情，本身就是那道闸", async () => {
    const { MODULES } = await import("@/lib/modules/registry");
    const spec = MODULES.find((m) => m.key === "digest_daily");
    assert.ok(spec, "登记表里没有这个模块");
    assert.ok(spec!.defaultOff, "默认关必须写下理由");
  });

  it("匿名帖不署名 —— 一条发进所有群的消息把匿名和名字连起来就作废了", () => {
    assert.match(raw, /匿名帖不署名/);
    assert.match(src, /anonymous/);
  });
});

describe("**试发和正式发不是一件事**", () => {
  const src = readCode("lib/digest/build-daily.ts");

  it("试发**不记账** —— 否则一次试发会吃掉三篇好文", () => {
    /*
     * 记了账的话有两个后果，第二个更糟：
     *   ① 今天的正式那条会以为「已经发过了」而跳过
     *   ② 那几篇文章被标成「推过了」，从此不再出现在任何一期里
     */
    assert.match(src, /if \(!isTest\)/);
  });

  it("试发**必须点名群** —— 没有「试发给所有人」这种东西", () => {
    assert.match(src, /const isTest = \(options\.targetConvIds\?\.length \?\? 0\) > 0/);
  });

  it("试发不受模块开关拦 —— 那个开关护的是「自动发给所有群」", () => {
    /*
     * 两件事的危险程度差一个量级：一个是每天自动发给一千六百人，
     * 一个是人手动发给一个自己点名的群。
     */
    assert.match(src, /!isTest && !isModuleEnabled\("digest_daily"\)/);
  });

  it("正式发仍然发给所有群 —— 试发不能悄悄改掉默认行为", () => {
    assert.match(src, /options\.targetConvIds \?\? null/);
  });
});

describe("**长文必须进得来**", () => {
  it("够长就免检互动 —— 否则这个功能推不出任何一篇长文", () => {
    /*
     * 这一条是试发前的预览救回来的。
     *
     * 当时选出来的是「能不能整个匿名」（21 个字的提问），
     * 而当天那批几千字的文章全被「只有 0 条互动，够不上」刷掉了 ——
     * 站长要的原话却是「定期同步**高质量文章**」。
     *
     * 根子是线上量到的那条规律：长文（≥2000 字）平均 0.21 条回复，
     * 短帖 1.28 条。互动门槛因此不是偶尔漏掉长文，是**设计上
     * 永远选不中长文**。
     */
    const long = post({ replyCount: 0, reactionCount: 0, charCount: 5000 });
    assert.equal(selectDaily([long], new Set()).items.length, 1, "长文被互动门槛挡住了");
  });

  it("短帖仍然要有互动才进得来 —— 免检的是长度，不是所有人", () => {
    const short = post({ replyCount: 0, reactionCount: 0, charCount: 50 });
    assert.equal(selectDaily([short], new Set()).items.length, 0);
  });

  it("**门槛和「坐下来读」那一栏是同一个数**", async () => {
    /*
     * 两处用两个数的话，一篇文章会出现在其中一处而不在另一处，
     * 而读者没有任何办法知道为什么。
     */
    const { LONGFORM_CHARS } = await import("@/lib/forum/longform");
    const src = readCode("lib/digest/daily.ts");
    assert.match(src, /longformChars: LONGFORM_CHARS/);
    assert.ok(LONGFORM_CHARS > 0);
  });
});

describe("**「0 个表情」不是一个理由**", () => {
  it("长文说的是读完要多久，不是它有几个表情", async () => {
    /*
     * 试发预览里真出现了「启 · 0 个表情」—— 那句话不但没解释
     * 它为什么入选，还在暗示它没人理。而它是靠**长度**进来的。
     */
    const { reasonFor } = await import("@/lib/digest/weekly");
    const { LONGFORM_CHARS } = await import("@/lib/forum/longform");
    const long = post({ replyCount: 0, reactionCount: 0, charCount: 6000 });
    const reason = reasonFor(long, LONGFORM_CHARS);
    assert.match(reason, /读完/);
    assert.equal(/0 个表情/.test(reason), false);
  });

  it("任何情况下都不说「0 个」", async () => {
    const { reasonFor } = await import("@/lib/digest/weekly");
    for (const c of [
      post({ replyCount: 0, reactionCount: 0, charCount: 10 }),
      post({ replyCount: 0, reactionCount: 0, charCount: 6000 }),
      post({ replyCount: 3, reactionCount: 0 }),
      post({ featured: true, replyCount: 0, reactionCount: 0 }),
    ]) {
      assert.equal(/\b0 /.test(reasonFor(c, 2000)), false, `说了 0：${reasonFor(c, 2000)}`);
    }
  });
});

describe("**发给零个群不叫发出去了**", () => {
  it("日报自己建逐群待发记录 —— deliverBroadcast 只读不建", () => {
    /*
     * 第一版漏了这一步，后果不是报错：deliverBroadcast 遍历了一个
     * 空列表，然后把广播标成 sent。**「成功」地发给了零个群**，
     * 而状态、返回值、日志三处都说它发出去了。
     * 试发到 #1 群、群里什么都没有，才发现。
     */
    const src = readCode("lib/digest/build-daily.ts");
    assert.match(src, /insert\(broadcastDeliveries\)/);
  });

  it("**sender 遇到零条待发记录要判失败**", () => {
    /*
     * 这条是上面那个 bug 留下的护栏：就算将来又有人忘了建记录，
     * 也不会再出现「后台显示已发送而群里什么都没有」。
     */
    const src = readCode("lib/broadcast/sender.ts");
    assert.match(src, /deliveries\.length === 0/);
    const at = src.indexOf("deliveries.length === 0");
    assert.match(src.slice(at, at + 400), /status: "failed"/);
  });
});

describe("**周一不发**", () => {
  it("周一跳过 —— 每周精选那天早上已经占了一条", async () => {
    /*
     * 一天两条来自同一个站的推送，而且内容高度重叠（都从同一批帖子里
     * 挑，只是窗口不同）—— 那是「这个站开始刷屏了」的第一印象，
     * 而那个印象只需要建立一次。
     */
    const { isSkipDay } = await import("@/lib/digest/daily");
    assert.equal(isSkipDay("2026-08-17"), true, "2026-08-17 是周一");
    assert.equal(shouldSendDaily({ items: [post() as never], rejected: [] }, "2026-08-17").send, false);
  });

  it("别的日子照发", async () => {
    const { isSkipDay } = await import("@/lib/digest/daily");
    // 2026-08-14 是周五，前后各取一天
    for (const d of ["2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16", "2026-08-18"]) {
      assert.equal(isSkipDay(d), false, `${d} 不该被跳过`);
    }
    assert.equal(shouldSendDaily({ items: [post() as never], rejected: [] }, "2026-08-14").send, true);
  });

  it("**按东八区的星期几算** —— 服务器时区不一定是东八", () => {
    /*
     * 「周一」对群里的人是他们的周一。dateKey 已经是东八区切好的，
     * 所以按 UTC 解析回来才不会偏一天。
     */
    const src = readCode("lib/digest/daily.ts");
    assert.match(src, /T00:00:00Z/);
    assert.match(src, /getUTCDay\(\) === 1/);
  });

  it("**试发不受它拦** —— 手动试发时「今天是周一」不是他要的答案", () => {
    const src = readCode("lib/digest/build-daily.ts");
    assert.match(src, /isTest[\s\S]{0,80}shouldSendDaily\(selection\)/);
  });
});
