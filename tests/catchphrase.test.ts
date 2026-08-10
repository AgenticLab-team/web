import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MIN_MESSAGES,
  emojiOf,
  phrasesOf,
  pickCatchphrase,
  tally,
  type Said,
} from "@/lib/members/catchphrase";

/**
 * 口头禅。
 *
 * ═════════════════════════════════════════
 * 这份测试真正在守的是「别给出一句谁都成立的话」
 * ═════════════════════════════════════════
 *
 * 只按词频排的话，每个人的口头禅都是「我们」「这个」——
 * 那不是口头禅，那是中文。而一句对谁都成立的结论比没有结论更糟：
 * 读的人会发现它对旁边那个人也成立，然后整块区域都不再可信。
 *
 * 所以下面大半条目问的都是同一件事：**它会不会把大路货当成口头禅。**
 */

/*
 * 造消息。**每条给一个不同的日子** —— 横跨天数是一道真闸
 * （MIN_DAYS），全堆在同一天的话每条测试都会被那道闸拦下来，
 * 而拦下来的原因和它想测的东西无关。
 */
const day = (i: number) => `2026-01-${String((i % 28) + 1).padStart(2, "0")}`;
const rep = (text: string, n: number): Said[] =>
  Array.from({ length: n }, (_, i) => ({ text, day: day(i) }));
/** 造 n 条互不相同的填充消息，避免填充本身产生高频片段 */
const filler = (n: number, seed = "填"): Said[] =>
  Array.from({ length: n }, (_, i) => ({
    text: `${seed}${i}${"零一二三四五六七八九"[i % 10]}`,
    day: day(i),
  }));

/** 测试里直接给「别人说过的话」，基准现算 —— 生产里那份是预先算好的 */
const pick = (over: { mine?: Said[]; others?: Said[]; exclude?: readonly string[] }) => {
  const others = over.others ?? [];
  return pickCatchphrase({
    mine: over.mine ?? [],
    exclude: over.exclude,
    others: tally(others),
    otherMessages: others.length,
  });
};

describe("抽片段", () => {
  it("2 到 5 个字都抽", () => {
    const got = new Set(phrasesOf("你好吗"));
    assert.ok(got.has("你好"));
    assert.ok(got.has("好吗"));
    assert.ok(got.has("你好吗"));
  });

  it("**只认汉字连续段** —— URL、代码、数字自然被切掉", () => {
    /*
     * 不这么做的话「http」「com」会成为高频片段，
     * 而一个人的口头禅不可能是 https。
     */
    const got = phrasesOf("看这个 https://github.com/a/b 挺好");
    assert.equal(
      got.some((p) => /[a-z0-9]/i.test(p)),
      false,
    );
    assert.ok(got.includes("挺好"));
  });

  it("**标点会断开** —— 「好，的」不该被算成一个片段", () => {
    assert.equal(phrasesOf("好，的").includes("好的"), false);
  });

  it("单个字不算 —— 一个字几乎匹配一切", () => {
    assert.deepEqual(phrasesOf("好"), []);
  });

  it("空字符串不出错", () => {
    assert.deepEqual(phrasesOf(""), []);
  });
});

describe("计数", () => {
  it("同一条消息里出现两次，次数是 2 但只算一条消息", () => {
    /*
     * 这个区分是挡「复制粘贴」的关键：一段签名档能让里面每个片段
     * 都刷到几百次，但它只出现在一条消息里。
     */
    const t = tally([{ text: "哈哈哈哈", day: "d1" }]);
    assert.equal(t.get("哈哈")!.hits, 3);
    assert.equal(t.get("哈哈")!.msgs, 1);
  });

  it("两条消息各一次，次数 2、消息数 2", () => {
    const t = tally([
      { text: "哈哈", day: "d1" },
      { text: "哈哈", day: "d2" },
    ]);
    assert.equal(t.get("哈哈")!.hits, 2);
    assert.equal(t.get("哈哈")!.msgs, 2);
  });

  it("**消息数不能跟着次数一起涨** —— 那样复制粘贴那道闸就形同虚设", () => {
    /*
     * 「哈哈哈哈」一条消息里「哈哈」出现 3 次。
     * 如果 msgs 也加 3，那一条签名档就能同时满足
     * 「出现很多次」和「出现在很多条消息里」—— 而后者存在的全部意义
     * 就是把前者那种情况挡下来。
     */
    const t = tally([{ text: "哈哈哈哈", day: "d1" }]);
    assert.equal(t.get("哈哈")!.msgs, 1, "一条消息被当成了多条");
  });
});

