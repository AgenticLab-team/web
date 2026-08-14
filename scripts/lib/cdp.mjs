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

/*
 * ⚠️ 被打断时也要收拾，而信号处理**只能注册一次**。
 *
 * 原来只在正常路径上 `close()` —— 一旦命令超时或者被 Ctrl-C，
 * 父进程死了而 Chrome **活了下来**，profile 目录也留在 /tmp 里。
 * 实测攒到 57 个目录、222MB —— 正好是这个文件顶上那句
 * 「清理写漏了表现是跑几十次之后磁盘满了」。
 * 我写下那句话的时候，它已经在发生了。
 *
 * 而第一版把处理器写进了 `launch()` 里：一次批量跑要开二十个浏览器，
 * 于是二十份处理器，Node 直接警告「11 个 SIGTERM 监听器，
 * 可能有内存泄漏」。同一个注释里预言过的第二种错，也照样犯了。
 *
 * 所以：一个进程级的集合 + 一次性注册。
 */
const live = new Set();
const killAll = () => {
  for (const c of live) { try { c.kill(); } catch { /* 已经没了 */ } }
  live.clear();
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(sig, () => { killAll(); process.exit(130); });
}
process.once("exit", killAll);

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
  /*
   * 事件订阅。
   *
   * 有些东西**只以事件的形式出现，问是问不到的** ——
   * 页面在控制台里喊的话、抛出来的异常、失败的请求。
   * 等页面加载完再去查，那些消息早就过去了。
   */
  const listeners = new Map();
  let id = 0;
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
      return;
    }
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
    live.delete(chrome);
    try { ws.close(); } catch { /* 已经断了 */ }
    chrome.kill();
    await new Promise((resolve) => {
      chrome.once("exit", resolve);
      setTimeout(resolve, 3000);
    });
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  /** 订阅一个协议事件。要在触发它的动作**之前**订阅 */
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };

  live.add(chrome);

  return { send, on, close };
}

/**
 * 跑一段表达式，把值取回来。
 *
 * `awaitPromise` 一直开着：不开的话，一段返回 Promise 的表达式
 * 会被序列化成 `{}` —— 那看起来像「探针什么都没查到」，
 * 而实际上它还没跑完。踩过一次，查了半天探针本身。
 */
export async function evaluate(cdp, expression) {
  const { result } = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
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

/*
 * ═════════════════════════════════════════
 * 页面**水合了没有** —— 这一晚上最贵的一课
 * ═════════════════════════════════════════
 *
 * 我这一整晚的浏览器审计都跑在 `127.0.0.1:3051` 上，而 Next 16 的
 * 开发期跨源保护默认只认启动时那个 hostname（`localhost`）——
 * 于是 `/_next/static/chunks/*` 全被 403 掉。
 *
 * 服务端渲染的 HTML 照常显示，页面看着**完全正常**：
 * 配色对、布局对、文字对、截图跟真的一样。而客户端一行都没跑。
 * 实测：同一页在 127.0.0.1 下 15 个按钮**没有一个**挂上 React，
 * 换成 localhost 15 个全挂上。
 *
 * 也就是说，「Tab 走一圈焦点都看得见」这类结论，
 * 有可能是在一个没有任何交互的静态页面上得出来的。
 *
 * 所以每个工具跑之前都硬卡一道：没水合就直接报错，别出结论。
 * 这类失败必须吵，因为它的样子和「一切正常」一模一样。
 */
export const HYDRATION_EXPR = `(() => {
  const els = [...document.querySelectorAll("button, a[href], input")];
  const live = els.filter((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber$")));
  return { total: els.length, live: live.length };
})()`;

/**
 * 等到页面**真的水合了**再往下走，而不是死等一个固定秒数。
 *
 * ─────────────────────────────────────────
 * 13 秒是拍脑袋定的，而它是整个审计最大的一笔开销
 * ─────────────────────────────────────────
 *
 * 每页 13 秒，八页就是快两分钟纯等待 —— 加上启动和探测，
 * 一批八页会顶到十分钟的命令上限，而我第一次撞上时
 * 以为是某一页卡死了，逐页跑了三轮才发现每页都正常，是**累计**。
 *
 * 改成轮询之后，等待时间由页面自己决定：快的几百毫秒就走。
 * 上限还在（默认 15 秒），但那是兜底，不是常态。
 *
 * 水合完再多给一小段安顿时间 —— 有些东西是 effect 里才挂上的
 * （倒计时、相对时间、抽屉），紧接着就量会量到中间态。
 */
export async function waitForHydration(cdp, { timeout = 15_000, settle = 700 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const r = await evaluate(cdp, HYDRATION_EXPR).catch(() => null);
    if (r && r.live > 0) {
      await sleep(settle);
      return true;
    }
    await sleep(300);
  }
  return false;   // 交给 assertHydrated 去给出那条更长的错误信息
}

export async function assertHydrated(cdp, where) {
  const r = await evaluate(cdp, HYDRATION_EXPR);
  if (!r || r.total === 0) throw new Error(`${where}：一个可交互元素都没有，抓到的不像是真页面`);
  if (r.live === 0) {
    throw new Error(
      `${where}：${r.total} 个可交互元素**一个都没挂上 React** —— 页面没水合，量出来的东西不算数。\n` +
      "  最常见的原因：用 127.0.0.1 访问 next dev，chunk 被跨源保护 403 掉了。改用 localhost。",
    );
  }
}
