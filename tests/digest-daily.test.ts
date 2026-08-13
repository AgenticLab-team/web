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
