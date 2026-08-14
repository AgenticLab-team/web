import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { findElements } from "@/lib/a11y/audit";

/**
 * 布局与视觉一致性。
 *
 * ─────────────────────────────────────────
 * 「割裂感」不是缺构件，是构件被各页重新发明
 * ─────────────────────────────────────────
 *
 * 2026-08 普查的结论：站长说的「体验太割裂」，拆开看全是同一类东西 ——
 * 卡片在页面里手拼了 36 次（内边距分成 p-3.5 / p-4 / px-4 py-3 三派）、
 * Pill 横滚条手拼了 11 次（前台出血到屏幕边、后台不出血）、
 * 返回链接手拼了 12 次（第 12 次漏了 mt-6）、登录空态块手拼了 6 次
 * （py-10 / py-8 / py-7 三种）。每一处都「差不多」，合在一起就是「不对劲」。
 *
 * 所以这组测试不测某个 class 字符串好不好看，测的是**配方不许再散落**：
 * 一种东西只允许有一个出处。规则跟 a11y 走同一条纪律 ——
 * 宁可漏报，不可误报；会误报的规则活不过第二次提交。
 */

const APP_DIR = new URL("../src/app/(app)", import.meta.url).pathname;
const SRC_DIR = new URL("../src", import.meta.url).pathname;

function pageFiles(dir = APP_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pageFiles(full));
    else if (entry === "page.tsx") out.push(full);
  }
  return out;
}

function allSourceFiles(dir = SRC_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allSourceFiles(full));
    else if (/\.(tsx?|css)$/.test(entry)) out.push(full);
  }
  return out;
}

const short = (file: string) => file.slice(APP_DIR.length + 1);
const read = (file: string) => readFileSync(file, "utf8");

/** 去掉块注释、行注释与 JSX 注释 —— 注释里写 ** 强调是文档惯例，不是 bug */
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("**每个页面同一顶部**", () => {
  it("(app) 下的每个页面都用 PageHeader，唯一豁免是帖子详情", () => {
    /*
     * 帖子详情的大标题就是帖子标题本身 —— 再套一层 PageHeader
     * 会出现两个 h1。除它之外，没有 PageHeader 的页面顶部间距
     * 一定和别的页对不上，因为 pt-8 pb-6 只写在 PageHeader 里。
     */
    const exempt = new Set(["forum/p/[id]/page.tsx"]);
    const missing = pageFiles()
      .filter((f) => !exempt.has(short(f)))
      .filter((f) => !read(f).includes("<PageHeader"));
    assert.deepEqual(missing.map(short), [], "这些页面没有用 PageHeader");
  });

  it("**返回链接只有一个出处** —— 手写第 12 遍的时候漏掉了 mt-6", () => {
    /*
     * 漏了 mt-6 的那一页（用户详情），标题比其它子页高 1.5rem。
     * 这种差异没人会来报告，人只会觉得那一页「有点怪」。
     */
    const offenders = pageFiles().filter((f) =>
      read(f).includes("inline-flex items-center gap-0.5"),
    );
    assert.deepEqual(offenders.map(short), [], "这些页面在手写返回链接，用 <BackLink>");
  });
});

