import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * 带内边距的行内元素必须显式声明 display。
 *
 * ─────────────────────────────────────────
 * 「左边半圆 / 中间文字 / 右边半圆」三行
 * ─────────────────────────────────────────
 *
 * 站长报的这个现象，原因不在样式表，在排版规则：
 *
 * `<a>` 默认是 `display: inline`。一个 inline 元素里放进任何**块级子元素**
 * （最常见的是一个 `flex` 的 `<span>`，用来让图标和文字并排），
 * 排版引擎会把这个 inline 盒子**劈成三段**：子元素之前的、子元素本身、
 * 子元素之后的。而圆角和背景是**按段画**的 ——
 * 于是屏幕上出现三行：左半圆、中间那块、右半圆。
 *
 * 附带的第二个毛病：**inline 元素的垂直 padding 不参与行高计算**，
 * 所以 `py-1.5` 在这种写法下根本撑不开药丸。
 *
 * 两个毛病都不会报错、不会有任何测试变红 —— 只会长得不对。
 * 而「长得不对」这件事，只有真的打开那一页的人才看得见。
 */

const root = new URL("..", import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === "node_modules" || name.name.startsWith(".")) continue;
    const full = join(dir, name.name);
    if (name.isDirectory()) walk(full, out);
    else if (name.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** 声明了 display 就没问题 */
const HAS_DISPLAY =
  /\b(inline-flex|inline-block|inline-grid|flex|grid|block|contents|table|hidden|sr-only)\b/;

/** 这些前缀带的 display 只在某个断点生效，不算数 */
const stripResponsive = (cls: string) =>
  cls.replace(/\b(sm|md|lg|xl|2xl|hover|focus|group-hover|peer|dark|print):[^\s]*/g, "");

describe("**带内边距圆角的 `<a>` / `<Link>` 必须显式声明 display**", () => {
  const files = [...walk(join(root, "src", "app")), ...walk(join(root, "src", "components"))];

  const offenders: string[] = [];

  for (const file of files) {
    const body = readFileSync(file, "utf8");

    // 抓 <Link ...> 和 <a ...> 上的 className={`...`} 或 className="..."
    for (const m of body.matchAll(
      /<(Link|a)\b[^>]*?className=(?:\{`([^`]*)`\}|"([^"]*)")/g,
    )) {
      const raw = m[2] ?? m[3] ?? "";
      const cls = stripResponsive(raw);

      // 只管那些「看起来是个按钮/药丸」的：有圆角，而且有内边距
      const looksLikeChip = /\brounded-/.test(cls) && /\bp[xy]?-/.test(cls);
      if (!looksLikeChip) continue;
      if (HAS_DISPLAY.test(cls)) continue;

      const line = body.slice(0, m.index).split("\n").length;
      offenders.push(`${file.replace(root, "")}:${line}`);
    }
  }

  it("一个都不许有", () => {
    assert.deepEqual(
      offenders,
      [],
      "这些 <a>/<Link> 有圆角和内边距但没声明 display —— " +
        "里面一旦放进 flex 的子元素，就会被劈成「左半圆 / 文字 / 右半圆」三行，" +
        "而且垂直 padding 不生效：\n" +
        offenders.join("\n"),
    );
  });
});

describe("Pill 这个组件本身", () => {
  const pill = readFileSync(join(root, "src/components/ui/primitives.tsx"), "utf8");
  const body = pill.slice(pill.indexOf("export function Pill"), pill.indexOf("export function PillRow"));

  it("是 inline-flex", () => {
    assert.match(body, /inline-flex/);
  });

  it("自己管好图标和文字的间距 —— 调用方不该再套一层 flex", () => {
    /*
     * 组件自己不排的话，每个调用方都会在里面塞一个
     * `<span className="flex">` —— 而那正是把它劈成三行的东西。
     */
    assert.match(body, /items-center/);
    assert.match(body, /gap-1/);
  });

  it("**注释里写明了为什么** —— 下一个人很容易把它顺手改回 inline", () => {
    assert.match(body, /劈成三段|三行/);
  });
});

describe("调用方不再套多余的 flex", () => {
  for (const file of [
    "src/app/(app)/archive/page.tsx",
    "src/app/(app)/search/page.tsx",
    "src/app/(app)/links/page.tsx",
  ]) {
    it(`${file.split("/").pop()} 里的 Pill 直接放内容`, () => {
      const body = readFileSync(join(root, file), "utf8");
      const bad = [
        ...body.matchAll(/<Pill[^>]*>\s*<span className="flex/g),
      ];
      assert.equal(bad.length, 0, "又套回去了");
    });
  }
});
