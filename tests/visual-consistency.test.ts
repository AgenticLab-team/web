import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readCode, srcRoot, walkSource } from "./_source";

/**
 * 长相的变体数量。
 *
 * ═════════════════════════════════════════
 * 「乱」是可以数出来的
 * ═════════════════════════════════════════
 *
 * 站长两次说界面乱。第二次我没有再凭感觉调，而是数了一遍：
 *
 *   按钮内边距 —— 十派以上，前五派各自都有二十处以上
 *   圆角 —— `rounded-full` 75 处、`rounded-[var(--radius-pill)]` 61 处，
 *           而 `--radius-pill` 就是 999px（同一件事的两种写法），
 *           另有十九处硬编码数值绕过了 token
 *
 * 没有人是故意的：没有共享按钮时，每个人都得当场决定一次内边距，
 * 而每次决定都有它的理由。攒到一百次，页面上就没有两个按钮一样高。
 *
 * ─────────────────────────────────────────
 * 为什么是「棘轮」而不是「归零」
 * ─────────────────────────────────────────
 *
 * 一次性把三百多处调用点全改掉，风险远大于收益 ——
 * 那种大改动没人 review 得动，而且一旦改错，错的是**看起来**没错。
 *
 * 所以记下当前的数字，只允许往下走。新代码用共享构件就不会加分，
 * 老代码顺手改一处就少一分。这条线不会自己变好，但它保证不会变坏。
 */

const TSX = walkSource(srcRoot()).filter((f) => f.endsWith(".tsx"));

function countAll(pattern: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  for (const file of TSX) {
    const code = readCode(file.slice(srcRoot().length + 1));
    for (const m of code.matchAll(pattern)) {
      out.set(m[0], (out.get(m[0]) ?? 0) + 1);
    }
  }
  return out;
}

describe("圆角只走 token", () => {
  it("**界面构件的圆角一律走 token**", () => {
    /*
     * 绕过 --radius-* 的地方，哪天想把全站圆角调柔一点一个都不会跟着变，
     * 而它们和旁边的卡片差那么两个像素，看起来就是没对齐。
     *
     * 原来有 30 处，七种写法（0.375 / 0.5 / 0.4 / 0.4375 / 0.3 /
     * 0.3125 / 0.25 rem 外加 lg、md）。根因不是大家不小心，是**尺度上
     * 有个洞**：只有 control(10px) / card(14px) / pill(999px)，
     * 中间到小尺寸是空的，需要 6~8px 的人只能当场编一个。
     * 补了 `--radius-chip` (6px) 之后它们才有地方可去。
     */
    const hard = countAll(/\brounded-(?:md|lg|xl|2xl|3xl)\b|\brounded-\[0?\.[0-9]/g);
    assert.deepEqual(
      [...hard.keys()],
      [],
      `这些绕过了 token：${[...hard.keys()].join("、")}。` +
        `用 rounded-[var(--radius-chip|control|card|pill)]`,
    );
  });

  it("几像素的图表小条不算 —— 那不是界面构件", () => {
    /*
     * `rounded-[2px]` 用在活跃度热力图那种一两像素的小方块上。
     * 把它们也扭成 --radius-chip(6px) 会让 4px 高的条变成半圆，
     * 那不是统一，是错。所以这一类明确豁免，但盯着别涨。
     */
    const tiny = countAll(/\brounded-\[[0-9]px\]|\brounded-sm\b/g);
    const total = [...tiny.values()].reduce((a, b) => a + b, 0);
    assert.ok(total <= 8, `几像素圆角涨到 ${total} 处（基线 8）—— 确认它们真的是图表而不是构件`);
  });
});

describe("按钮的长相只有一处定义", () => {
  it("**共享层有 buttonClass**", () => {
    const src = readCode("components/ui/primitives.tsx");
    assert.match(src, /export function buttonClass/);
  });

  it("**两套 kit 都委托给它，不各留一份**", () => {
    /*
     * 三个 agent 并行重构时，各自建了一套 kit —— 各自都很合理，
     * 合起来的效果是全站按钮比重构之前更多样。
     * 分工现在是：共享层管长相，各 kit 管自己的规矩。
     */
    for (const f of ["components/admin/ui.tsx", "components/api/fields.tsx"]) {
      const code = readCode(f);
      assert.match(code, /buttonClass\(/, `${f} 没有用共享的 buttonClass`);
      assert.equal(
        /(?:TONE|SIZE)_CLASS\s*[:=]\s*(?:Record<[^>]*>\s*=\s*)?\{/.test(code),
        false,
        `${f} 又自己留了一份 tone/size 表`,
      );
    }
  });

  it("按钮内边距的派别不再增加", () => {
    /*
     * 数的是所有 `px-N py-M` 组合。它不区分按钮和别的盒子，
     * 所以绝对值没有意义 —— **有意义的是它不再往上走**。
     */
    const pads = countAll(/\bpx-[0-9.]+ py-[0-9.]+\b/g);
    assert.ok(
      pads.size <= 38,
      `内边距派别涨到 ${pads.size} 种（基线 38）。新的那种能不能用 buttonClass / CONTROL？`,
    );
  });
});
