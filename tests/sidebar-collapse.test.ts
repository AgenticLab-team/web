import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readSidebarState, SIDEBAR_INIT_SCRIPT, SIDEBAR_STORAGE_KEY } from "@/lib/sidebar";

import { readCode } from "./_source";

/**
 * 侧栏收起。
 *
 * ═════════════════════════════════════════
 * 这里守的是「不闪」，不是「能收起」
 * ═════════════════════════════════════════
 *
 * 「能收起」坏了一眼就看得见，没人需要测试提醒。
 * 而「每次加载先闪一下完整侧栏」是那种**开发的人自己看不见**的坏法：
 * 本地一切都是热的，闪那一下只有 30 毫秒；线上冷启动加上慢网，
 * 它是半秒，而且只发生在**收起过侧栏的人**身上 —— 也就是说，
 * 唯一会看见它的是那些最常用这个站的人。
 *
 * 三条防线，缺一条就会闪：
 *   ① 绘制前那段内联脚本真的在 <head> 里
 *   ② 脚本认的值和 `readSidebarState` 认的一致
 *   ③ React 两种状态渲染同一棵树 —— 靠 CSS，不靠条件渲染
 */

const CSS = readCode("app/globals.css");
const SIDEBAR = readCode("components/shell/Sidebar.tsx");
const TOGGLE = readCode("components/shell/SidebarToggle.tsx");

describe("绘制前就定好", () => {
  it("**内联脚本挂在 <head> 里**", () => {
    const layout = readCode("app/layout.tsx");
    assert.match(layout, /SIDEBAR_INIT_SCRIPT/);
    // 和主题那段一样塞进 head，不是塞进 body
    assert.ok(
      layout.indexOf("SIDEBAR_INIT_SCRIPT") < layout.indexOf("</head>"),
      "脚本跑在 </head> 之后就来不及了 —— 那时候第一帧已经画出去了",
    );
  });

  it("脚本用的 key 就是模块导出的那个", () => {
    /*
     * 脚本是个字符串，拼错一个字母不会有任何人报错 ——
     * 它只是永远读不到那个值，于是永远展开。
     */
    assert.ok(SIDEBAR_INIT_SCRIPT.includes(JSON.stringify(SIDEBAR_STORAGE_KEY)));
  });

  it("**脚本和 readSidebarState 对同一批值给同一个结论**", () => {
    /*
     * 两份判定必然分叉，除非有人盯着。这里把脚本当成真的 DOM 跑一遍，
     * 逐个值对照 —— 包括那些奇怪的值：存过旧版本、被别的脚本改过、
     * 手动在控制台里塞过。
     */
    for (const stored of ["rail", "wide", "", "RAIL", "collapsed", "true", "1", null]) {
      const html = new Map<string, string>();
      const fakeDoc = {
        documentElement: {
          setAttribute: (k: string, v: string) => html.set(k, v),
          removeAttribute: (k: string) => html.delete(k),
        },
      };
      const fakeStorage = { getItem: () => stored };
      new Function("document", "localStorage", SIDEBAR_INIT_SCRIPT)(fakeDoc, fakeStorage);

      const scriptSays = html.get("data-sidebar") === "rail" ? "rail" : "wide";
      assert.equal(
        scriptSays,
        readSidebarState(stored),
        `存的是 ${JSON.stringify(stored)} 时两边结论不一致`,
      );
    }
  });

  it("localStorage 抛异常也不能连累后面 —— Safari 隐私模式会抛", () => {
    const fakeDoc = {
      documentElement: { setAttribute: () => {}, removeAttribute: () => {} },
    };
    const throwing = {
      getItem() {
        throw new Error("SecurityError");
      },
    };
    assert.doesNotThrow(() =>
      new Function("document", "localStorage", SIDEBAR_INIT_SCRIPT)(fakeDoc, throwing),
    );
  });
});

describe("**两种状态渲染同一棵树**", () => {
  it("Sidebar 里没有按收起状态挑分支的条件渲染", () => {
    /*
     * 这一条是整套设计的地基。一旦有人写了
     * `collapsed ? <A/> : <B/>`，上面那三条全部白搭：
     * 服务端不知道这个人收没收，只能先渲染展开的那棵。
     */
    assert.equal(
      /collapsed|isRail|data-sidebar/.test(SIDEBAR),
      false,
      "Sidebar 不该知道自己收没收起 —— 那是 CSS 的事",
    );
  });

  it("长相靠 class 挂钩，而这些钩子 CSS 里都接住了", () => {
    /*
     * 组件上写了 class、CSS 里没有对应规则的话，收起来之后
     * 那一块就原样杵在 4rem 宽的栏里撑破布局 —— 而这不会报错。
     */
    for (const hook of [
      "sidebar-label",
      "sidebar-row",
      "sidebar-badge",
      "sidebar-chevron",
      "sidebar-more-panel",
      "sidebar-foot",
      "sidebar-head",
      "sidebar-theme",
      "sidebar-rail-only",
    ]) {
      assert.ok(SIDEBAR.includes(hook) || TOGGLE.includes(hook), `没人用 .${hook}`);
      assert.ok(CSS.includes(`.${hook}`), `CSS 里没有 .${hook} 的规则`);
    }
  });

  it("**文字是抽掉而不是变透明**", () => {
    /*
     * 透明的文字还占宽度、还能被读屏念出来、还能被 Tab 到 ——
     * 于是键盘用户会停在一个屏幕上根本看不见的东西上。
     */
    const rule = CSS.slice(CSS.indexOf('[data-sidebar="rail"] .sidebar-label'));
    assert.match(rule.slice(0, 120), /display:\s*none/);
  });

  it("红点不跟着标题一起消失 —— 它正是让人回站里的那个东西", () => {
    assert.match(CSS, /\[data-sidebar="rail"\][\s\S]{0,40}\.sidebar-badge/);
  });
});

describe("宽度换的是变量本身", () => {
  it("**主内容不需要知道侧栏收没收起**", () => {
    /*
     * 换变量的话，`lg:pl-[var(--sidebar-width)]` 自动跟着走。
     * 在 AppShell 上再判一次收起状态，就等于第二份真源。
     */
    assert.match(CSS, /\[data-sidebar="rail"\]\s*\{\s*--sidebar-width:/);
    assert.equal(
      /data-sidebar/.test(readCode("components/shell/AppShell.tsx")),
      false,
      "AppShell 不该知道这件事",
    );
  });
});

describe("按钮说得出按下去会发生什么", () => {
  it("收起后它没有可见文字，所以 aria-label 是它唯一的名字", () => {
    // 不用 /s：[\s\S] 在任何 target 下都能跨行，而 /s 要 es2018
    assert.match(TOGGLE, /aria-label=\{[\s\S]*展开侧栏[\s\S]*收起侧栏[\s\S]*\}/);
  });

  it("状态从 DOM 读，不在 React 里再存一份", () => {
    // 存两份的话，hydration 那一瞬间必然不一致
    assert.match(TOGGLE, /useSyncExternalStore/);
    assert.equal(/useState/.test(TOGGLE), false);
  });

  it("存不下也要能收起 —— 隐私模式下 setItem 会抛", () => {
    assert.match(TOGGLE, /localStorage\.setItem[\s\S]{0,80}catch/);
  });
});
