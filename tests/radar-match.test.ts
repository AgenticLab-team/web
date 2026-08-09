import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_HITS_PER_DAY,
  MAX_KEYWORD_LENGTH,
  MIN_KEYWORD_LENGTH,
  NOISY_THRESHOLD_7D,
  checkNoise,
  highlight,
  isAsciiWord,
  isNewDay,
  keywordKey,
  matchesKeyword,
  normalizeKeyword,
  shouldNotify,
  validateKeyword,
} from "@/lib/radar/match";
import { dateKey as dateKeyOf } from "@/lib/time";

/**
 * 关键词匹配。
 *
 * 这一组的重点是**中英文的词边界完全不是一回事** ——
 * 同一个规则套两种语言，必然有一种是坏的，而坏掉的那种
 * 要么一天两百条通知，要么一条都收不到。
 */

describe("ASCII 词要卡词边界 —— 不然订阅「AI」会被 said 命中", () => {
  it("**不命中包含它的英文单词**", () => {
    for (const text of ["he said hello", "chain of thought", "rain", "maintain it", "AIR"]) {
      assert.equal(matchesKeyword(text, "AI"), false, `「${text}」被误命中`);
    }
  });

  it("独立出现时命中", () => {
    for (const text of ["AI 很有意思", "关于 AI", "(AI)", "AI, ML", "用AI做的"]) {
      assert.equal(matchesKeyword(text, "AI"), true, `「${text}」没命中`);
    }
  });

  it("**紧挨着汉字算命中** —— 中文里不会加空格", () => {
    assert.equal(matchesKeyword("AI大模型很强", "AI"), true);
    assert.equal(matchesKeyword("这个RAG方案", "RAG"), true);
  });

  it("连字符、下划线、斜杠两侧算命中", () => {
    assert.equal(matchesKeyword("AI-agent", "AI"), true);
    assert.equal(matchesKeyword("use/AI/now", "AI"), true);
    // 下划线算词字符：AI_agent 是一个标识符，和 GPT4 同理
    assert.equal(matchesKeyword("AI_agent", "AI"), false);
  });

  it("大小写无关", () => {
    assert.equal(matchesKeyword("聊聊 ai 的事", "AI"), true);
    assert.equal(matchesKeyword("聊聊 AI 的事", "ai"), true);
  });

  it("数字紧挨着不算 —— 「GPT4」不该被「GPT」命中的场景要说得清", () => {
    assert.equal(matchesKeyword("GPT4 出了", "GPT"), false);
    assert.equal(matchesKeyword("GPT 出了", "GPT"), true);
  });

  it("多词短语按整体匹配", () => {
    assert.equal(matchesKeyword("试试 prompt engineering 吧", "prompt engineering"), true);
    assert.equal(matchesKeyword("prompt 和 engineering", "prompt engineering"), false);
  });
});

describe("CJK 按子串匹配 —— 卡词边界的话一条都命中不了", () => {
  it("中文子串命中", () => {
    assert.equal(matchesKeyword("这个大模型不错", "大模型"), true);
    assert.equal(matchesKeyword("多模态大模型", "大模型"), true);
    assert.equal(matchesKeyword("大模型", "大模型"), true);
  });

  it("不含就不命中", () => {
    assert.equal(matchesKeyword("这个模型不错", "大模型"), false);
  });

  it("中英混合的词按子串 —— 带 CJK 就整体走子串规则", () => {
    assert.equal(matchesKeyword("试试 RAG 检索增强吧", "RAG 检索"), true);
    assert.equal(matchesKeyword("RAG 和检索", "RAG 检索"), false);
  });

  it("词类型判定", () => {
    assert.equal(isAsciiWord("AI"), true);
    assert.equal(isAsciiWord("prompt engineering"), true);
    assert.equal(isAsciiWord("大模型"), false);
    assert.equal(isAsciiWord("RAG检索"), false);
  });
});

describe("边界情况", () => {
  it("空输入不命中也不炸", () => {
    assert.equal(matchesKeyword("", "AI"), false);
    assert.equal(matchesKeyword("AI", ""), false);
    assert.equal(matchesKeyword("", ""), false);
  });

  it("一条消息里多次出现只算命中", () => {
    assert.equal(matchesKeyword("AI AI AI", "AI"), true);
  });

  it("**前面被误命中后面才是真的，要继续找下去**", () => {
    // said 里的 ai 不算，后面独立的 AI 才算 —— 找到第一个就返回 false 是错的
    assert.equal(matchesKeyword("he said, then AI came", "AI"), true);
  });

  it("全角字符归一化后再比", () => {
    assert.equal(matchesKeyword("聊聊 ＡＩ", "AI"), false, "全角字母不做等价，避免误伤");
    assert.equal(keywordKey("　ＲＡＧ　"), "rag");
  });
});

describe("能不能订阅这个词", () => {
  it("正常的词通过", () => {
    const result = validateKeyword("大模型");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.keyword, "大模型");
  });

  it("**一个字的词会命中一切，拦下**", () => {
    for (const word of ["a", "的", "1"]) {
      const result = validateKeyword(word);
      assert.equal(result.ok, false, `「${word}」被放过了`);
      assert.equal(result.ok === false && /太短/.test(result.reason), true);
    }
    assert.equal(MIN_KEYWORD_LENGTH, 2);
  });

  it("空的和纯空白拦下", () => {
    assert.equal(validateKeyword("").ok, false);
    assert.equal(validateKeyword("   ").ok, false);
  });

  it("纯符号拦下 —— 匹配不到东西只会让人以为雷达坏了", () => {
    const result = validateKeyword("!!!");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && /符号/.test(result.reason), true);
  });

  it("太长拦下", () => {
    assert.equal(validateKeyword("一".repeat(MAX_KEYWORD_LENGTH + 1)).ok, false);
    assert.equal(validateKeyword("一".repeat(MAX_KEYWORD_LENGTH)).ok, true);
  });

  it("首尾空白收掉，内部连续空白折成一个", () => {
    const result = validateKeyword("  prompt   engineering  ");
    assert.equal(result.ok && result.keyword, "prompt engineering");
  });

  it("归一化是幂等的", () => {
    for (const raw of ["  AI ", "大 模型", "ＲＡＧ"]) {
      assert.equal(normalizeKeyword(normalizeKeyword(raw)), normalizeKeyword(raw));
    }
  });
});

