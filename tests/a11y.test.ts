import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it } from "node:test";

import { srcRoot, stripComments, walkSource } from "./_source";
import {
  auditSource,
  componentsWithLabelProp,
  findElements,
  hasAttr,
  isNameless,
} from "@/lib/a11y/audit";

/**
 * 无障碍走查。
 *
 * 一次性走查会衰减：这周改干净了，下周新加一个图标按钮又没有 aria-label，
 * 而没有人会再走查第二遍。无障碍问题的特点是**做的人看不见** ——
 * 用鼠标的人永远不会发现某个按钮读屏时念作「按钮」。
 *
 * 所以规则跟着每次 npm test 跑。下面前半部分测的是**扫描器本身**：
 * 一个会误报的检查，第一次挡住正常提交时就会被加豁免注释，
 * 第二次就会被删掉 —— 所以「不误报」比「查得全」更要紧。
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

describe("扫描器：不能误报", () => {
  it("**运行时才确定名字的按钮不报** —— 静态看不出来就别报", () => {
    for (const body of ["{tab.label}", "{count} 条", "{pending ? '保存中' : '保存'}"]) {
      assert.equal(isNameless(body), false, `「${body}」被误报了`);
    }
  });

  it("裸文本按钮不报", () => {
    assert.equal(isNameless("确认关闭"), false);
    assert.equal(isNameless("\n  取消\n"), false);
  });

  it("**只有图标的才报**", () => {
    assert.equal(isNameless('<Bookmark className="h-4 w-4" aria-hidden />'), true);
    assert.equal(isNameless("\n  <X />\n"), true);
    assert.equal(isNameless(""), true);
  });

  it("包在 label 里的输入框不报", () => {
    const source = `<label><input type="checkbox" checked={on} onChange={f} />开启</label>`;
    assert.deepEqual(auditSource(source).filter((f) => f.rule === "input-name"), []);
  });

  it("★ 只包着图标的**空 label** 要报 —— 那比不包更糟", () => {
    /*
     * 名字的算法是：外层 label 一旦存在，名字就由它的文字内容决定，
     * 而 placeholder 的兜底**只在没有 label 时**才轮得到。
     * 所以一个只包着图标的 label 给出的是空名字，
     * 并且把 placeholder 挡在外面 —— 读屏念到那个框只说「编辑框」。
     *
     * 踩过：搜索框外层为了扩大命中区从 <div> 换成 <label>，
     * 视觉上一个像素没动，这条规则也照旧放行（「它在 label 里」），
     * 而运行时的无障碍树上那个框失去了名字。
     * 是 scripts/ax-audit.mjs 把 AX 树拉出来才看见的。
     */
    const source = `<label><Search className="h-4 w-4" aria-hidden /><input type="search" /></label>`;
    const found = auditSource(source).filter((f) => f.rule === "input-name");
    assert.equal(found.length, 1, "空 label 里的输入框应该被报出来");
  });

  it("**包在带 label 属性的组件里的输入框也不报**", () => {
    // BoardEditor 的 <Field label="名称"> 写法 —— 第一版在这里误报了四条
    const source = `<Field label="名称"><input value={name} onChange={f} className={c} /></Field>`;
    assert.ok(componentsWithLabelProp(source).length > 0);
    assert.deepEqual(auditSource(source).filter((f) => f.rule === "input-name"), []);
  });

  it("有 placeholder / aria-label / id 的输入框不报", () => {
    for (const attrs of ['placeholder="搜索"', 'aria-label="搜索"', 'id="q"']) {
      const source = `<input ${attrs} value={v} onChange={f} />`;
      assert.deepEqual(auditSource(source).filter((f) => f.rule === "input-name"), [], attrs);
    }
  });

  it("隐藏域与提交按钮不报", () => {
    const source = `<input type="hidden" name="d" value={d} /><input type="submit" />`;
    assert.deepEqual(auditSource(source).filter((f) => f.rule === "input-name"), []);
  });
});

