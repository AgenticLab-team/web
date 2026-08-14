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
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return "找不到";
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
