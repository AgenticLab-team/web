import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 动效系统。
 *
 * ─────────────────────────────────────────
 * 三档时长 + 两条铁律
 * ─────────────────────────────────────────
 *
 * 站长的原话是「体验太割裂了」——根源是每处动画的时长和缓动
 * 都是随手写的（0.55s / 0.35s / 0.32s / 0.2s…）。收敛成三档：
 *
 *   反馈 150ms · 转场 320ms · 入场 500ms
 *
 * 铁律一：入场动画只许 fill-mode: backwards。
 *   `both` 的 forwards 半边会让带 transform 的动画**永远**把元素
 *   钉成层叠上下文 —— 帖子页「菜单被回复挡住」那个 bug 的根因。
 *
 * 铁律二：动画只碰合成器属性（transform / opacity / 颜色）。
 *   大量用户在微信 webview 里访问，width / left 这类触发布局的
 *   属性在低端安卓上每一帧都卡。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const stripCss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

const css = src("app/globals.css");
const cssCode = stripCss(css);

/** 取 marker 之后第一个 { … } 块（按花括号配对），拿来检查具体规则的内容 */
function blockAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `globals.css 里找不到 ${marker}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  assert.fail(`${marker} 的花括号没配对`);
}

describe("三档时长是唯一的真相来源", () => {
  it("三档 token 都在，且值就是设计定的那三个数", () => {
    /*
     * 值本身也锁住 —— 这三个数不是随手写的：
     * 150ms 跟手（且等于 Tailwind 默认，裸写 transition-* 自动合规）、
     * 320ms 配 spring 的快起步、500ms 给眼睛解析新内容的时间。
     * 想改档位应该改这条测试和 @theme 里的论证，而不是绕过它。
     */
    assert.match(cssCode, /--motion-feedback:\s*150ms/);
    assert.match(cssCode, /--motion-shift:\s*320ms/);
    assert.match(cssCode, /--motion-entrance:\s*500ms/);
    assert.match(cssCode, /--motion-stagger-step:\s*28ms/);
  });

  it("Tailwind 的默认过渡时长挂在反馈档上 —— 裸写 transition-* 不用记数字", () => {
    assert.match(cssCode, /--default-transition-duration:\s*var\(--motion-feedback\)/);
  });

  it("入场/转场类都引用 token，没有裸写的秒数", () => {
    assert.match(cssCode, /\.animate-rise\s*\{\s*animation:\s*rise var\(--motion-entrance\)/);
    assert.match(cssCode, /\.animate-fade\s*\{\s*animation:\s*fade var\(--motion-shift\)/);
    assert.match(blockAfter(cssCode, ".stagger > *"), /var\(--motion-entrance\)/);
    assert.match(blockAfter(cssCode, ".stagger > *"), /var\(--motion-stagger-step\)/);

    // 兜底：整个动效层不许再出现 0.55s 这类魔法数字的 animation 简写
    for (const decl of cssCode.match(/animation:[^;]+;/g) ?? []) {
      assert.doesNotMatch(decl, /\b0?\.\d+s\b/, `又出现了裸写的时长：${decl.trim()}`);
    }
  });

  it("组件里不再散落 duration-150/200/500/700 —— 时长只从档位来", () => {
    /*
     * PageHeader 归布局 agent 管，先豁免；它对齐三档之后把豁免删掉。
     */
    const offenders: string[] = [];
    const files = [
      "components/shell/Sidebar.tsx",
      "components/shell/TabBar.tsx",
      "components/ThemeToggle.tsx",
      "components/forum/PostActions.tsx",
      "components/forum/PostManageMenu.tsx",
      "components/forum/ReactionBar.tsx",
      "components/forum/PollWidget.tsx",
      "components/points/CheckinCard.tsx",
      "app/(app)/me/points/page.tsx",
      "app/(app)/admin/escalation/page.tsx",
    ];
    for (const f of files) {
      if (/duration-\d/.test(src(f))) offenders.push(f);
    }
    assert.deepEqual(offenders, [], "这些文件里还有随手写的 duration-*");
  });
});

describe("铁律一：入场动画不许在结束后继续钉住层叠上下文", () => {
  /*
   * 真实 bug：`.animate-rise` 曾写 fill-mode `both`，rise 里有 transform，
   * 于是帖子页的 <article> 永远是一个层叠上下文，里面 z-40 的菜单
   * 被 DOM 顺序更靠后的回复列表盖住 —— z-index 调到 9999 也没用。
   *
   * backwards 只在延迟期生效（stagger 后排等 delay 时保持透明，
   * 这是需要 fill 的唯一原因）；动画一结束就彻底不再「应用」，
   * 元素的层叠行为回到正常。
   */
  it("animate-rise / animate-fade / stagger 全部是 backwards", () => {
    assert.match(cssCode, /\.animate-rise\s*\{[^}]*backwards/);
    assert.match(cssCode, /\.animate-fade\s*\{[^}]*backwards/);
    assert.match(blockAfter(cssCode, ".stagger > *"), /backwards/);
  });

  it("除 toast 进度条外，任何 animation 简写不许出现 both / forwards", () => {
    /*
     * toast-progress 是唯一例外：JS 定时器晚到一帧时进度条不该跳回
     * 满格，而它是个 aria-hidden 的叶子节点，没有需要逃逸层叠上下文
     * 的后代。新的例外必须同样论证「这个元素没有会被困住的后代」，
     * 然后加进这里的豁免 —— 而不是悄悄写个 both。
     */
    for (const decl of cssCode.match(/animation:[^;]+;/g) ?? []) {
      if (decl.includes("toast-progress")) continue;
      assert.doesNotMatch(decl, /\b(both|forwards)\b/, `入场动画又用了持久 fill：${decl.trim()}`);
    }
  });

  it("组件里没有内联 animation 样式绕过这条规则", () => {
    // Toast 以前就是这么绕的（style={{ animation: `...` }}）
    for (const f of ["components/ui/Toast.tsx"]) {
      assert.doesNotMatch(src(f), /style=\{\{\s*animation:/, `${f} 里有内联 animation`);
    }
  });
});

describe("铁律二：只动合成器属性（微信 webview 里的低端机才跑得满帧）", () => {
  it("所有 @keyframes 只碰 transform / opacity / 颜色", () => {
    const LAYOUT_PROPS = /^(width|height|left|right|top|bottom|margin|padding|font-size|flex|inset)\b/;
    const frames = cssCode.match(/@keyframes[^{]+\{[\s\S]*?\n\}/g) ?? [];
    assert.ok(frames.length >= 3, "keyframes 数量对不上，检查提取逻辑");
    for (const frame of frames) {
      for (const decl of frame.match(/[a-z-]+\s*:/g) ?? []) {
        const prop = decl.replace(/\s*:\s*$/, "");
        assert.doesNotMatch(prop, LAYOUT_PROPS, `keyframes 里在动触发布局的属性：${frame.split("{")[0].trim()} → ${prop}`);
      }
    }
  });

  it("toast 进度条动 scaleX，不再动 width", () => {
    const frame = blockAfter(cssCode, "@keyframes toast-progress");
    assert.match(frame, /scaleX/);
    assert.doesNotMatch(frame, /width/);
  });

  it("开关滑块走 .switch-knob（translateX），不再 transition-all + 动 left", () => {
    /*
     * 之前五处开关都在动 left —— 每拨一次开关就触发一次逐帧布局。
     * left 固定为 2px，位移交给 transform。
     */
    assert.match(cssCode, /\.switch-knob\s*\{\s*transition:\s*transform var\(--motion-shift\)/);
    const knobs = [
      "components/admin/ModuleToggle.tsx",
      "components/notifications/PrefsPanel.tsx",
      "components/titles/TitleShelf.tsx",
      // 隐私开关那三个走的是同一个组件 —— 隐身也并进去了
      "components/me/PrivacyToggle.tsx",
    ];
    for (const f of knobs) {
      const code = src(f);
      assert.match(code, /switch-knob/, `${f} 的滑块没用 .switch-knob`);
      assert.doesNotMatch(code, /style=\{\{\s*left:/, `${f} 又在用 left 做动画`);
    }
  });

  it("进度条走 .progress-fill（translateX），不再 transition-[width]", () => {
    assert.match(cssCode, /\.progress-fill\s*\{[^}]*transition:\s*transform/);
    const bars = [
      "components/forum/PollWidget.tsx",
      "components/points/CheckinCard.tsx",
      "app/(app)/me/points/page.tsx",
      "app/(app)/admin/escalation/page.tsx",
    ];
    for (const f of bars) {
      const code = src(f);
      assert.match(code, /progress-fill/, `${f} 的进度条没用 .progress-fill`);
      assert.doesNotMatch(code, /transition-\[width\]/, `${f} 还在动 width`);
    }
  });

  it("progress-fill 不用 spring —— 冲过头等于对用户虚报进度", () => {
    assert.match(blockAfter(cssCode, ".progress-fill"), /var\(--ease-out-quart\)/);
  });
});

describe("减少动效（prefers-reduced-motion）", () => {
  const media = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  const mediaCode = stripCss(media);

  it("全局把动画和过渡压到 0.01ms，平滑滚动关掉", () => {
    /*
     * 0.01ms 而不是 animation: none：动画仍然「完成」，
     * animationend 照常触发、fill 照常结算 —— 等动画结束的逻辑
     * 不会挂，用户看到的是内容直接就位。
     */
    assert.match(mediaCode, /animation-duration:\s*0\.01ms !important/);
    assert.match(mediaCode, /transition-duration:\s*0\.01ms !important/);
    assert.match(mediaCode, /scroll-behavior:\s*auto !important/);
  });

  it("toast 进度条在减少动效下保持原时长 —— 它是信息不是装饰", () => {
    /*
     * 被压成 0.01ms 的话，条会瞬间清空，用户以为撤销窗口已经关了。
     * 6s 的线性缩放没有大幅位移，不是前庭问题的触发源。
     */
    assert.match(mediaCode, /\.animate-toast-progress\s*\{\s*animation-duration:\s*var\(--toast-duration[^)]*\) !important/);
  });
});

describe("不引入动画库", () => {
  it("动效全靠 CSS —— 首屏 JS 预算 160KB，动画库一个就能吃掉一半", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const banned = deps.filter((d) => /framer-motion|^motion$|gsap|animejs|@react-spring|lottie/.test(d));
    assert.deepEqual(banned, []);
  });
});