describe("扫描器：该报的要报", () => {
  it("只有图标的按钮", () => {
    const source = `<button onClick={f}><X className="h-4 w-4" aria-hidden /></button>`;
    assert.equal(auditSource(source).filter((f) => f.rule === "button-name").length, 1);
  });

  it("加了 aria-label 就不报了", () => {
    const source = `<button aria-label="关闭" onClick={f}><X className="h-4 w-4" aria-hidden /></button>`;
    assert.deepEqual(auditSource(source).filter((f) => f.rule === "button-name"), []);
  });

  it("图片没有 alt", () => {
    assert.equal(auditSource(`<img src={u} width={40} />`).length, 1);
    assert.deepEqual(auditSource(`<img src={u} alt="" />`), []);
  });

  it("**role=switch 少了 aria-checked** —— 读屏不知道现在是开还是关", () => {
    const bad = `<button role="switch" onClick={f}><span /></button>`;
    const findings = auditSource(bad).filter((f) => f.rule === "switch-checked");
    assert.equal(findings.length, 1);
    assert.match(findings[0].detail, /是开还是关/);

    const good = `<button role="switch" aria-checked={on} aria-label="开关" onClick={f}><span /></button>`;
    assert.deepEqual(auditSource(good).filter((f) => f.rule === "switch-checked"), []);
  });

  it("target=_blank 少了 noopener", () => {
    assert.equal(auditSource(`<a href={u} target="_blank">去看看</a>`).length, 1);
    assert.deepEqual(
      auditSource(`<a href={u} target="_blank" rel="noopener noreferrer">去看看</a>`),
      [],
    );
  });

  it("装饰性图标没有 aria-hidden", () => {
    const bad = `<Check className="h-3 w-3" strokeWidth={3} />`;
    assert.equal(auditSource(bad).filter((f) => f.rule === "icon-hidden").length, 1);
    assert.deepEqual(
      auditSource(`<Check className="h-3 w-3" strokeWidth={3} aria-hidden />`),
      [],
    );
  });

  it("带 aria-label 的图标不算装饰性，不报", () => {
    const source = `<Lock className="h-3 w-3" strokeWidth={2} aria-label="已锁定" />`;
    assert.deepEqual(auditSource(source).filter((f) => f.rule === "icon-hidden"), []);
  });

  it("报出来的每一条都带行号和可定位的片段", () => {
    const source = `<div>\n<button onClick={f}><X className="h-4 w-4" aria-hidden /></button>\n</div>`;
    const [finding] = auditSource(source);
    assert.equal(finding.line, 2);
    assert.match(finding.snippet, /<button/);
    assert.ok(finding.detail.length > 6);
  });
});

describe("JSX 扫描的正确性", () => {
  it("同名嵌套时配对正确", () => {
    const source = `<div a><div b>内层</div></div>`;
    const [outer] = findElements(source, "div");
    assert.match(outer.body, /内层/);
    assert.match(outer.body, /<div b>/);
  });

  it("属性里的 > 不会被当成开标签结束", () => {
    const source = `<button onClick={() => go()} aria-label="走"><X /></button>`;
    const [element] = findElements(source, "button");
    assert.ok(hasAttr(element.attrs, "aria-label"));
    assert.equal(element.body.trim(), "<X />");
  });

  it("字符串里的花括号不会打乱计数", () => {
    const source = `<input placeholder="{不是表达式}" />`;
    assert.ok(hasAttr(findElements(source, "input")[0].attrs, "placeholder"));
  });

  it("自闭合元素的 body 是空的", () => {
    assert.equal(findElements(`<img src={u} alt="" />`, "img")[0].body, "");
  });

  it("hasAttr 不会把 aria-labelledby 当成 aria-label", () => {
    assert.equal(hasAttr(' aria-labelledby="x"', "aria-label"), false);
    assert.equal(hasAttr(' aria-label="x"', "aria-label"), true);
  });
});

describe("**全站扫描必须是零**", () => {
  it("src/app 与 src/components 下没有任何未修复的问题", () => {
    const files = [...walk(join(ROOT, "src/app")), ...walk(join(ROOT, "src/components"))];
    assert.ok(files.length > 40, "扫描范围不对，文件太少");

    const problems: string[] = [];
    for (const file of files) {
      for (const finding of auditSource(readFileSync(file, "utf8"))) {
        problems.push(`${file.replace(ROOT, "")}:${finding.line} [${finding.rule}] ${finding.detail}`);
      }
    }

    assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
  });
});

describe("样式层的无障碍基础", () => {
  const css = readFileSync(join(ROOT, "src/app/globals.css"), "utf8");

  it("**焦点可见** —— 键盘用户全靠它知道自己在哪", () => {
    assert.match(css, /:focus-visible\s*\{[^}]*outline/);
  });

  it("尊重「减少动效」", () => {
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /animation-duration:\s*0\.01ms\s*!important/);
  });

  it("★ JS 里不许出现裸的 behavior: smooth —— 上面那条 CSS **管不住它**", () => {
    /*
     * ═════════════════════════════════════════
     * 上面那条测试是绿的，而站里照样会把人滚晕
     * ═════════════════════════════════════════
     *
     * CSS 里 `scroll-behavior: auto !important` 写得好好的，
     * 但规范规定：ScrollOptions 里显式给了 `smooth` 就平滑滚，
     * **只有传 auto 时才回去看 CSS**。也就是说 JS 那一句
     * 从旁边绕过了整块无障碍处理。
     *
     * 实测过，不是照规范推的：打开减少动效、确认 CSS 那边已经是 auto，
     * 然后 `scrollTo({ top: 2420, behavior: "smooth" })` ——
     * 80 毫秒后 scrollY 是 80，还在路上。
     *
     * 站里需要平滑滚动的两处（接着读、引用回复）恰好都是**跳很远**的，
     * 正是最会引起眩晕的一类。所以统一走 `lib/ui/motion.ts`，
     * 由它读偏好。
     *
     * 这一条盯的是「有没有人绕过去」——
     * 漏掉的后果对当事人是生理上的，而他多半不会来报。
     */
    const offenders: string[] = [];
    for (const file of walkSource(srcRoot())) {
      if (file.endsWith("/lib/ui/motion.ts")) continue;   // 偏好就是在这里读的
      if (/behavior:\s*["']smooth["']/.test(stripComments(readFileSync(file, "utf8")))) {
        offenders.push(file.slice(file.indexOf("/src/") + 1));
      }
    }
    assert.deepEqual(offenders, [], "这些地方绕过了「减少动效」，改用 lib/ui/motion.ts 的 scrollToElement");
  });

  it("sr-only 用的是裁剪不是 display:none —— 后者读屏也读不到", () => {
    const block = css.slice(css.indexOf(".sr-only"), css.indexOf(".sr-only") + 320);
    assert.match(block, /clip:\s*rect\(0, 0, 0, 0\)/);
    assert.doesNotMatch(block, /display:\s*none/);
  });

  it("有 .focus\\:not-sr-only —— 跳转链接聚焦时要能看见", () => {
    assert.match(css, /\.focus\\:not-sr-only:focus/);
  });
});