describe("**挑得出真口头禅**", () => {
  it("他常说、别人不说的那个", () => {
    const mine = [...rep("卧槽这个厉害", 20), ...filler(30)];
    const others = filler(200, "别");
    const got = pick({ mine, others });
    assert.ok(got, "什么都没挑出来");
    assert.match(got.phrase, /卧槽/);
  });

  it("**大路货挑不出来** —— 他和别人说得一样多", () => {
    /*
     * 这一条是整份测试的重点。「这个」他说 40 次，别人也天天说 ——
     * 那不是他的口头禅。
     */
    const mine = [...rep("这个不错", 40), ...filler(20)];
    const others = rep("这个不错", 400);
    assert.equal(pick({ mine, others }), null);
  });

  it("**说话太少的人没有口头禅** —— 重复几次不叫习惯", () => {
    const mine = rep("卧槽", MIN_MESSAGES - 1);
    assert.equal(pick({ mine, others: filler(100) }), null);
  });

  it("**只在一条消息里刷屏不算** —— 那是复制粘贴", () => {
    /*
     * 一段签名档里「诚信经营」出现二十次，够 MIN_HITS 了，
     * 但它只出现在一条消息里。
     */
    const mine = [{ text: "诚信经营".repeat(20), day: "d1" }, ...filler(40)];
    const got = pick({ mine, others: filler(200) });
    assert.equal(got === null || !got.phrase.includes("诚信"), true, `挑出了 ${got?.phrase}`);
  });

  it("**说得多的不一定赢 —— 更独特的赢**", () => {
    /*
     * 突变测试逼出来的一条。
     *
     * 「确实」他说 100 次、别人也常说（勉强过 lift 门槛）；
     * 「我不到啊」他说 60 次、别人几乎不说。只按词频排的话
     * 「确实」赢 —— 而那是一句放在谁身上都成立的话。
     *
     * MIN_LIFT 挡不住这个：两个候选都过了门槛，
     * 差别在**过了多少**，那正是排序该管的事。
     */
    // 「确实」要**过得了 lift 门槛**才谈得上比排序 ——
    // 别人说得太多的话它在上一关就被刷掉了，这条测试就白写了
    const mine = [...rep("确实", 100), ...rep("我不到啊", 60), ...filler(40)];
    const others = [...rep("确实", 100), ...filler(900, "他")];
    const got = pick({ mine, others });
    assert.equal(got?.phrase, "我不到啊", `挑出了 ${got?.phrase}`);
  });

  it("**出现在 4 条消息里、一共 4 次 —— 还不够**", () => {
    /*
     * 卡在 MIN_DISTINCT（4）和 MIN_HITS（5）之间的那一格。
     * 不测这一格的话 MIN_HITS 就是一个删掉也没人发现的常量。
     */
    const mine = [...rep("卧槽", 4), ...filler(40)];
    const got = pick({ mine, others: filler(400) });
    assert.equal(got === null || !got.phrase.includes("卧槽"), true, `挑出了 ${got?.phrase}`);
  });

  it("说到第 5 次就够了", () => {
    const mine = [...rep("卧槽", 5), ...filler(40)];
    const got = pick({ mine, others: filler(400) });
    assert.equal(got?.phrase, "卧槽");
  });

  it("出现次数太少不算", () => {
    const mine = [...rep("卧槽", 2), ...filler(40)];
    const got = pick({ mine, others: filler(200) });
    assert.equal(got === null || !got.phrase.includes("卧槽"), true, `挑出了 ${got?.phrase}`);
  });
});

