import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collapseUnchanged, diffLines } from "@/lib/diff";
import { truncateAtBoundary } from "@/lib/text";

/**
 * 交互层的纯逻辑测试。
 *
 * 手势与快捷键的 DOM 行为没法在 Node 里跑，
 * 但它们背后的判定规则是纯的 —— 而恰恰是这些规则写错了最烦人：
 * 输入框里被拦截按键、竖滑被误判成横滑。
 */

/** 与 Shortcuts.tsx 里 isTyping 一致的判定，用同一份规则描述 */
function shouldIgnoreKey(tag: string, editable = false, inDialog = false): boolean {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(tag) || editable || inDialog;
}

describe("快捷键的拦截边界", () => {
  it("**输入框里一律不拦截**", () => {
    // 写帖子时按 J 应该打出字母 J，而不是跳到下一条
    assert.equal(shouldIgnoreKey("INPUT"), true);
    assert.equal(shouldIgnoreKey("TEXTAREA"), true);
    assert.equal(shouldIgnoreKey("SELECT"), true);
  });

  it("富文本编辑区也不拦截", () => {
    assert.equal(shouldIgnoreKey("DIV", true), true);
  });

  it("对话框里不触发全局跳转", () => {
    assert.equal(shouldIgnoreKey("BUTTON", false, true), true);
  });

  it("普通区域正常拦截", () => {
    assert.equal(shouldIgnoreKey("BODY"), false);
    assert.equal(shouldIgnoreKey("DIV"), false);
  });
});

/** 与 SwipeRow 一致的方向判定 */
function swipeDirection(dx: number, dy: number, threshold = 6): "none" | "horizontal" | "vertical" {
  if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return "none";
  return Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
}

describe("滑动方向判定", () => {
  it("小位移先不判定，等用户意图明确", () => {
    assert.equal(swipeDirection(2, 3), "none");
  });

  it("横向位移大于纵向才算横滑", () => {
    assert.equal(swipeDirection(-40, 5), "horizontal");
  });

  it("**竖滑不能被误判成横滑**，否则页面滚不动", () => {
    assert.equal(swipeDirection(8, 40), "vertical");
    assert.equal(swipeDirection(-8, -40), "vertical");
  });

  it("斜着滑时以主方向为准", () => {
    assert.equal(swipeDirection(-30, 20), "horizontal");
    assert.equal(swipeDirection(-20, 30), "vertical");
  });
});

/** 与 SwipeRow 一致的阻尼计算 */
function damp(raw: number, maxOffset: number): number {
  if (raw > 0) return raw * 0.25;
  if (raw < -maxOffset) return -maxOffset - (-raw - maxOffset) * 0.3;
  return raw;
}

describe("滑动阻尼", () => {
  it("正常范围内 1:1 跟手", () => {
    assert.equal(damp(-50, 144), -50);
  });

  it("反向拉时明显变沉，暗示这个方向没内容", () => {
    assert.equal(damp(40, 144), 10);
  });

  it("拉过头时递减而不是硬停", () => {
    const past = damp(-200, 144);
    assert.ok(past < -144, "还能继续动一点");
    assert.ok(past > -200, "但比手指走得慢");
  });
});

/** 吸附：过半展开，否则回弹 */
function snap(offset: number, maxOffset: number): number {
  return offset < -maxOffset / 2 ? -maxOffset : 0;
}

describe("松手吸附", () => {
  it("过半吸附到展开", () => {
    assert.equal(snap(-100, 144), -144);
  });

  it("不到一半回弹", () => {
    assert.equal(snap(-40, 144), 0);
  });

  it("正好一半算回弹，不做模糊处理", () => {
    assert.equal(snap(-72, 144), 0);
  });
});

describe("骨架屏与内容的一致性", () => {
  it("摘要截断在骨架宽度范围内不会溢出", () => {
    // 骨架预告的是形状，真实内容明显超出就会有跳动
    const out = truncateAtBoundary("这是一段很长的摘要文字用来验证截断行为是否稳定可靠", 20);
    assert.ok(out.length <= 21, `截断后 ${out.length} 字`);
  });
});

describe("编辑历史折叠", () => {
  it("只改一行时视图明显短于全文", () => {
    const before = Array.from({ length: 50 }, (_, i) => `第 ${i} 行`).join("\n");
    const after = before.replace("第 25 行", "第 25 行（改过）");
    const collapsed = collapseUnchanged(diffLines(before, after), 2);
    assert.ok(collapsed.length < 15, `折叠后 ${collapsed.length} 项，应远小于 50`);
  });
});
