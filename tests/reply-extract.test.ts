import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractReplyTarget } from "@/lib/messages/reply";

/**
 * 引用目标提取的测试。
 *
 * 注意：上游 /v1/messages 目前把 quote 消息的 content 归一化成纯回复文本
 * （实测见 src/lib/messages/reply.ts），所以「纯文本 → null」不是边界情况，
 * 而是现阶段 100% 的输入 —— 它必须稳定返回 null，任何猜测都是事故。
 */
describe("引用目标提取", () => {
  it("纯文本（上游现状）→ null，绝不猜", () => {
    assert.equal(extractReplyTarget("这酒店人还怪好的嘞"), null);
    assert.equal(extractReplyTarget("有道理"), null);
    assert.equal(extractReplyTarget(""), null);
  });

  it("微信 refermsg 原文形态：<svrid> 子标签", () => {
    const xml =
      "<appmsg><title>有道理</title><refermsg><type>1</type>" +
      "<svrid>8270683534514720997</svrid><fromusr>wxid_x</fromusr>" +
      "<content>原话</content></refermsg></appmsg>";
    assert.equal(extractReplyTarget(xml), "8270683534514720997");
  });

  it("属性形态：svrid=\"...\"", () => {
    assert.equal(
      extractReplyTarget('<refermsg type="1" svrid="123456789">原话</refermsg>'),
      "123456789",
    );
  });

  it("svrid 只认 refermsg 块内的 —— 块外的是消息自己的 id", () => {
    const xml =
      "<appmsg><svrid>111</svrid><refermsg><svrid>222</svrid></refermsg></appmsg>";
    assert.equal(extractReplyTarget(xml), "222");
  });

  it("refermsg 块里没有 svrid → null（残缺数据不硬凑）", () => {
    assert.equal(extractReplyTarget("<refermsg><type>1</type></refermsg>"), null);
  });

  it("正文里碰巧出现『<refermsg』字样但没有 svrid → null", () => {
    assert.equal(extractReplyTarget("聊聊 <refermsg 这个标签的作用"), null);
  });
});
