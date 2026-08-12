import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readCode, srcRoot, walkSource } from "./_source";

/**
 * 暗色下看不见的字。
 *
 * ═════════════════════════════════════════
 * `text-white` 压在 `--danger` 上，实测 2.55:1
 * ═════════════════════════════════════════
 *
 * 亮色的 `--danger` 是 #bf3b2c（深砖红），白字压上去 5.42:1，没问题。
 * **暗色的 `--danger` 是 #ff7a6b（浅珊瑚）**，白字只有 2.55:1 ——
 * 远低于 WCAG AA 要求的 4.5:1，封禁键、删除键上的字基本看不见。
 *
 * 而这不会有人来报：它只在暗色模式下出现，而会去点那些按钮的人
 * 本来就知道那儿有个按钮。全站曾经有二十多处。
 *
 * 根子是 `--accent` 一直有配套的 `--accent-ink`，而 `--danger` 没有 ——
 * 于是每个人都只能手写 `text-white`。补上 `--danger-ink` 之后
 * （亮 5.42、暗 7.18），这一条负责让它不再退回去。
 */

/** 实测对比度，照 WCAG 的相对亮度公式 */
function contrast(a: string, b: string): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const CSS = readCode("app/globals.css");

/** 从 globals.css 里取某个变量在某一段里的值 */
function tokenIn(section: string, name: string): string {
  const at = CSS.indexOf(section);
  assert.ok(at >= 0, `找不到 ${section}`);
  const m = CSS.slice(at).match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(m, `${section} 里没有 ${name}`);
  return m[1];
}

describe("危险色的前景", () => {
  it("**亮色和暗色都过 4.5:1**", () => {
    const light = contrast(tokenIn(":root {", "--danger-ink"), tokenIn(":root {", "--danger"));
    const dark = contrast(
      tokenIn('prefers-color-scheme: dark', "--danger-ink"),
      tokenIn('prefers-color-scheme: dark', "--danger"),
    );
    assert.ok(light >= 4.5, `亮色只有 ${light.toFixed(2)}:1`);
    assert.ok(dark >= 4.5, `暗色只有 ${dark.toFixed(2)}:1`);
  });

  it("**三个地方都定义了** —— 少一处，手动切暗色时白字就回来了", () => {
    /*
     * 配色有三态：显式浅、显式深、跟随系统。少定义一处的结果是
     * 只有其中一条路上的字看不见 —— 而那正是最难复现的那种报告。
     */
    assert.equal((CSS.match(/--danger-ink:/g) ?? []).length, 3);
  });
});

describe("没有人再手写白字压在危险色上", () => {
  it("**全站扫一遍**", () => {
    const offenders: string[] = [];
    for (const file of walkSource(srcRoot())) {
      if (!/\.tsx$/.test(file)) continue;
      const code = readCode(file.slice(srcRoot().length + 1));
      /*
       * 只看**同一个 className 串里**同时出现两者的。
       * 分开出现在文件不同处是正常的（比如一个用 danger 底、
       * 另一个是别的地方的白字）。
       */
      for (const m of code.matchAll(/className=\{?[`"][^`"]*[`"]/g)) {
        const s = m[0];
        if (s.includes("--danger)") && /\btext-white\b/.test(s)) {
          offenders.push(file.slice(srcRoot().length + 1));
        }
      }
    }
    assert.deepEqual(
      [...new Set(offenders)],
      [],
      `这些地方的字在暗色下只有 2.55:1：${[...new Set(offenders)].join("、")}`,
    );
  });
});