describe("页面骨架", () => {
  it("html 上有 lang，读屏才知道用哪种语音", () => {
    const layout = readFileSync(join(ROOT, "src/app/layout.tsx"), "utf8");
    assert.match(layout, /<html\s+lang="zh-CN"/);
  });

  it("**有跳到正文的链接** —— 键盘用户不必每次 Tab 过整个侧边栏", () => {
    const shell = readFileSync(join(ROOT, "src/components/shell/AppShell.tsx"), "utf8");
    assert.match(shell, /sr-only focus:not-sr-only/);
    assert.match(shell, /href="#main"/);
    assert.match(shell, /id="main"/, "跳转链接指向的锚点不存在，点了会没反应");
  });
});

describe("触控区 —— 点不中的人不会来报 bug", () => {
  it("**小内边距的图标按钮要有 tap-target**", () => {
    const bad = `<button aria-label="删除" className="rounded-full p-1.5"><X /></button>`;
    const findings = auditSource(bad).filter((f) => f.rule === "tap-target");
    assert.equal(findings.length, 1);
    assert.match(findings[0].detail, /44px/);
  });

  it("加了 tap-target 就不报", () => {
    const good = `<button aria-label="删除" className="tap-target rounded-full p-1.5"><X /></button>`;
    assert.deepEqual(auditSource(good).filter((f) => f.rule === "tap-target"), []);
  });

  it("显式给了足够高度的也不报", () => {
    const good = `<button aria-label="删除" className="h-11 p-1.5"><X /></button>`;
    assert.deepEqual(auditSource(good).filter((f) => f.rule === "tap-target"), []);
  });

  it("有文字的按钮本来就够大，不报", () => {
    const good = `<button className="p-1.5">删除</button>`;
    assert.deepEqual(auditSource(good).filter((f) => f.rule === "tap-target"), []);
  });

  it("tap-target 只扩可点范围，不改视觉尺寸", () => {
    const css = readFileSync(join(ROOT, "src/app/globals.css"), "utf8");
    const block = css.slice(css.indexOf(".tap-target::after"), css.indexOf(".tap-target::after") + 400);
    assert.match(block, /position:\s*absolute/, "用伪元素撑开，不能改 padding");
    assert.match(block, /max\(100%,\s*44px\)/);
    // 鼠标本来就点得准，扩大反而会挡住旁边的元素
    assert.match(css, /@media \(pointer: fine\)[\s\S]{0,120}tap-target::after \{ display: none/);
  });
});

describe("**扫描器不该把注释当成代码**", () => {
  /*
   * 真撞上的：DayNav 的文件头注释里写了一句
   * 「原生 <input type="date"> + GET 表单」，用来解释为什么不自己搓日历。
   * 扫描器把那行报成了「没有 label 的输入框」—— 而那根本不是代码。
   *
   * 误报比漏报更伤这类检查：一条查出来是假的之后，
   * 下一条真的也会被顺手划掉。
   */
  it("块注释里的 JSX 不报", () => {
    const source = `
      /**
       * 用原生 <input type="date"> 而不是自己搓一个日历。
       */
      export function X() {
        return <input type="date" aria-label="跳到某一天" />;
      }
    `;
    assert.deepEqual(auditSource(source), []);
  });

  it("行注释里的 JSX 也不报", () => {
    const source = `
      export function X() {
        // 这里本来是 <img src="a.png"> ，后来换掉了
        return <img src="a.png" alt="猫" />;
      }
    `;
    assert.deepEqual(auditSource(source), []);
  });

  it("**注释外面真的有问题时照样报** —— 别把扫描器整个挖空了", () => {
    const source = `
      /** 说明里提到 <input> 不算数 */
      export function X() {
        return <input type="text" />;
      }
    `;
    const found = auditSource(source);
    assert.equal(found.length, 1, "把真问题也一起吞了");
  });

  it("**行号不能因为挖空而串位** —— 指错行的报告等于没有行号", () => {
    const source = ["/*", " * 注释", " */", "", '<input type="text" />'].join("\n");
    const found = auditSource(source);
    assert.equal(found.length, 1);
    assert.equal(found[0].line, 5, `报在第 ${found[0].line} 行，实际在第 5 行`);
  });
});
