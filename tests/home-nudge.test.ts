import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pickNudge, QUIET_AFTER_ACTION_MS, type NudgeInputs } from "@/lib/nudges/rules";
import { readCode, readSource } from "./_source";

/**
 * 首页提示位：挑哪一个，以及**一次只出一个**。
 *
 * ═════════════════════════════════════════
 * 三张卡片摞在首页上，首页就不是首页了
 * ═════════════════════════════════════════
 *
 * 有三件事想提醒：加 Passkey、装到桌面/主屏、开设备推送。
 * 三张一起摆出来，头一屏就全是「你还没做这个」——
 * 而人打开首页是来看社区发生了什么的。
 *
 * 而且它们会互相稀释：三条同时在，每一条都变成背景噪音，
 * 结果是三件事一件都不会做。
 *
 * ═════════════════════════════════════════
 * 顺序按依赖排，不是按重要性
 * ═════════════════════════════════════════
 *
 * iOS 上只有加到主屏的网站才收得到推送。所以那种设备上
 * 「装到主屏」必须排在「开推送」前面 —— 反过来的话，
 * 人点了「开启推送」会撞上一个在这台设备上做不到的按钮，
 * 而那一次失败会让他再也不试第二回。
 */

const base: NudgeInputs = {
  passkeyEligible: false,
  githubEligible: false,
  canInstall: false,
  installed: false,
  canPush: false,
  pushSubscribed: false,
  iosNeedsInstall: false,
  dismissed: [],
  lastActionAt: null,
  now: 1_000_000_000_000,
};

const pick = (over: Partial<NudgeInputs> = {}) => pickNudge({ ...base, ...over });

describe("挑哪一个", () => {
  it("什么都不需要时，一个都不出", () => {
    assert.equal(pick(), null);
  });

  it("**Passkey 排第一** —— 它是唯一关系到「还进不进得来」的一件", () => {
    assert.equal(
      pick({ passkeyEligible: true, canInstall: true, canPush: true }),
      "passkey",
    );
  });

  it("**iOS 上安装排在推送前面** —— 不装到主屏根本收不到", () => {
    /*
     * 反过来的话，人点了「开启推送」会撞上一个在这台设备上
     * 做不到的按钮，而那一次失败会让他再也不试第二回。
     */
    assert.equal(
      pick({ iosNeedsInstall: true, canInstall: true, canPush: true }),
      "install",
    );
  });

  it("**别的平台上推送排在安装前面** —— 安装在那儿不解锁任何东西", () => {
    assert.equal(pick({ canInstall: true, canPush: true }), "push");
  });

  it("已经订阅了就不再提推送", () => {
    assert.equal(pick({ canPush: true, pushSubscribed: true }), null);
  });

  it("已经装过了就不再提安装", () => {
    assert.equal(pick({ canInstall: true, installed: true }), null);
  });

  /*
   * ↓ 下面两条盯的是 **iOS 那条单独的分支**。
   *
   * 它是提前 return 的，所以后面那条通用安装规则的两道闸
   * （装过了 / 说过不用了）**管不到它** —— 得在它自己身上各测一次。
   * 漏掉的话，一个 iPhone 用户说了「不用了」还会天天看见同一张卡。
   */
  it("**iOS 上说过「不用了」就真的不再提** —— 那条分支有自己的闸", () => {
    assert.equal(
      pick({ iosNeedsInstall: true, canInstall: true, dismissed: ["install"] }),
      null,
    );
  });

  it("**iOS 上已经加到主屏了就不再提**", () => {
    assert.equal(
      pick({ iosNeedsInstall: true, canInstall: true, installed: true }),
      null,
    );
  });

  it("**这台设备装不了就不提** —— 提一件做不到的事只是打扰", () => {
    assert.equal(pick({ canInstall: false }), null);
  });

  it("**站点没配推送 / 浏览器不支持 / 权限被拒 → 不提**", () => {
    // 这三种情况调用方都会把 canPush 传 false
    assert.equal(pick({ canPush: false, pushSubscribed: false }), null);
  });
});

describe("**一次只出一个**", () => {
  it("三件事全都符合条件时，也只返回一个", () => {
    const got = pick({
      passkeyEligible: true,
      canInstall: true,
      canPush: true,
      iosNeedsInstall: true,
    });
    assert.equal(typeof got, "string");
    // 返回的是单个值，不是数组 —— 调用方没有「多显示一个」的余地
    assert.equal(Array.isArray(got), false);
  });

  it("**关掉最靠前的那个，下一个才顶上**", () => {
    const all = { passkeyEligible: true, canInstall: true, canPush: true };
    assert.equal(pick(all), "passkey");
    assert.equal(pick({ ...all, dismissed: ["passkey"] }), "push");
    assert.equal(pick({ ...all, dismissed: ["passkey", "push"] }), "install");
    assert.equal(pick({ ...all, dismissed: ["passkey", "push", "install"] }), null);
  });
});

