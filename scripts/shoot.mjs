#!/usr/bin/env node
//
// 截图，**而且能先点几下**。
//
// ═════════════════════════════════════════
// 为什么值得为这个写一个工具
// ═════════════════════════════════════════
//
// `chrome --screenshot` 只能截「刚打开的样子」。而这个站里真正容易出错
// 的是**展开之后**：信的详情、域名编辑器、可折叠的后台行 ——
// 那些状态在客户端，URL 里没有。
//
// 一个晚上下来，三个线上真 bug 全是截图看出来的（空态按钮压住链接、
// 统计数字顶宽整行、页面标题被四张卡片埋在中间）——
// 而它们都是「测试全绿、类型全过、代码读起来没毛病」的那种。
// 展开态从来没被看过，只是因为看不了。
//
// 用 Node 自带的 WebSocket 直连 CDP，不装 puppeteer：
// 那个包连着一整个浏览器下载器，而这里只要三个协议方法。
//
//   node scripts/shoot.mjs <url> <输出.png> [--click 选择器]… [--expect 选择器]… [--wait 毫秒] [--size 宽,高] [--cookie k=v]
//
// `--click` 可以给多次，按顺序点。点不到就**报错退出**，不是静默继续 ——
// 静默继续的话，截回来的是一张没展开的图，而它长得和「展开了但没变化」
// 一模一样。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const [url, out] = args;
if (!url || !out) {
  console.error("用法：node scripts/shoot.mjs <url> <输出.png> [--click 选择器]… [--wait 毫秒] [--size 宽,高] [--cookie k=v]");
  process.exit(1);
}
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

const [width, height] = (opt("--size", "1440,2000")).split(",").map(Number);
const waitMs = Number(opt("--wait", "2500"));
const clicks = all("--click");
/*
 * 点完必须出现的东西。
 *
 * 没有这一条的话，「点了但没生效」和「点了也生效了」截出来的图
 * 需要我自己盯着像素分辨 —— 而 React 没水合完时 `.click()` 照样
 * 返回成功（DOM 元素在，只是还没绑上 onClick）。
 * 那种失败最像「这个功能本来就长这样」。
 */
const expects = all("--expect");
/*
 * 点完把某一块的文字打出来。
 *
 * `--expect` 只回答「有没有」，而排查时要的是「那儿现在是什么」——
 * 一个报错？一个 loading？还是真的内容？
 * 靠盯像素分辨这三者很慢，而它们在文字上一眼就分得开。
 */
const prints = all("--print");
/*
 * 跑一段表达式并打印结果。
 *
 * `--print` 给的是文字，而排查布局要的是**数字** ——
 * 「这一页是不是比视口宽」这种问题，看图看不出来（浏览器会把
 * 溢出的部分直接切掉，切得和「本来就这么短」一模一样）。
 */
const evals = all("--eval");
const cookies = all("--cookie");

const CHROME =
  process.env.CHROME_PATH ??
  ".claude/worktrees/audit-refactor/chrome/linux-152.0.7977.42/chrome-linux64/chrome";

