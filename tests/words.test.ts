import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MIN_WORD_LENGTH,
  checkWord,
  kindLabel,
  normalizeForMatch,
  scanText,
  type WordRule,
} from "@/lib/moderation/words";

/**
 * 敏感词匹配。
 *
 * 直接 includes 的规避成本太低了：加个空格、换成全角、
 * 中间插个标点就绕过去了。但归一化会打乱下标，
 * 而替换和高亮都需要**原文的位置** —— 那张映射表是这个模块的核心。
 *
 * 另一头：**误伤比漏判更该怕**。子串匹配必然误伤，
 * 所以默认档位是送审不是拦截，词长有下限。
 */

const rule = (over: Partial<WordRule> = {}): WordRule => ({
  id: "r1",
  word: "违禁词",
  kind: "review",
  replacement: null,
  enabled: true,
  ...over,
});

describe("归一化", () => {
  it("去掉空白", () => {
    assert.equal(normalizeForMatch("违 禁 词"), "违禁词");
  });

  it("去掉标点", () => {
    assert.equal(normalizeForMatch("违·禁-词"), "违禁词");
    assert.equal(normalizeForMatch("违！禁。词"), "违禁词");
  });

  it("**全角转半角**", () => {
    assert.equal(normalizeForMatch("ＡＢＣ"), "abc");
  });

  it("英文统一小写", () => {
    assert.equal(normalizeForMatch("SpAm"), "spam");
  });

  it("**零宽字符也要去掉** —— 那是最隐蔽的一种插入", () => {
    assert.equal(normalizeForMatch("违​禁‍词"), "违禁词");
  });

  it("emoji 不会被拆成半个字符", () => {
    assert.doesNotThrow(() => normalizeForMatch("你好🎉世界"));
  });
});

describe("匹配", () => {
  const rules = [rule()];

  it("直接命中", () => {
    const r = scanText("这里有违禁词", rules);
    assert.equal(r.hits.length, 1);
    assert.equal(r.verdict, "review");
  });

  it("没命中就放行", () => {
    assert.equal(scanText("一段正常的话", rules).verdict, "pass");
  });

  it("**插空格绕不过去**", () => {
    assert.equal(scanText("违 禁 词", rules).hits.length, 1);
  });

  it("**插标点绕不过去**", () => {
    assert.equal(scanText("违-禁-词", rules).hits.length, 1);
  });

  it("**全角绕不过去**", () => {
    const r = scanText("这是ＳＰＡＭ内容", [rule({ word: "spam" })]);
    assert.equal(r.hits.length, 1);
  });

  it("一段话里多次出现会全部命中", () => {
    assert.equal(scanText("违禁词又是违禁词", rules).hits.length, 2);
  });

  it("停用的规则不参与匹配", () => {
    assert.equal(scanText("违禁词", [rule({ enabled: false })]).verdict, "pass");
  });

  it("空文本与空规则表都不炸", () => {
    assert.equal(scanText("", rules).verdict, "pass");
    assert.equal(scanText("任意内容", []).verdict, "pass");
  });

  it("词条自身带空格时也能正常工作", () => {
    // 管理员手滑多打了空格，不该让整条规则失效
    assert.equal(scanText("违禁词", [rule({ word: " 违禁 词 " })]).hits.length, 1);
  });
});

describe("原文位置", () => {
  it("**命中位置映射回原文，而不是归一化后的串**", () => {
    // 少了这张映射表，替换就只能整段重写，用户的排版和标点全毁
    const r = scanText("前缀 违 禁 词 后缀", [rule()]);
    const hit = r.hits[0];
    assert.equal("前缀 违 禁 词 后缀".slice(hit.start, hit.end), "违 禁 词");
  });

  it("命中片段包含被归一化掉的字符", () => {
    const r = scanText("违-禁-词", [rule()]);
    assert.equal(r.hits[0].matched, "违-禁-词");
  });

  it("开头命中时下标是 0", () => {
    const r = scanText("违禁词在开头", [rule()]);
    assert.equal(r.hits[0].start, 0);
  });
});