describe("**表过态之后安静几天**", () => {
  it("刚点过，整块不出", () => {
    /*
     * 刚点掉一张，下一张立刻顶上来 —— 那是打地鼠，
     * 是让人学会一见到这块区域就划过去最快的办法。
     */
    assert.equal(
      pick({ passkeyEligible: true, lastActionAt: base.now - 1000 }),
      null,
    );
  });

  it("过了安静期又会出", () => {
    assert.equal(
      pick({ passkeyEligible: true, lastActionAt: base.now - QUIET_AFTER_ACTION_MS - 1 }),
      "passkey",
    );
  });

  it("**安静期覆盖全部三种**，不只是刚点掉的那一种", () => {
    // 否则关掉 Passkey 的下一秒就冒出推送那张 —— 一样是打地鼠
    assert.equal(
      pick({ canPush: true, canInstall: true, lastActionAt: base.now - 1000 }),
      null,
    );
  });

  it("从来没表过态的人正常看到", () => {
    assert.equal(pick({ passkeyEligible: true, lastActionAt: null }), "passkey");
  });
});

describe("接线", () => {
  const card = readSource("components/home/NudgeCard.tsx");
  const nudge = readCode("components/home/HomeNudge.tsx");
  const page = readCode("app/(app)/page.tsx");

  it("**首页渲染的是统一的提示位**", () => {
    assert.match(page, /<HomeNudge/);
  });

  it("**按钮等高等大** —— 一大一小是在用尺寸替人做决定", () => {
    /*
     * 原来推送那张卡是「一个实心大按钮 + 一个 32px 的 ×」。
     * 32px 低于 44px 触摸下限，拇指按下去有一半概率落空 ——
     * 而落空的那一半会点到旁边那个实心按钮上：
     * 想关掉它的人反而被推着往前走了一步。
     */
    /*
     * 只看那一份**共用的 class 串** —— 卡片左上角那个图标底托
     * 也是 h-8 w-8，但它不接受点击，不在这条规矩管的范围里。
     *
     * 以前是从 `<button` 切到 `</button>` 读的。后来「去连接 GitHub」
     * 那一项要渲染成 `<a>`（它会跳去 github.com，用 router 走不通、
     * 用 window.location 会被 lint 拦），于是 class 抽成了两个元素
     * 共用的一个常量 —— 从 `<button` 开始切就再也读不到它了。
     *
     * 改读那个常量之后这条其实**更严**：`<a>` 和 `<button>` 现在
     * 不可能长得不一样，而原来那种写法只管得住其中一个。
     */
    const buttons = card.slice(card.indexOf("const cls ="), card.indexOf("const style ="));
    assert.match(buttons, /min-h-11/);
    // min- 是下限，不是写死；写死的是 `h-8` / `w-8` 那种
    assert.equal(/(?<!min-)\bh-\d/.test(buttons), false, "按钮上又出现了写死的高度");
    assert.equal(/(?<!min-)\bw-\d/.test(buttons), false, "按钮上又出现了写死的宽度");
  });

  it("**主次靠颜色区分，不靠尺寸**", () => {
    assert.match(card, /action\.primary/);
    assert.match(card, /color-mix\(in srgb, var\(--accent\) 12%, transparent\)/);
  });

  it("**每张卡都给得出「不用了」** —— 只能拖延不能拒绝的提示最烦人", () => {
    const count = (nudge.match(/label: "不用了"/g) ?? []).length;
    assert.ok(count >= 3, `只有 ${count} 处「不用了」`);
  });

  it("**能力探测在 effect 里** —— 渲染期读 navigator 会 hydration 报错", () => {
    assert.match(nudge, /useEffect\(/);
    assert.equal(nudge.includes("if (typeof window"), false);
  });

  it("**站内跳转用 router，不用 window.location**", () => {
    assert.match(nudge, /router\.push\(/);
    assert.equal(nudge.includes("window.location.href"), false);
  });

  it("**装没装、能不能推送由客户端判** —— 那是这台设备的事", () => {
    /*
     * 服务端只传「这个账号该不该提 Passkey」。
     * 把设备状态也放服务端算的话，一个人在电脑上装过，
     * 手机上就再也不提示了。
     */
    assert.match(page, /passkeyEligible=\{nudge !== null\}/);
    assert.equal(page.includes("canInstall"), false);
  });
});