describe("噪音预估 —— 让人在订阅那一刻就知道后果", () => {
  it("命中不多的正常放行", () => {
    const check = checkNoise(7);
    assert.equal(check.verdict, "ok");
    assert.match(check.message, /7 次/);
  });

  it("**太泛的当场拦下** —— 事后后悔的人不会来精简关键词，会关掉全部通知", () => {
    const check = checkNoise(NOISY_THRESHOLD_7D + 1);
    assert.equal(check.verdict, "noisy");
    assert.match(check.message, /太泛/);
  });

  it("**阈值按生产数据校准过**：AI 拦下，claude / Agent 放行", () => {
    // 近七天真实命中数（19,632 条可扫消息）
    assert.equal(checkNoise(343).verdict, "noisy", "「AI」该拦");
    assert.notEqual(checkNoise(91).verdict, "noisy", "「Agent」不该被拦");
    assert.notEqual(checkNoise(67).verdict, "noisy", "「claude」不该被拦");
    assert.equal(checkNoise(24).verdict, "ok", "「大模型」该畅通");
  });

  it("拦下的理由要说清楚后果，而不是只说「太吵」", () => {
    // 每天封顶已经兜住了打扰量，真正的问题是通知内容变成随机采样
    assert.match(checkNoise(343).message, /随机/);
  });

  it("中间地带提醒但不拦", () => {
    const check = checkNoise(NOISY_THRESHOLD_7D / 2 + 1);
    assert.equal(check.verdict, "busy");
    assert.match(check.message, /频繁/);
  });

  it("一次都没命中时如实说，不假装是好事", () => {
    const check = checkNoise(0);
    assert.equal(check.verdict, "ok");
    assert.match(check.message, /也可能就是没人聊这个/);
  });

  it("换算成每天几次 —— 「七天 40 次」不如「每天六次」直观", () => {
    assert.equal(checkNoise(70).perDay, 10);
    assert.equal(checkNoise(7).perDay, 1);
  });
});

describe("每天封顶", () => {
  const NOW = 1_800_000_000_000;

  it("没到上限就提醒", () => {
    assert.equal(shouldNotify({ hitsToday: 0, lastNotifiedAt: null, now: NOW }).notify, true);
  });

  it("**到了上限当天闭嘴** —— 已经知道有人在聊了", () => {
    const result = shouldNotify({ hitsToday: MAX_HITS_PER_DAY, lastNotifiedAt: null, now: NOW });
    assert.equal(result.notify, false);
    assert.match(result.reason, /明天/);
  });

  it("刚提醒过就等一会儿 —— 一串连续讨论不该变成一串连续通知", () => {
    const result = shouldNotify({ hitsToday: 1, lastNotifiedAt: NOW - 60_000, now: NOW });
    assert.equal(result.notify, false);
    assert.match(result.reason, /刚提醒过/);
  });

  it("间隔够了就能再提醒", () => {
    assert.equal(
      shouldNotify({ hitsToday: 1, lastNotifiedAt: NOW - 11 * 60_000, now: NOW }).notify,
      true,
    );
  });

  it("**第二天要重置** —— 一次热闹不该让这个订阅永远失效", () => {
    assert.equal(isNewDay(NOW - 86_400_000, NOW), true);
    assert.equal(isNewDay(NOW - 1000, NOW), false);
    assert.equal(isNewDay(null, NOW), true);
  });

  it("**「一天」按东八区算** —— 和签到连胜用的是同一个边界", () => {
    /*
     * 这条曾经用服务器本地时区算，在 PDT 的机器上跑出来的日界
     * 和签到差了整整一天 —— 而差的那一天没有任何地方看得出来。
     */
    // 2026-01-01 07:00 UTC = 东八区 15:00，同一天
    assert.equal(isNewDay(Date.UTC(2026, 0, 1, 1), Date.UTC(2026, 0, 1, 7)), false);
    // 东八区的日界在 UTC 16:00
    assert.equal(isNewDay(Date.UTC(2026, 0, 1, 15), Date.UTC(2026, 0, 1, 17)), true);
    assert.equal(dateKeyOf(Date.UTC(2026, 0, 1, 17)), "2026-01-02");
  });
});

describe("通知里的上下文", () => {
  it("命中处前后各截一段", () => {
    const content = `${"前".repeat(100)}大模型${"后".repeat(100)}`;
    const snippet = highlight(content, "大模型", 10);
    assert.match(snippet ?? "", /大模型/);
    assert.ok((snippet?.length ?? 0) < 40);
    assert.ok(snippet?.startsWith("…"));
    assert.ok(snippet?.endsWith("…"));
  });

  it("短消息整条给出，不加省略号", () => {
    assert.equal(highlight("聊聊大模型", "大模型"), "聊聊大模型");
  });

  it("没命中返回 null", () => {
    assert.equal(highlight("无关内容", "大模型"), null);
  });
});