describe("档位优先级", () => {
  it("拦截优先于送审", () => {
    const r = scanText("有违禁词也有敏感词", [
      rule({ id: "a", word: "违禁词", kind: "review" }),
      rule({ id: "b", word: "敏感词", kind: "block" }),
    ]);
    assert.equal(r.verdict, "block");
  });

  it("送审优先于替换", () => {
    const r = scanText("违禁词和脏话", [
      rule({ id: "a", word: "违禁词", kind: "review" }),
      rule({ id: "b", word: "脏话", kind: "replace", replacement: "***" }),
    ]);
    assert.equal(r.verdict, "review");
  });

  it("只有替换时是放行", () => {
    const r = scanText("脏话", [rule({ word: "脏话", kind: "replace", replacement: "***" })]);
    assert.equal(r.verdict, "pass");
  });

  it("**被拦截时不做替换** —— 替换后的结果本来就不该发出去", () => {
    const r = scanText("违禁词和脏话", [
      rule({ id: "a", word: "违禁词", kind: "block" }),
      rule({ id: "b", word: "脏话", kind: "replace", replacement: "***" }),
    ]);
    assert.equal(r.verdict, "block");
    assert.equal(r.replaced, "违禁词和脏话");
  });

  it("给出触发结论的具体规则，供管理员复核", () => {
    const r = scanText("违禁词", [rule()]);
    assert.equal(r.triggeredBy.length, 1);
    assert.equal(r.triggeredBy[0].word, "违禁词");
  });
});

describe("替换", () => {
  it("替换掉命中的部分", () => {
    const r = scanText("这是脏话内容", [rule({ word: "脏话", kind: "replace", replacement: "***" })]);
    assert.equal(r.replaced, "这是***内容");
  });

  it("**多处命中时全部替换且位置正确**", () => {
    // 从前往后替的话，第一次替换就会让后面所有下标失效
    const r = scanText("脏话在前，脏话在后", [
      rule({ word: "脏话", kind: "replace", replacement: "**" }),
    ]);
    assert.equal(r.replaced, "**在前，**在后");
  });

  it("**替换长度不同也不会错位**", () => {
    const r = scanText("abc x abc", [
      rule({ word: "abc", kind: "replace", replacement: "很长很长的替换文本" }),
    ]);
    assert.equal(r.replaced, "很长很长的替换文本 x 很长很长的替换文本");
  });

  it("被归一化掉的字符会一并被替换掉", () => {
    const r = scanText("脏 话", [rule({ word: "脏话", kind: "replace", replacement: "**" })]);
    assert.equal(r.replaced, "**");
  });

  it("没有替换类命中时原文不变", () => {
    assert.equal(scanText("正常内容", [rule()]).replaced, "正常内容");
  });

  it("重叠命中不会替出乱码", () => {
    const r = scanText("aabb", [
      rule({ id: "a", word: "aab", kind: "replace", replacement: "X" }),
      rule({ id: "b", word: "abb", kind: "replace", replacement: "Y" }),
    ]);
    // 具体保留哪个不重要，重要的是结果是一段完整的合法文本
    assert.ok(r.replaced.length > 0);
    assert.ok(!r.replaced.includes("undefined"));
  });
});

describe("词条校验", () => {
  it("正常词条通过", () => {
    assert.equal(checkWord({ word: "违禁词", kind: "review", replacement: null }).ok, true);
  });

  it("空词条不行", () => {
    assert.equal(checkWord({ word: "   ", kind: "review", replacement: null }).ok, false);
  });

  it("**太短的词不行** —— 一个字几乎匹配一切", () => {
    const r = checkWord({ word: "的", kind: "review", replacement: null });
    assert.equal(r.ok, false);
    assert.match(r.error!, new RegExp(String(MIN_WORD_LENGTH)));
  });

  it("**靠标点凑长度也不行**", () => {
    // 「的！」归一化后只剩一个字
    assert.equal(checkWord({ word: "的！", kind: "review", replacement: null }).ok, false);
  });

  it("替换档必须填替换文本", () => {
    assert.equal(checkWord({ word: "脏话", kind: "replace", replacement: null }).ok, false);
    assert.equal(checkWord({ word: "脏话", kind: "replace", replacement: " " }).ok, false);
  });

  it("**替换文本里不能再包含这个词**", () => {
    // 替了等于没替，而且容易让人误以为规则没生效
    assert.equal(
      checkWord({ word: "脏话", kind: "replace", replacement: "这是脏话啦" }).ok,
      false,
    );
  });

  it("替换文本合法时通过", () => {
    assert.equal(checkWord({ word: "脏话", kind: "replace", replacement: "***" }).ok, true);
  });
});

describe("档位文案", () => {
  it("三档都有中文名", () => {
    assert.equal(kindLabel("block"), "拦截");
    assert.equal(kindLabel("review"), "送审");
    assert.equal(kindLabel("replace"), "替换");
  });

  it("未知档位原样返回", () => {
    assert.equal(kindLabel("nuke"), "nuke");
  });
});
