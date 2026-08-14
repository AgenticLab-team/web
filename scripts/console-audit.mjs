#!/usr/bin/env node
//
// 页面自己在控制台里喊的话，收起来看。
//
// ═════════════════════════════════════════
// 为什么这一类问题测试全都看不见
// ═════════════════════════════════════════
//
// 服务端测试渲染的是 HTML 字符串，客户端测试渲染的是组件树 ——
// 两边都**没有真正水合过**。而水合不匹配（服务端渲染出 A、
// 浏览器算出 B）只在真浏览器里、在两者对不上的那一瞬间报出来。
//
// 它的症状还特别温和：React 悄悄把客户端那一版换上去，页面看着正常，
// 只有控制台里一行警告。而代价是那一整棵子树被丢掉重建 ——
// 输入框里的字没了、滚动位置跳了、动画重放一遍。
//
// 同理还有：挂掉的请求（图片 404、接口 500）、CSP 拦下来的东西、
// 没人接的 Promise 异常。它们都不会让页面白屏，所以谁也不会去报。
//
//   node scripts/console-audit.mjs <基址> <路径…>
//
// `AUDIT_COOKIE` 给会话，`AUDIT_SIZE` 换视口。
import { assertHydrated, waitForHydration, launch, setViewport } from "./lib/cdp.mjs";

const [base, ...paths] = process.argv.slice(2);
if (!base || paths.length === 0) {
  console.error("用法：node scripts/console-audit.mjs <基址> <路径…>");
  process.exit(1);
}

const [width, height] = (process.env.AUDIT_SIZE ?? "1440,1600").split(",").map(Number);
/*
 * 消息截多长。默认短一点好读，排查时 `AUDIT_MSG_LEN=900` 看全文 ——
 * React 的水合报错前 220 个字全是套话，**真正指出哪一段文字对不上的
 * 那部分在后面**。
 */
const LEN = Number(process.env.AUDIT_MSG_LEN ?? 220);

/*
 * 开发服务器自己的噪音。
 *
 * 这几条是构建工具和热更新在喊，不是页面的问题 ——
 * 不滤掉的话每一页都会顶着几条固定的噪音，而人对固定噪音的反应
 * 是不再看这份报告。
 */
const NOISE = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /webpack-hmr|turbopack-hmr|_next\/static\/chunks\/.*\.hot-update/i,
  /React Router Future Flag/i,
];
const isNoise = (text) => NOISE.some((re) => re.test(text));

let problems = 0;
for (const path of paths) {
  const url = base.replace(/\/$/, "") + path;
  const cdp = await launch({ width, height });
  try {
    const found = [];

    /*
     * ⚠️ 订阅要在 `Page.navigate` **之前**。
     *
     * 这些东西只以事件的形式出现一次，加载完再去问是问不到的 ——
     * 而那种漏法的表现是「一片干净」，和真的干净一模一样。
     */
    cdp.on("Runtime.consoleAPICalled", (p) => {
      if (p.type !== "error" && p.type !== "warning") return;
      const text = (p.args ?? [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? "")
        .join(" ")
        .trim();
      if (!text || isNoise(text)) return;
      found.push(`控制台${p.type === "error" ? "报错" : "警告"}：${text.slice(0, LEN)}`);
    });

    cdp.on("Runtime.exceptionThrown", (p) => {
      const d = p.exceptionDetails ?? {};
      const text = d.exception?.description ?? d.text ?? "";
      if (!text || isNoise(text)) return;
      found.push(`没人接的异常：${text.split("\n")[0].slice(0, LEN)}`);
    });

    cdp.on("Log.entryAdded", (p) => {
      const e = p.entry ?? {};
      if (e.level !== "error" && e.level !== "warning") return;
      if (!e.text || isNoise(e.text)) return;
      found.push(`${e.source}：${e.text.slice(0, 160)}${e.url ? `  ← ${e.url.slice(0, 90)}` : ""}`);
    });

    cdp.on("Network.responseReceived", (p) => {
      const r = p.response ?? {};
      if (r.status < 400) return;
      found.push(`请求 ${r.status}：${r.url.slice(0, 120)}`);
    });

    cdp.on("Network.loadingFailed", (p) => {
      // 取消掉的请求不算 —— 路由切换时正常会取消一批
      if (p.canceled) return;
      found.push(`请求失败（${p.errorText}）：${p.type}`);
    });

    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.enable");
    await setViewport(cdp, { width, height });
    if (process.env.AUDIT_COOKIE) {
      const [name, ...rest] = process.env.AUDIT_COOKIE.split("=");
      await cdp.send("Network.setCookie", { name, value: rest.join("="), url, path: "/" });
    }

    await cdp.send("Page.navigate", { url });
    await waitForHydration(cdp);

    /*
     * 「一条消息都没有」必须是**跑起来了才没有**。
     * 没水合的页面同样一句话不说，而那是最像成功的一种失败。
     */
    await assertHydrated(cdp, path);

    // 同一条消息在一页里可能喊很多遍（列表里每一项各喊一次）
    const uniq = [...new Set(found)];
    problems += uniq.length;
    console.log(`${uniq.length === 0 ? "✅" : "❌"} ${path}${uniq.length ? `（${uniq.length} 条）` : ""}`);
    for (const f of uniq.slice(0, 10)) console.log(`    ${f}`);
    if (uniq.length > 10) console.log(`    …另有 ${uniq.length - 10} 条`);
  } finally {
    await cdp.close();
  }
}

console.log(problems === 0 ? "\n加载这些页面时，浏览器一句话都没说" : `\n一共 ${problems} 条`);
process.exit(problems === 0 ? 0 : 1);