const profile = mkdtempSync(join(tmpdir(), "shoot-"));
const port = 9222 + Math.floor(Math.random() * 500);

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--no-sandbox",
  "--disable-gpu",
  "--hide-scrollbars",
  `--window-size=${width},${height}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 CDP 起来。它有几百毫秒的启动时间，而失败的样子是 ECONNREFUSED */
async function endpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const tabs = await res.json();
      const page = tabs.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // 还没起来
    }
    await sleep(200);
  }
  throw new Error("Chrome 的调试端口没起来");
}

let id = 0;
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ready, send, close: () => ws.close() };
}

try {
  const cdp = connect(await endpoint());
  await cdp.ready;

  for (const c of cookies) {
    const [name, ...rest] = c.split("=");
    await cdp.send("Network.setCookie", {
      name,
      value: rest.join("="),
      url,
      path: "/",
    });
  }

  /*
   * ⚠️ **视口用 `Emulation.setDeviceMetricsOverride` 定，不能靠 `--window-size`。**
   *
   * `--window-size=390,1200` 在 headless=new 下**不生效** ——
   * 实测 `innerWidth` 是 500（那是它的最小窗口宽）。
   *
   * 而这个错的表现极其误导：截回来的图是 500 宽，我按 390 去裁，
   * 于是右边 110px 被我自己切掉 —— 看起来就像**正文横向溢出**。
   * 我照着那张图查了半天布局，而布局根本没问题。
   *
   * 是这个脚本自己的 `--eval` 把它戳穿的（`innerWidth` 打出来是 500）。
   */
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    // 窄视口时按移动设备算 —— 否则 hover 态和触摸目标都不是真实的样子
    mobile: width < 700,
  });

  /*
   * ⚠️ `mobile: true` **不会**让 `navigator.maxTouchPoints` 变成非零。
   *
   * 那两件事在 CDP 里是分开的，而站里有代码按 `maxTouchPoints` 判
   * 「要不要提键盘快捷键」—— 只设 mobile 的话，那条分支永远测不到：
   * 视口是手机的宽度，而设备还说自己没有触摸屏。
   *
   * 踩过一次：手机档截出来的图上照样写着「Ctrl↵ 发布」，
   * 而那一行本该整个不出现。
   */
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: width < 700,
    maxTouchPoints: width < 700 ? 5 : 0,
  });

  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url });
  await sleep(waitMs);

  for (const selector of clicks) {
    /*
     * 点不到就报错退出。
     *
     * 静默继续的话，截回来的是一张没展开的图 —— 而它长得和
     * 「展开了但什么都没变」一模一样，于是我会对着它得出错误结论。
     */
    /*
     * 支持 `选择器>>3` 挑第几个。
     *
     * CSS 的 `:nth-of-type` 是「在**各自父元素里**排第几」——
     * 而一串同类元素常常各有各的父（每个域名一行、每行一个 div），
     * 于是它们全都是「第 1 个」。踩过一次：想点第三个域名行，
     * `:nth-of-type(1)` 点中的是别的东西。
     */
    const [sel, nth] = selector.split(">>");
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const list = [...document.querySelectorAll(${JSON.stringify(sel)})];
        const el = list[${Number(nth ?? 0)}];
        if (!el) return "找不到（一共 " + list.length + " 个）";
        el.click();
        return "ok";
      })()`,
      returnByValue: true,
    });
    if (result.value !== "ok") throw new Error(`点不到 ${selector}：${result.value}`);
    await sleep(1200);
  }

  for (const selector of expects) {
    /*
     * 等它出现，而不是立刻判。点击之后要渲染，而渲染要时间；
     * 立刻判的话会误报，然后我会去加 sleep —— 那是猜。
     */
    let ok = false;
    for (let i = 0; i < 25; i++) {
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
        returnByValue: true,
      });
      if (result.value) { ok = true; break; }
      await sleep(400);
    }
    if (!ok) throw new Error(`点完之后没等到 ${selector} —— 多半是 React 还没水合，加大 --wait`);
  }

  for (const selector of prints) {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `[...document.querySelectorAll(${JSON.stringify(selector)})]
        .map((e) => e.innerText.trim().slice(0, 300)).join("\\n---\\n") || "（没匹配到）"`,
      returnByValue: true,
    });
    console.log(`【${selector}】\n${result.value}`);
  }

  for (const expr of evals) {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    });
    console.log(`【${expr}】 ${JSON.stringify(result.value)}`);
  }

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`截好了 ${out}（点了 ${clicks.length} 下）`);
  cdp.close();
} finally {
  /*
   * 等 Chrome 真的退出再删目录。
   *
   * 直接删的话会 `ENOTEMPTY` —— 它还在往 profile 里写东西。
   * 那个报错不影响截图（图已经写好了），但它会让脚本以非零码退出，
   * 而调用方多半是 `&&` 串起来的一串命令。
   */
  chrome.kill();
  await new Promise((resolve) => {
    chrome.once("exit", resolve);
    setTimeout(resolve, 3000);
  });
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
