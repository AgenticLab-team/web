#!/usr/bin/env node
//
// 每条路由**实际要下载多少字节**。
//
// ═════════════════════════════════════════
// 为什么必须在生产构建上量
// ═════════════════════════════════════════
//
// 开发服务器发的是没压缩、带 source map、按需编译的 chunk ——
// 量出来的数比线上大好几倍，而且大得不成比例。
// 拿那个数做判断，会去优化一些线上根本不存在的东西。
//
// 这版 Next 的 `next build` 输出表里**已经没有每条路由的 First Load JS**
// 那两列了（只剩 Revalidate / Expire），所以只能自己量。
//
//   NEXT_DIST_DIR=.next-perf npx next build
//   NEXT_DIST_DIR=.next-perf npx next start -p 3062
//   node scripts/perf-audit.mjs http://localhost:3062 /forum /me …
//
// ─────────────────────────────────────────
// 这个站的读者一多半在微信里用手机看
// ─────────────────────────────────────────
//
// 那意味着：webview 冷启动、可能是 4G、可能在地铁里。
// 首屏要下多少 JS 是这类用户唯一真正感觉得到的性能指标 ——
// 比任何渲染耗时都直接。
import { assertHydrated, launch, setViewport, waitForHydration } from "./lib/cdp.mjs";

const [base, ...paths] = process.argv.slice(2);
if (!base || paths.length === 0) {
  console.error("用法：node scripts/perf-audit.mjs <基址> <路径…>");
  process.exit(1);
}

const [width, height] = (process.env.AUDIT_SIZE ?? "390,1600").split(",").map(Number);
/** 超过这个数就点名（KB）。不是硬标准，是「值得看一眼」的线 */
const BUDGET = Number(process.env.AUDIT_JS_BUDGET ?? 400);

const kb = (n) => Math.round(n / 1024);

const rows = [];
for (const path of paths) {
  const url = base.replace(/\/$/, "") + path;
  const cdp = await launch({ width, height });
  try {
    const types = new Map();
    const bytes = { script: 0, document: 0, stylesheet: 0, image: 0, font: 0, other: 0 };
    let requests = 0;

    /*
     * ⚠️ 要在 `Page.navigate` **之前**订阅。
     * 这些是一次性事件，加载完再问是问不到的 —— 而漏掉的样子是「0 字节」，
     * 和「这一页真的很轻」长得一模一样。
     */
    cdp.on("Network.responseReceived", (p) => {
      types.set(p.requestId, p.type);
      requests++;
    });
    cdp.on("Network.loadingFinished", (p) => {
      const t = (types.get(p.requestId) ?? "other").toLowerCase();
      const key = t in bytes ? t : "other";
      /*
       * `encodedDataLength` 是**压缩之后**、真正过网线的字节数。
       * 用解压后的大小会把 gzip 的功劳算掉，而用户等的是前者。
       */
      bytes[key] += p.encodedDataLength ?? 0;
    });

    await cdp.send("Network.enable");
    await cdp.send("Page.enable");
    await setViewport(cdp, { width, height });
    if (process.env.AUDIT_COOKIE) {
      const [name, ...rest] = process.env.AUDIT_COOKIE.split("=");
      await cdp.send("Network.setCookie", { name, value: rest.join("="), url, path: "/" });
    }
    await cdp.send("Page.navigate", { url });
    await waitForHydration(cdp);
    await assertHydrated(cdp, path);

    const total = Object.values(bytes).reduce((a, b) => a + b, 0);
    rows.push({ path, total, ...bytes, requests });
  } finally {
    await cdp.close();
  }
}

rows.sort((a, b) => b.script - a.script);
console.log("  JS    总计   请求  路由");
for (const r of rows) {
  const flag = kb(r.script) > BUDGET ? "❗" : "  ";
  console.log(
    `${flag}${String(kb(r.script)).padStart(4)}K ${String(kb(r.total)).padStart(5)}K ${String(r.requests).padStart(4)}  ${r.path}`,
  );
}

const worst = rows[0];
const median = rows[Math.floor(rows.length / 2)];
console.log(
  `\n最重的一页 ${worst.path}：JS ${kb(worst.script)}K；中位数 ${kb(median.script)}K` +
    `（点名线 ${BUDGET}K，可用 AUDIT_JS_BUDGET 调）`,
);
