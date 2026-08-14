//
// 起一个无头 Chrome 并连上它的调试协议。
//
// ═════════════════════════════════════════
// 为什么不是 puppeteer
// ═════════════════════════════════════════
//
// 那个包连着一整个浏览器下载器，而这里要的只有几个协议方法。
// Node 自带 WebSocket 之后，这一层是六十行。
//
// 抽出来是因为**第二个工具要用**（`focus-audit.mjs`）——
// 各写一份的话，两边会各自长出不一样的启动等待和清理逻辑，
// 而那两处正是最容易出错、也最难在症状上认出来的地方：
// 启动等待写短了表现是「偶发的 ECONNREFUSED」，
// 清理写漏了表现是「跑几十次之后磁盘满了」。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME_PATH ??
  ".claude/worktrees/audit-refactor/chrome/linux-152.0.7977.42/chrome-linux64/chrome";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 起浏览器、连上、把 `{ send, close }` 交出去。
 *
 * `close()` 会等 Chrome 真的退出再删 profile —— 直接删会 `ENOTEMPTY`
 * （它还在往里写东西），而那个报错不影响已经拿到的结果，
 * 只会让脚本以非零码退出，坑掉调用方那一串 `&&`。
 */
export async function launch({ width = 1440, height = 1600 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "cdp-"));
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

  /* 等调试端口起来 —— 它有几百毫秒的启动时间，失败的样子是 ECONNREFUSED */
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const page = (await res.json()).find((t) => t.type === "page");
      wsUrl = page?.webSocketDebuggerUrl ?? null;
    } catch {
      // 还没起来
    }
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) {
    chrome.kill();
    rmSync(profile, { recursive: true, force: true });
    throw new Error("Chrome 的调试端口没起来");
  }

  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  });
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  const close = async () => {
    try { ws.close(); } catch { /* 已经断了 */ }
    chrome.kill();
    await new Promise((resolve) => {
      chrome.once("exit", resolve);
      setTimeout(resolve, 3000);
    });
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  return { send, close };
}

/** 跑一段表达式，把值取回来 */
export async function evaluate(cdp, expression) {
  const { result } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  return result.value;
}

/**
 * 设视口。
 *
 * ⚠️ **必须用 `Emulation.setDeviceMetricsOverride`，不能靠 `--window-size`。**
 *
 * `--window-size=390,1200` 在 headless=new 下**不生效** ——
 * 实测 `innerWidth` 是 500（那是它的最小窗口宽）。
 * 那个错的表现极其误导：截回来的图是 500 宽，按 390 去裁，
 * 于是右边 110px 被自己切掉 —— 看起来就像正文横向溢出。
 *
 * ⚠️ `mobile: true` **不会**让 `navigator.maxTouchPoints` 变成非零，
 * 那在 CDP 里是分开的两件事；而站里有代码按它决定要不要提键盘快捷键。
 * 只设 mobile 的话那条分支永远测不到：视口是手机的宽，
 * 而设备还说自己没有触摸屏。
 *
 * ⚠️ `maxTouchPoints` 只接受 **1–16**，关掉时不能传 0。
 */
export async function setViewport(cdp, { width, height }) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 700,
  });
  if (width < 700) {
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  }
}
