import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Portrait } from "@/components/members/Portrait";
import { TitleRow } from "@/components/members/TitleRow";
import type { OwnedTitle } from "@/lib/titles/queries";

/**
 * 主页上的「这个人是什么样的」—— **渲染出来**再看。
 *
 * 这一块全是「归纳出来的话」，而归纳出来的话最容易出的错是
 * **说得比知道的多**。那种错在源码里搜字符串是看不出来的：
 * 标题写对了、条件写反了，页面上照样是一句错话。
 */

const render = async (node: unknown): Promise<string> => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(node as never);
};

const CATCH = { phrase: "卧槽", hits: 129, days: 12, lift: 5.9 };
const EMOJI = { emoji: "旺柴", hits: 52 };
const PARTNER = { wxId: "wx_bob", name: "小明", count: 31 };
const HOURS = {
  bars: Array.from({ length: 24 }, (_, h) => (h >= 21 || h <= 1 ? 1 : 0.1)),
  from: 21,
  to: 23,
  share: 0.62,
  label: "深夜型",
  total: 800,
};

const portrait = (over: Partial<Parameters<typeof Portrait>[0]> = {}) =>
  render(
    Portrait({
      catchphrase: null,
      hours: null,
      emoji: null,
      partner: null,
      partnerHref: null,
      ...over,
    }),
  );

describe("常挂在嘴边", () => {
  it("词和依据都摆出来", async () => {
    const html = await portrait({ catchphrase: CATCH });
    assert.match(html, /常挂在嘴边/);
    assert.match(html, /卧槽/);
    // 依据要给全：只给一个词的话读者没法判断这句话有多可信
    assert.match(html, /129 次/);
    assert.match(html, /12 天/);
    assert.match(html, /5\.9 倍/);
  });

  it("倍数很大时不显示小数 —— 「是别人的 205.3 倍」里那个 .3 没有意义", async () => {
    const html = await portrait({ catchphrase: { ...CATCH, lift: 205.34 } });
    assert.match(html, /205 倍/);
    assert.equal(html.includes("205.3"), false);
  });
});

describe("**最常用的表情和口头禅是两回事**", () => {
  it("表情单独一行，标题不叫「常挂在嘴边」", async () => {
    /*
     * 混在一起会得到「他常把旺柴挂在嘴边、说过 52 次」——
     * 而「旺柴」是微信表情，他一个字都没说。
     */
    const html = await portrait({ emoji: EMOJI });
    assert.match(html, /最常用的表情/);
    assert.match(html, /\[旺柴\]/);
    assert.match(html, /点过 52 次/);
    assert.equal(html.includes("常挂在嘴边"), false);
    assert.equal(html.includes("说过"), false, "表情那一行说成了「说过」");
  });

  it("两样都有时各占一行", async () => {
    const html = await portrait({ catchphrase: CATCH, emoji: EMOJI });
    assert.match(html, /常挂在嘴边/);
    assert.match(html, /最常用的表情/);
  });
});

describe("@ 得最多", () => {
  it("**标题是「@ 得最多」，不是「聊得最多」**", async () => {
    /*
     * 群消息的回复关系卡在上游，手上只有 @。
     * 写成「聊得最多」就是一句我们答不上来的话。
     */
    const html = await portrait({ partner: PARTNER });
    assert.match(html, /@ 得最多/);
    assert.equal(html.includes("聊得最多"), false);
    assert.equal(html.includes("对话"), false);
  });

  it("有链接时点得过去", async () => {
    const html = await portrait({ partner: PARTNER, partnerHref: "/members/wx_bob" });
    assert.match(html, /href="\/members\/wx_bob"/);
    assert.match(html, /小明/);
  });

  it("**没链接时名字照常显示** —— 不能因为他没账号就整条不见", async () => {
    const html = await portrait({ partner: PARTNER, partnerHref: null });
    assert.match(html, /小明/);
    assert.equal(html.includes("<a "), false);
  });
});

