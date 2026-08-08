import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildMatchExpression, desegment, segmentForIndex } from "@/lib/db/fts";
import { isQualityMessage } from "@/lib/quality";
import { dateKey, daysBetween, endOfDayMs, hourOf, shiftDateKey, startOfDayMs } from "@/lib/time";

describe("高质量消息判定", () => {
  // 这条规则是 calibrate.ts 反推出来的，与上游榜单 10/10 吻合。
  // 改动会让网站积分与机器人在群里报的排名对不上，所以锁在测试里。
  it("text 与 quote 达到字数即计入", () => {
    assert.equal(isQualityMessage({ type: "text", length: 15 }, 15), true);
    assert.equal(isQualityMessage({ type: "quote", length: 40 }, 15), true);
  });

  it("字数不足不计入", () => {
    assert.equal(isQualityMessage({ type: "text", length: 14 }, 15), false);
  });

  it("图片表情等非文本类型一律不计入", () => {
    for (const type of ["image", "sticker", "app", "video_account", "file", "system"]) {
      assert.equal(isQualityMessage({ type, length: 999 }, 15), false, `${type} 不该计入`);
    }
  });

  it("阈值可配", () => {
    assert.equal(isQualityMessage({ type: "text", length: 10 }, 5), true);
    assert.equal(isQualityMessage({ type: "text", length: 10 }, 20), false);
  });
});

describe("中文全文检索", () => {
  it("CJK 逐字切开，ASCII 保持原样", () => {
    assert.equal(segmentForIndex("鉴权方案"), "鉴 权 方 案 ");
    assert.equal(segmentForIndex("MCP 鉴权"), "MCP 鉴 权 ");
    assert.equal(segmentForIndex("hello world"), "hello world");
  });

  it("两字中文查询能生成短语表达式", () => {
    // trigram 分词器对 2 字查询完全失效，这正是改用逐字切分的原因
    assert.equal(buildMatchExpression("鉴权"), '"鉴 权"');
  });

  it("多个词之间是 AND", () => {
    assert.equal(buildMatchExpression("模型 部署"), '"模 型" "部 署"');
  });

  it("剔除会让 FTS5 解析失败的语法字符", () => {
    assert.equal(buildMatchExpression('鉴权"OR"1'), '"鉴 权" "OR" "1"');
    assert.equal(buildMatchExpression("a*b"), '"a" "b"');
  });

  it("空查询返回 null，调用方应跳过检索", () => {
    assert.equal(buildMatchExpression(""), null);
    assert.equal(buildMatchExpression("   "), null);
    assert.equal(buildMatchExpression('"*()'), null);
  });

  it("desegment 能还原展示文本", () => {
    assert.equal(desegment(segmentForIndex("鉴权方案").trim()), "鉴权方案");
  });
});

describe("社群时区边界", () => {
  // 打卡、连胜、日榜都按东八区切日。用 UTC 会让晚上 8 点后的发言算到第二天。
  it("东八区 00:30 属于当天，UTC 下却是前一天", () => {
    const ts = Date.UTC(2026, 7, 8, 16, 30); // UTC 16:30 = 东八区次日 00:30
    assert.equal(dateKey(ts), "2026-08-09");
    assert.equal(new Date(ts).toISOString().slice(0, 10), "2026-08-08");
  });

  it("东八区 23:59 仍属当天", () => {
    const ts = Date.UTC(2026, 7, 8, 15, 59);
    assert.equal(dateKey(ts), "2026-08-08");
    assert.equal(hourOf(ts), 23);
  });

  it("日期加减跨月正确", () => {
    assert.equal(shiftDateKey("2026-08-01", -1), "2026-07-31");
    assert.equal(shiftDateKey("2026-02-28", 1), "2026-03-01");
    assert.equal(shiftDateKey("2026-12-31", 1), "2027-01-01");
  });

  it("天数差计算正确", () => {
    assert.equal(daysBetween("2026-08-01", "2026-08-08"), 7);
    assert.equal(daysBetween("2026-08-08", "2026-08-08"), 0);
  });

  it("日起点是东八区零点，不是 UTC 零点", () => {
    const start = startOfDayMs("2026-08-08");
    assert.equal(dateKey(start), "2026-08-08");
    // 再往前 1 毫秒必须落到前一天，否则「今日消息数」会多算 8 小时的量
    assert.equal(dateKey(start - 1), "2026-08-07");
  });

  it("日结束点不含次日零点", () => {
    const end = endOfDayMs("2026-08-08");
    assert.equal(dateKey(end - 1), "2026-08-08");
    assert.equal(dateKey(end), "2026-08-09");
  });

  it("起止点正好差一天", () => {
    assert.equal(endOfDayMs("2026-08-08") - startOfDayMs("2026-08-08"), 86_400_000);
  });
});
