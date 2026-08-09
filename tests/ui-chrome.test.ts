import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * 界面上的图标与栏宽。
 *
 * ─────────────────────────────────────────
 * 「不要用 emoji，用 SVG」
 * ─────────────────────────────────────────
 *
 * 站长的原话是「太突兀了这几个表情包」。要分清三种东西：
 *
 *   · **内容里的 emoji** —— 论坛的表情反应、版块自定义图标，
 *     那是用户和运营填的内容，不该动
 *   · **排版符号** —— 正文里的 `→`、`—`，那是标点不是图标
 *   · **当图标用的 emoji** —— 混在中文里、跟别处的 lucide 线条对不上，
 *     各平台字形还完全不同。这一类要换成 SVG
 *
 * 权限矩阵那三个格子原本就是 lucide 的 Check/X/Minus，
 * 是我改成编辑器时换成 ✓✗− 的 —— 那是一次实打实的退化。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

/** 图形类 emoji（表情、物件），不含箭头和数学符号 */
const PICTOGRAPH = /[\u{1F300}-\u{1FAFF}\u{1F900}-\u{1F9FF}\u{2700}-\u{27BF}]/u;

describe("**当图标用的地方要用 SVG**", () => {
  it("权限矩阵的三态是 lucide 图标，不是 ✓✗− 字符", () => {
    /*
     * 那三个格子是这张表**唯一的信息载体**。
     * 它们和旁边正文一样粗的时候，整张矩阵会糊成一片。
     */
    const code = strip(src("components/admin/MatrixEditor.tsx"));
    assert.match(code, /GLYPH: Record<MatrixState, LucideIcon>/);
    assert.doesNotMatch(code, /granted: "✓"/);
  });

  it("榜单的升降箭头是 SVG —— ↑↓ 在不同字体里粗细差很多，一列排下来会歪", () => {
    const code = strip(src("components/LeaderboardList.tsx"));
    assert.match(code, /ChevronUp/);
    assert.doesNotMatch(code, /\{up \? "↑" : "↓"\}/);
  });

  it("**称号图标不再直接渲染 emoji**", () => {
    /*
     * 称号跟在人名后面显示，也就是混在中文正文里。
     * emoji 在那个位置各平台字形完全不同、基线不受控、还上不了色。
     */
    for (const f of ["components/titles/TitleShelf.tsx", "app/(app)/members/page.tsx"]) {
      const code = strip(src(f));
      assert.match(code, /<TitleIcon/, `${f} 还在直接渲染 title.icon`);
      // 作为**子节点**渲染才是问题；`icon={title.icon}` 是传参，没问题
      assert.doesNotMatch(code, />\s*\{title\.icon\}|\{member\.title\.icon\} \{/, `${f} 还在直接渲染`);
    }
  });

  it("**认得出库里已有的 emoji** —— 不用为一个显示问题写数据迁移", () => {
    /*
     * 生产上已经有 10 个称号、30 条授予记录，icon 存的是 emoji。
     * 映射表两种都认，老数据直接就是 SVG。
     */
    const code = src("components/titles/TitleIcon.tsx");
    for (const emoji of ["🌱", "🥇", "🔥", "💎", "🎯", "💬"]) {
      assert.ok(code.includes(`"${emoji}"`), `映射表里没有 ${emoji}，库里那条会掉到兜底`);
    }
  });

  it("**认不出的图标回退到奖章，不是什么都不显示**", () => {
    // 回退到空的话，一个配错图标的称号会看起来像没有称号
    const code = strip(src("components/titles/TitleIcon.tsx"));
    assert.match(code, /\?\? Medal/);
  });

  it("版块图标是运营填的内容，保留 emoji；只有兜底换成 SVG", () => {
    const code = strip(src("app/(app)/admin/boards/page.tsx"));
    assert.match(code, /board\.icon \?/, "把运营填的图标也换掉了");
    assert.match(code, /<Folder/);
  });
});

describe("内容里的 emoji 不动", () => {
  it("论坛的表情反应保留 —— 那是内容，不是图标", () => {
    const code = src("components/forum/ReactionBar.tsx");
    assert.match(code, /emoji: "👍"/);
  });

  it("正文里的 → — 是标点，不是图标", () => {
    // 这条只是把判断标准写下来，免得以后有人一刀切全换掉
    assert.doesNotMatch("填一下你自己的 →", PICTOGRAPH);
  });
});

describe("**新写的界面不许再混 emoji 当图标**", () => {
  const roots = ["components/admin", "components/shell", "components/links", "components/search"];

  function files(dir: string): string[] {
    const full = new URL(`../src/${dir}`, import.meta.url).pathname;
    try {
      return readdirSync(full).flatMap((e) => {
        const p = path.join(full, e);
        if (statSync(p).isDirectory()) return files(`${dir}/${e}`);
        return e.endsWith(".tsx") ? [`${dir}/${e}`] : [];
      });
    } catch {
      return [];
    }
  }

  it("这几个目录里的组件，渲染代码里没有图形 emoji", () => {
    const bad: string[] = [];
    for (const f of roots.flatMap(files)) {
      const code = strip(src(f));
      // 反应条是内容，豁免
      if (f.includes("ReactionBar")) continue;
      if (PICTOGRAPH.test(code)) bad.push(f);
    }
    assert.deepEqual(bad, [], "这些组件里混了 emoji 当图标");
  });
});

describe("**栏宽按内容类型走**", () => {
  it("正文栏和密集栏是两个变量", () => {
    /*
     * 52rem 是给「读的东西」定的 —— 一行 60~75 个字最好读。
     * 而后台没有需要读的长句，全是要对照着看的行和列。
     */
    const css = src("app/globals.css");
    assert.match(css, /--content-max:\s*52rem/);
    assert.match(css, /--content-max-wide:/);
  });

  it("**页面自己声明要宽的，不是外壳去认路由**", () => {
    /*
     * 外壳认路由的话，每加一个后台页面都要回来改一次正则，
     * 而忘了改的表现是那一页莫名其妙比别的窄。
     */
    const css = src("app/globals.css");
    assert.match(css, /main:has\(\[data-dense\]\)/);

    const shell = src("components/shell/AppShell.tsx");
    assert.match(shell, /var\(--content-max\)/);
    assert.doesNotMatch(shell, /pathname|startsWith\("\/admin/, "外壳里写死了路由判断");
  });

  it("后台声明了自己是密集页面", () => {
    assert.match(src("app/(app)/admin/layout.tsx"), /data-dense/);
  });

  it("**不支持 :has() 的浏览器只是窄一点，不会坏** —— 宽度是渐进增强", () => {
    const css = src("app/globals.css");
    // 默认值写在 main 上（通过变量），:has() 只是覆盖
    const shell = src("components/shell/AppShell.tsx");
    assert.match(shell, /maxWidth: "var\(--content-max\)"/);
    assert.match(css, /main:has\(\[data-dense\]\) \{\s*\n?\s*max-width/);
  });
});