describe("**什么都没有时整块不出现**", () => {
  it("三样全空 → null", async () => {
    assert.equal(
      Portrait({ catchphrase: null, hours: null, emoji: null, partner: null, partnerHref: null }),
      null,
    );
    assert.equal(await portrait(), "");
  });

  it("**不显示「暂无数据」** —— 那句话对读者没有任何用处", async () => {
    const html = await portrait({ catchphrase: CATCH });
    assert.equal(/暂无|还没有|没有数据/.test(html), false);
  });
});

describe("称号", () => {
  const title = (over: Partial<OwnedTitle> = {}): OwnedTitle =>
    ({
      userTitleId: "ut1",
      titleId: "t1",
      key: "k",
      name: "元老",
      description: "从第一天就在",
      icon: "🏅",
      rarity: "rare",
      source: "grant",
      expiresAt: null,
      autoRenew: false,
      daysLeft: null,
      renewPrice: null,
      revokedAt: null,
      active: true,
      expired: false,
      equipped: false,
      createdAt: 1,
      ...over,
    }) as OwnedTitle;

  it("渲染出来", async () => {
    const html = await render(TitleRow({ titles: [title()] }));
    assert.match(html, /元老/);
    assert.match(html, /🏅/);
  });

  it("**佩戴中的排第一** —— 那是这个系统里唯一一处本人的表达", async () => {
    const html = await render(
      TitleRow({
        titles: [
          title({ userTitleId: "a", name: "路人", createdAt: 9 }),
          title({ userTitleId: "b", name: "元老", equipped: true, createdAt: 1 }),
        ],
      }),
    );
    assert.ok(html.indexOf("元老") < html.indexOf("路人"), "佩戴的那个没排在前面");
  });

  it("佩戴中的有底色，其余没有", async () => {
    const html = await render(
      TitleRow({ titles: [title({ equipped: true }), title({ userTitleId: "b", name: "路人" })] }),
    );
    assert.equal((html.match(/color-mix/g) ?? []).length, 1);
  });

  it("**太多时收起来，不铺满一屏**", async () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      title({ userTitleId: `t${i}`, name: `称号${i}` }),
    );
    const html = await render(TitleRow({ titles: many }));
    assert.match(html, /还有 5 个/);
  });

  it("一个都没有时不渲染", async () => {
    assert.equal(TitleRow({ titles: [] }), null);
  });

  it("没有图标时不留空位", async () => {
    const html = await render(TitleRow({ titles: [title({ icon: null })] }));
    assert.match(html, /元老/);
    assert.equal(html.includes("<span aria-hidden></span>"), false);
  });
});

describe("一般什么时候说话", () => {
  it("标签、窗口、24 根条子都在", async () => {
    const html = await portrait({ hours: HOURS });
    assert.match(html, /深夜型/);
    assert.match(html, /21:00–24:00/);
    // 一根一小时，少一根图就和小时对不上了
    const bars = html.match(/rounded-\[1px\]/g) ?? [];
    assert.equal(bars.length, 24);
  });

  it("**有刻度** —— 没有刻度这排条子只是好看，读不出几点", async () => {
    const html = await portrait({ hours: HOURS });
    for (const tick of [">0<", ">6<", ">12<", ">18<", ">24<"]) {
      assert.ok(html.includes(tick), `缺刻度 ${tick}`);
    }
  });

  it("**图对读屏隐藏** —— 念 24 个数字没有意义，上面那句话已经说完了", async () => {
    const html = await portrait({ hours: HOURS });
    assert.match(html, /aria-hidden="true"/);
  });

  it("**作息散的人也画图，只是不给标签**", async () => {
    /*
     * 整块不显示的话，「作息很散」这个事实本身也丢了 ——
     * 而它同样是一句关于这个人的真话。
     */
    const html = await portrait({ hours: { ...HOURS, label: null } });
    assert.match(html, /各个时段都有/);
    assert.equal((html.match(/rounded-\[1px\]/g) ?? []).length, 24);
  });

  it("**零的那几个小时也留一点高度** —— 全塌下去像是渲染坏了", async () => {
    const html = await portrait({
      hours: { ...HOURS, bars: HOURS.bars.map((_, h) => (h === 3 ? 1 : 0)) },
    });
    assert.equal(/height:\s*0%/.test(html), false, "有条子高度是 0");
  });
});
