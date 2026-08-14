import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { stripComments as strip } from "./_source";

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
    assert.match(css, /main#main:has\(\[data-dense\]\)/);

    const shell = src("components/shell/AppShell.tsx");
    assert.doesNotMatch(shell, /pathname|startsWith\("\/admin/, "外壳里写死了路由判断");
  });

  it("后台声明了自己是密集页面", () => {
    assert.match(src("app/(app)/admin/layout.tsx"), /data-dense/);
  });

  it("**不支持 :has() 的浏览器只是窄一点，不会坏** —— 宽度是渐进增强", () => {
    /*
     * 默认值和覆盖**必须写在同一个文件、同一种优先级上**。
     *
     * 原来这条断言分两半：默认值在 AppShell 的内联 style 里匹配一次，
     * 覆盖在 css 里匹配一次 —— 两半各自都在，所以一直是绿的。
     * 而内联样式赢过任何普通样式表规则，那条覆盖**从来没生效过一次**，
     * 三十个后台页面一直被压在 52rem 的正文栏宽里。
     *
     * 两个字符串各自存在，不代表它们之间的关系成立。所以现在改成
     * 断言这段关系本身：默认与覆盖相邻、后者靠多一个 :has() 取胜。
     */
    const css = src("app/globals.css");
    assert.match(css, /main#main \{\s*\n?\s*max-width: var\(--content-max\);/);
    assert.match(css, /main#main:has\(\[data-dense\]\) \{\s*\n?\s*max-width: var\(--content-max-wide\);/);

    /*
     * 剥注释再断言。AppShell 里那段说明**引用了**旧写法的样子，
     * 而这条断言问的是「代码里还有没有」——
     * 不剥的话，一句讲清楚为什么不能这么写的注释会把测试判红。
     */
    const shell = strip(src("components/shell/AppShell.tsx"));
    assert.doesNotMatch(
      shell,
      /style=\{\{[^}]*maxWidth/,
      "栏宽又回到内联 style 上了 —— 内联样式赢过 :has()，覆盖会静默失效",
    );
  });
});

describe("**同一件事只有一套长相**", () => {
  it("两页的「按天翻」都用 DayNav", () => {
    /*
     * 原来 /archive 用吸顶的箭头条、/forum/convert 用两个文字药丸 ——
     * 功能一模一样，外观完全不同。在两页之间来回的人
     * 会觉得自己走进了另一个网站。这是「割裂」最具体的样子。
     */
    for (const p of ["app/(app)/archive/page.tsx", "app/(app)/forum/convert/page.tsx"]) {
      assert.match(src(p), /<DayNav/, `${p} 还在自己拼翻天的控件`);
      assert.doesNotMatch(strip(src(p)), /前一天/, `${p} 里还留着旧写法`);
    }
  });

  it("**能直接跳日期** —— 只能 ±1 天的话，回到上个月要点三十下", () => {
    const nav = src("components/ui/DayNav.tsx");
    assert.match(nav, /type="date"/);
    assert.match(nav, /max=\{today\}/, "能选到未来的日期，而未来一定是空的");
  });

  it("**用原生日期控件，不自己搓日历** —— 时区、键盘、读屏它都已经对了", () => {
    const nav = src("components/ui/DayNav.tsx");
    assert.doesNotMatch(nav, /useState|calendar|Calendar/);
  });

  it("到今天就停住，而且 aria-disabled —— 只调淡颜色的话读屏照样会念", () => {
    const nav = src("components/ui/DayNav.tsx");
    assert.match(nav, /aria-disabled=\{isToday\}/);
    assert.match(nav, /pointer-events-none/);
  });

  it("翻天时带上筛选参数 —— 丢掉的话人会回到「全部群」", () => {
    const nav = src("components/ui/DayNav.tsx");
    assert.match(nav, /hidden\?: Record<string, string \| undefined>/);
    /*
     * 断言的是「群跟着走」，不是某一行的字面写法 ——
     * 回看页后来又多了一个排序筛选，写死整个 hidden 的话，
     * 每加一个筛选这条测试就会假红一次，而它想防的东西根本没变。
     */
    for (const p of ["app/(app)/archive/page.tsx", "app/(app)/forum/convert/page.tsx"]) {
      assert.match(src(p), /hidden=\{\{[^}]*group: convId/, `${p} 翻天会丢掉群`);
    }
    // 回看页的排序同样是筛选：跳一次日期就被打回默认排序的话，和丢掉群一样烦
    assert.match(src("app/(app)/archive/page.tsx"), /hidden=\{\{[^}]*order:/);
  });

  it("「今天/昨天」比一串数字好认", () => {
    assert.match(src("components/ui/DayNav.tsx"), /relativeLabel/);
  });
});