describe("**昵称不是口头禅**", () => {
  it("群里天天喊的名字要排除", () => {
    /*
     * 「牛牛酱」在群里出现频率极高，但那是别人的名字。
     * 不排除的话，活跃群里每个人的口头禅都会是群主的昵称。
     */
    const mine = [...rep("牛牛酱你看", 30), ...filler(20)];
    const got = pick({ mine, others: filler(200), exclude: ["牛牛酱"] });
    assert.equal(got === null || !got.phrase.includes("牛牛"), true, `挑出了 ${got?.phrase}`);
  });

  it("**包含昵称的片段也要排除** —— 「牛牛酱你」一样不算", () => {
    const mine = [...rep("牛牛酱你看", 30), ...filler(20)];
    const got = pick({ mine, others: filler(200), exclude: ["牛牛酱"] });
    if (got) assert.equal(got.phrase.includes("牛牛"), false, `挑出了 ${got.phrase}`);
  });

  it("**昵称的一部分也算昵称** —— 「牛牛」是「牛牛酱」的一半", () => {
    const mine = [...rep("牛牛你看", 30), ...filler(20)];
    const got = pick({ mine, others: filler(200), exclude: ["牛牛酱"] });
    if (got) assert.equal(got.phrase.includes("牛牛"), false, `挑出了 ${got.phrase}`);
  });

  it("空昵称不会把所有片段都排除掉", () => {
    /*
     * `"".includes(x)` 永远为假，但 `x.includes("")` 永远为真 ——
     * 名册里混进一个空字符串就会把候选全部清空，
     * 而表现是「所有人都没有口头禅」，看不出哪里错了。
     */
    const mine = [...rep("卧槽这个厉害", 20), ...filler(30)];
    const got = pick({ mine, others: filler(200), exclude: ["", "别人"] });
    assert.ok(got, "空昵称把候选全清掉了");
  });
});

describe("**互相包含的片段：取那个更像话的**", () => {
  it("几乎总是一起出现时，取长的", () => {
    /*
     * 「哈哈」必然比「哈哈哈」次数多（前者是后者的子串），
     * 只按次数排的话赢家永远是最短的那个 ——
     * 而「哈哈哈」才更像一个人的口头禅。
     */
    const mine = [...rep("哈哈哈", 30), ...filler(20)];
    const got = pick({ mine, others: filler(200) });
    assert.equal(got?.phrase, "哈哈哈");
  });

  it("长的很少出现时，取短的", () => {
    const mine = [...rep("哈哈", 30), ...rep("哈哈哈", 2), ...filler(20)];
    const got = pick({ mine, others: filler(200) });
    assert.equal(got?.phrase, "哈哈");
  });
});

describe("边界", () => {
  it("别人一条消息都没有时不会除以零", () => {
    const mine = [...rep("卧槽", 30), ...filler(20)];
    const got = pick({ mine, others: [] });
    assert.ok(got === null || Number.isFinite(got.lift));
  });

  it("**别人没说过的偏僻片段，不该因为除数为零就冲到第一**", () => {
    /*
     * 他说了 300 次「卧槽」（别人也常说），另有一个说了 5 次、
     * 别人一次没说的片段。后者的 lift 若是无穷大就会赢 ——
     * 而它多半只是某天某个话题的残留。
     */
    const mine = [...rep("卧槽", 300), ...rep("量子隧穿", 5), ...filler(30)];
    const others = [...rep("卧槽", 300), ...filler(600, "他")];
    const got = pick({ mine, others });
    assert.equal(got === null || !got.phrase.includes("量子"), true, `挑出了 ${got?.phrase}`);
  });

  it("挑不出来时返回 null，不硬凑", () => {
    assert.equal(pick({ mine: filler(100), others: filler(100) }), null);
  });

  it("lift 是个有限的正数", () => {
    const mine = [...rep("卧槽这个厉害", 20), ...filler(30)];
    const got = pick({ mine, others: filler(200) });
    assert.ok(got && got.lift > 1 && Number.isFinite(got.lift));
  });
});