describe("**配方不许散落在页面里**", () => {
  it("卡片（surface + 圆角 + 发丝线）不许手拼在 div/article/section 上", () => {
    /*
     * 交互卡（整卡是 <Link>）除外 —— Card 构件不做链接，
     * 包一层反而多一个不点不响的壳。静态卡一律走 <Card>。
     */
    const bad: string[] = [];
    for (const file of pageFiles()) {
      const code = read(file);
      for (const tag of ["div", "article", "section"]) {
        for (const el of findElements(code, tag)) {
          if (
            el.attrs.includes("rounded-[var(--radius-card)]") &&
            el.attrs.includes("bg-[var(--surface)]")
          ) {
            bad.push(`${short(file)}:${el.line}`);
          }
        }
      }
    }
    assert.deepEqual(bad, [], "这些地方在手拼卡片，用 <Card>");
  });

  it("Pill 横滚条不许手拼 —— 出血宽度前后台曾各是一套", () => {
    const offenders = pageFiles().filter((f) => read(f).includes("overflow-x-auto px-4 pb-1"));
    assert.deepEqual(offenders.map(short), [], "这些页面在手拼 Pill 横滚条，用 <PillRow>");
  });

  it("提示横幅的染色只发生在 Callout 里", () => {
    /*
     * 之前每页自己 color-mix，混合比例 7%~10% 随手挑 ——
     * 同是警告，这页的黄比那页深一点，正是「割裂感」的来源。
     */
    const recipe = /color-mix\(in srgb, var\(--(warning|danger|success|accent)\) \d+%, var\(--surface\)\)/;
    const offenders = pageFiles().filter((f) => recipe.test(read(f)));
    assert.deepEqual(offenders.map(short), [], "这些页面在手拼提示横幅，用 <Callout>");
  });

  it("空态不许手拼，也不许用一行假 Row 冒充", () => {
    /*
     * 手拼的空态出现过 py-10 / py-8 / py-7 三种；
     * 「还没有记录」写成 Group 里的一行 Row 的那几处，
     * 和别处的 Empty 摆在一起就是两种空态。
     */
    const offenders = pageFiles().filter((f) =>
      /inset-group px-6 py-\d+ text-center/.test(read(f)),
    );
    assert.deepEqual(offenders.map(short), [], "这些页面在手拼空态块，用 <Empty>");
  });

  it("Empty 有 action 槽 —— 没有它，带按钮的空态就会回到手拼", () => {
    const primitives = read(
      new URL("../src/components/ui/primitives.tsx", import.meta.url).pathname,
    );
    assert.match(primitives, /action\?: React\.ReactNode/);
    assert.match(primitives, /export function EmptyAction/);
  });
});

describe("**UI 文本是给人看的，不是 markdown 源码**", () => {
  it("**所有 .tsx 里都不许有字面 ** 星号，不只是页面**", () => {
    /*
     * 注释里的 **强调** 被人顺手带进 JSX 文本，用户真的会看到
     * 「且**每一条都会独立留处罚记录**」这样的星号 —— 出现过 8 处。
     * 强调要用 <strong>。
     *
     * 这条检查原来只扫 `page.tsx`，而**大量 UI 文案在 components 里** ——
     * 扩大范围之后当场又抓出两处（敏感词预览、GitHub 解绑那两句话），
     * 它们已经在线上给人看了不知道多久。
     *
     * 这个错我自己在这一轮里也犯了第三次。写在注释里的强调
     * 和写在 JSX 里的强调长得一模一样，靠记性是防不住的。
     */
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      if (!file.endsWith(".tsx")) continue;
      const code = stripComments(read(file));
      const match = code.match(/\*\*[^*\n]{1,80}\*\*/);
      if (match) offenders.push(`${file.slice(SRC_DIR.length + 1)}: ${match[0].slice(0, 40)}`);
    }
    assert.deepEqual(offenders, [], "这些地方把 markdown 星号渲染给了用户");
  });

  it("**注释里那个 ★ 也不许进 UI 文案** —— 同一种病、同一个来源", () => {
    /*
     * 这个仓库的注释里用 `★` 标「这一条最要紧」。它和 `**` 一样，
     * 是**写给读代码的人**的记号 —— 而用户看到的是一个来路不明的星星。
     *
     * 抓到过一处：域名编辑器里「收所有前缀」那行提示写着
     * 「★ 开了之后发给任何前缀的信都收」。它已经在后台上显示了。
     *
     * 全站就那一处，也就是说这条规矩本来是守着的 ——
     * 而「本来守着」的东西不写下来，下一次就会被抄进去。
     * 抄的人不会觉得自己在破坏什么：那一行看起来和周围一模一样。
     */
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      if (!file.endsWith(".tsx")) continue;
      const code = stripComments(read(file));
      // 只看字符串字面量里的 —— JSX 文本和 props 都在引号里
      for (const m of code.matchAll(/["'`][^"'`\n]{0,120}★[^"'`\n]{0,120}["'`]/g)) {
        offenders.push(`${file.slice(SRC_DIR.length + 1)}: ${m[0].slice(0, 40)}`);
      }
    }
    assert.deepEqual(offenders, [], "这些 UI 文案里带着注释用的 ★");
  });
});

