import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readCode, readSource } from "./_source";

/**
 * 「点开启推送，同意之后一直显示设置中」—— 站长报的，电脑和手机都是。
 *
 * ═════════════════════════════════════════
 * 病根不是某一个 API，是这条路上没有一处会喊
 * ═════════════════════════════════════════
 *
 * 订阅要走四步：要权限 → 等 SW 就绪 → 向推送服务申请 → 存到服务器。
 * 改之前，后三步**每一步都可能永远不返回，而且一个超时都没有**：
 *
 *   · `navigator.serviceWorker.ready` 只在有**已激活**的 SW 时 resolve。
 *     注册卡在 installing、或者上一版变成 redundant，它**永远挂着且不 reject**
 *   · `pushManager.subscribe()` 打的是外网推送服务，国内网络下很容易无响应
 *   · 服务端 action 断网就一直等
 *
 * 而收尾是 `catch { setError("订阅失败，可以稍后再试") }` ——
 * **异常对象被整个丢掉**。于是线上出问题时用户说不出发生了什么，
 * 我们也查不出来：唯一的信息就是那句我们自己写死的话。
 *
 * 所以这份测试盯的不是「订阅能不能成功」（那要真浏览器），
 * 而是**「出问题时它会不会说话」**。
 */

const src = readCode("components/notifications/PushManager.tsx");
const raw = readSource("components/notifications/PushManager.tsx");

describe("**不许再用 `serviceWorker.ready`**", () => {
  it("那个 promise 挂住时不 reject，是「一直显示设置中」的正主", () => {
    assert.equal(
      src.includes("serviceWorker.ready"),
      false,
      "又用回 serviceWorker.ready 了 —— 它永远不会告诉你它挂了",
    );
  });

  it("改用自己盯 statechange 的那条路", () => {
    assert.match(src, /async function activeRegistration\(\)/);
    assert.match(src, /addEventListener\("statechange"/);
  });

  it("**redundant 要立刻报错**，不能跟着一起等", () => {
    /*
     * 安装失败之后再等下去没有任何意义 —— 而这正是 `ready` 给不了的：
     * 它对 redundant 的反应也是继续等。
     */
    assert.match(src, /redundant/);
    assert.match(src, /reject\(new Error/);
  });

  it("**挂监听之前就已到位的情况要补判一次**", () => {
    // 只挂监听不补判的话，SW 恰好在这一瞬间激活就会错过事件，又是一次永久等待
    assert.match(src, /onChange\(\);/);
  });
});

describe("**每一步都有超时**", () => {
  it("三步各有各的预算", () => {
    for (const step of ["ready", "subscribe", "save"]) {
      assert.match(src, new RegExp(`${step}:\\s*\\d`), `${step} 没有超时预算`);
    }
  });

  it("三步都真的套上了 withTimeout", () => {
    const calls = src.match(/withTimeout\(/g) ?? [];
    assert.ok(calls.length >= 4, `只有 ${calls.length} 处用了超时`);
  });

  it("**超时说得出是哪一步** —— 「订阅失败」四个字查不出任何东西", () => {
    assert.match(src, /等待推送组件就绪/);
    assert.match(src, /向推送服务申请订阅/);
    assert.match(src, /把订阅存到服务器/);
  });

  it("超时器要清掉 —— 成功之后还留着一个定时 reject 是另一种坑", () => {
    assert.match(src, /clearTimeout\(timer\)/);
  });
});

describe("**异常不许再被吞掉**", () => {
  it("catch 拿到了异常对象", () => {
    assert.equal(
      /catch\s*\{/.test(src),
      false,
      "还有 `catch {}`：异常被整个丢掉，线上问题永远查不出来",
    );
  });

  it("报错里带上真实的 name 和 message", () => {
    /*
     * NotAllowedError / InvalidStateError / AbortError 这些名字是能搜的，
     * 而我们自己写的那句话不是。
     */
    assert.match(src, /e\.name/);
    assert.match(src, /e\.message/);
  });

  it("初始化失败那一条也带原因", () => {
    assert.match(src, /推送组件初始化失败（\$\{describeError\(e\)\}）/);
  });
});

describe("**换过 VAPID 公钥之后要能自愈**", () => {
  it("先退掉已有订阅再重新订", () => {
    /*
     * 旧订阅的 applicationServerKey 和新公钥对不上时，
     * `subscribe()` 抛 InvalidStateError —— 而那条报错在旧代码里被吃掉，
     * 界面上只剩「处理中…」。退掉重订是唯一能自愈的走法。
     */
    assert.match(src, /getSubscription\(\)/);
    assert.match(src, /existing\.unsubscribe\(\)/);
  });
});

describe("原来那些口径一条都不能少", () => {
  it("**服务端没收下就把浏览器侧也退掉**", () => {
    /*
     * 留着会出现最坏的状态：浏览器认为已订阅、服务端根本不知道，
     * 界面显示「已开启」而实际一条都不会来。
     */
    assert.match(src, /await sub\.unsubscribe\(\)/);
  });

  it("**每一种不能用都要说出来** —— 静默失败会让人安心地漏掉所有消息", () => {
    assert.match(raw, /每一种不能用都要说出来/);
    for (const state of ["unsupported", "unconfigured", "denied"]) {
      assert.match(src, new RegExp(`"${state}"`), `少了 ${state} 这一档`);
    }
  });

  it("不吃 HTTP 缓存 —— 缓存住 sw.js 的表现是「有人收得到有人收不到」", () => {
    assert.match(src, /updateViaCache: "none"/);
  });
});