describe("**横跨天数：话题不是习惯**", () => {
  it("全挤在一天里的不算 —— 那是那天在聊这个", () => {
    /*
     * 线上跑出来的第一版里，「参考快讯」的 lift 是 632 倍 ——
     * 因为那是某个人某几天在刷的东西。
     * 习惯的特征是它不挑日子。
     */
    const mine = [
      ...Array.from({ length: 40 }, () => ({ text: "参考快讯", day: "2026-01-01" })),
      ...filler(40),
    ];
    const got = pick({ mine, others: filler(400) });
    assert.equal(got === null || !got.phrase.includes("快讯"), true, `挑出了 ${got?.phrase}`);
  });

  it("散在很多天里的算", () => {
    const mine = [
      ...Array.from({ length: 40 }, (_, i) => ({ text: "卧槽", day: `2026-02-${(i % 20) + 1}` })),
      ...filler(40),
    ];
    assert.equal(pick({ mine, others: filler(400) })?.phrase, "卧槽");
  });

  it("**同一天说很多次只算一天**", () => {
    const t = tally([
      { text: "卧槽", day: "d1" },
      { text: "卧槽", day: "d1" },
      { text: "卧槽", day: "d2" },
    ]);
    assert.equal(t.get("卧槽")!.days, 2);
    assert.equal(t.get("卧槽")!.msgs, 3);
  });
});

describe("**片段最长四个字**", () => {
  it("不再抽五个字的残片", () => {
    /*
     * 线上第一版抽到五个字时，候选清一色是从长句里切出来的残片：
     * 「长断章取义」「组合的词元」「佳佳世一萌」——
     * 统计上完全合法，读起来像乱码。
     */
    assert.equal(
      phrasesOf("长断章取义").some((p) => [...p].length > 4),
      false,
    );
  });

  it("四个字的成语照常抽得到", () => {
    assert.ok(phrasesOf("断章取义").includes("断章取义"));
  });
});

describe("**微信表情不是他说的话**", () => {
  it("`[旺柴]` 不进片段", () => {
    /*
     * 线上第一版跑出来 112 个人里有四个的「口头禅」是「旺柴」——
     * 那不是他说的话，是他点的表情。
     * 「他常把旺柴挂在嘴边、说过 52 次」是一句错的话。
     */
    assert.equal(phrasesOf("好的[旺柴]").includes("旺柴"), false);
  });

  it("**表情两边的字不会被粘起来**", () => {
    // 摘掉之后要留一个断点，否则「好[旺柴]的」会变出「好的」
    assert.equal(phrasesOf("好[旺柴]的").includes("好的"), false);
  });

  it("表情本身单独摘得出来 —— 它是另一条统计", () => {
    assert.deepEqual(emojiOf("好的[旺柴]再见[捂脸]"), ["旺柴", "捂脸"]);
  });

  it("没有表情时返回空", () => {
    assert.deepEqual(emojiOf("好的"), []);
  });

  it("**过长的方括号不当表情** —— 那多半是别的东西", () => {
    assert.deepEqual(emojiOf("[这是一段很长的方括号内容]"), []);
  });

  it("方括号里的正常汉字照常算话", () => {
    // 摘的是表情词，不是所有方括号 —— 但为了简单一律摘，这里钉住这个取舍
    assert.equal(phrasesOf("他说[确实]").includes("确实"), false);
  });
});
