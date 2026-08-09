import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ImageResponse } from "next/og";

import { MAX_IMAGE_MESSAGES, trimForImage, type ShareMessage } from "@/lib/share/rules";
import { WindowCard } from "@/app/api/share/window/[id]/card/card";

/**
 * 群聊转发图**画不画得出来**。
 *
 * ─────────────────────────────────────────
 * 为什么要真的画一遍，而不是只断言规则
 * ─────────────────────────────────────────
 *
 * tests/share.test.ts 断言的是「该不该给生成」——那一层一直是对的。
 * 但图还有第二关：**satori 认不认这段 JSX**。这一关过去没人守，
 * 于是站长报的那个「转发图有 bug」是这样的：
 *
 *   12 条以内的对话照常出图，超过 12 条的一转发就 500。
 *
 * 成因是图上那行「…前面还有 N 条」：JSX 把它拆成三个子节点
 * （两段文字 + 一个表达式），而 satori 对 `<div>` 的规矩是
 * **子节点多于一个又没写 display 就直接抛**。
 * 只有「省略了几条」这一行会走到那个分支，所以症状是
 * 「有时候能生成有时候不能」，光看代码很难想到。
 *
 * 这类错误只有真的跑一遍渲染才抓得到，所以下面每条都出一张真图。
 */

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

function conversation(count: number): ShareMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    senderName: `成员${i % 3}`,
    content: `第 ${i} 条消息，随便说点什么内容`,
    ts: 1_700_000_000_000 + i * 1000,
  }));
}

/** 走完整条渲染链路，返回真实的 PNG 字节 */
async function render(count: number): Promise<Buffer> {
  const { shown, omitted } = trimForImage(conversation(count));
  const response = new ImageResponse(WindowCard({ shown, omitted }), {
    width: 1080,
    height: 1350,
  });
  return Buffer.from(await response.arrayBuffer());
}

function isPng(buf: Buffer): boolean {
  return buf.length > 1000 && buf.subarray(0, 4).toString("latin1") === "\x89PNG";
}

describe("**长对话也要画得出来** —— 超过一屏的那种才是最想转发的", () => {
  it("超过上限时不能炸 —— 站长报的就是这一条", async () => {
    /*
     * 一段对话平均 9 条、上限 40 条（见 lib/search/windows.ts），
     * 所以「超过 12 条」是常态而不是边角情况。
     * 这一条炸掉的时候，越值得转发的对话越转不出去。
     */
    const buf = await render(MAX_IMAGE_MESSAGES + 8);
    assert.ok(isPng(buf), "超过上限的对话画不出图");
  });

  it("刚好越过上限的那一条也要画得出来", async () => {
    // 边界只差一条，而这一条决定了走不走「…前面还有 N 条」那个分支
    const buf = await render(MAX_IMAGE_MESSAGES + 1);
    assert.ok(isPng(buf), "刚好多出一条就画不出来了");
  });

  it("没超上限的照常出图 —— 修长对话不能把短对话弄坏", async () => {
    const buf = await render(5);
    assert.ok(isPng(buf), "短对话画不出图");
  });

  it("一条都没有也不能炸 —— 消息被存储裁剪之后就是这个样子", async () => {
    const buf = await render(0);
    assert.ok(isPng(buf), "空对话画不出图");
  });
});

describe("**图上永远不出现群名**", () => {
  it("画面这一层也不碰 groups —— 不是「查了不画」，是压根不取", () => {
    /*
     * 「这条消息来自哪个群」比消息本身敏感得多：
     * 它同时泄露了群的存在、群的主题、以及分享者在那个群里。
     *
     * 路由那一层 tests/share.test.ts 已经守住了；画面拆成单独文件之后
     * 这里也要守一遍 —— 否则下一个人会很自然地在画面里加个抬头。
     */
    const card = strip(src("app/api/share/window/[id]/card/card.tsx"));
    assert.doesNotMatch(card, /groups/, "画面里碰了 groups");
    assert.doesNotMatch(card, /groupName|convId/, "画面里出现了群的身份");
  });
});