describe("**引用的设计变量必须真的存在**", () => {
  it("src 里每个 var(--x) 都在 globals.css 里定义过", () => {
    /*
     * var(--hairline) 这个不存在的变量曾散布在 7 个文件里：
     * border-color 拿到非法值会退回 currentColor，于是那些边框
     * 以正文的全浓度渲染 —— 在一片 0.5px 发丝线里又粗又黑。
     * 没有报错、没有告警，唯一的表现是「看起来不太对」。
     */
    const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
    const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

    const files = allSourceFiles().filter((f) => !f.endsWith("globals.css"));

    // 先收齐所有就地定义（style={{ "--x": … }}，如 PreviewBanner 的高度），再查引用 ——
    // 边扫边加的话，定义在后一个文件里的变量会被误报
    for (const file of files) {
      for (const m of read(file).matchAll(/"(--[a-z0-9-]+)"(?: as string)?\s*\]?\s*:/g)) {
        defined.add(m[1]);
      }
    }

    const missing = new Set<string>();
    for (const file of files) {
      for (const m of read(file).matchAll(/var\((--[a-z0-9-]+)[),]/g)) {
        if (!defined.has(m[1])) missing.add(m[1]);
      }
    }
    assert.deepEqual([...missing], [], "这些 CSS 变量没有定义，浏览器会静默退回初始值");
  });

  it("危险色不许写死十六进制 —— 写死的红在暗色下刺眼", () => {
    /*
     * #b91c1c 曾出现在角色页和设置页：暗色主题的 danger 是
     * 柔化过的 #ff7a6b，写死的深红在黑底上几乎读不清。
     * PreviewBanner 是刻意的全幅红色横幅，留作唯一豁免。
     */
    const offenders = pageFiles().filter((f) => /#b91c1c/i.test(read(f)));
    assert.deepEqual(offenders.map(short), [], "页面里写死了危险色，用 var(--danger)");
  });
});

describe("**窄屏行为收在构件里**", () => {
  const primitives = read(
    new URL("../src/components/ui/primitives.tsx", import.meta.url).pathname,
  );

  it("PillRow：窄屏出血滚动、sm 起复位、每个孩子 shrink-0", () => {
    /*
     * shrink-0 不是装饰：不包的话 flex 会把 Pill 压扁而不是让容器滚。
     * 之前 11 处手写里有一半靠每页自己记得写 <span className="shrink-0">。
     */
    assert.match(primitives, /-mx-4 mb-3 flex gap-1\.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0/);
    assert.match(primitives, /className="shrink-0"/);
  });

  it("EmptyAction 的可点高度至少 44px —— 它几乎只在微信内置浏览器里被点", () => {
    assert.match(primitives, /min-h-11/);
  });
});

describe("**同一个称号在每一页长一个样**", () => {
  it("「我的」页也走 TitleIcon，不再直接渲染 emoji", () => {
    // 成员目录已经换成 SVG（见 tests/ui-chrome.test.ts），
    // 「我的」页直接渲染 emoji 的话，同一个称号在两页字形都不一样
    const code = read(new URL("../src/app/(app)/me/page.tsx", import.meta.url).pathname);
    assert.match(code, /<TitleIcon/);
    assert.doesNotMatch(code, /\{equipped\.icon\} \{equipped\.name\}/);
  });
});
