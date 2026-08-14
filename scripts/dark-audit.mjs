#!/usr/bin/env node
//
// 深色模式体检：**同一个元素在浅色和深色下颜色一模一样**的，就是没跟着主题走。
//
// ═════════════════════════════════════════
// 为什么是「两边一样」而不是「深色下底色偏亮」
// ═════════════════════════════════════════
//
// 第一版判据是后者，结果全是误报：反应按钮的珊瑚色、发布按钮的薄荷绿
// 都是品牌色，它们在深色下**本来就该亮**。
//
// 而一个忘了主题化的表面有个明确的指纹：它在两套配色下**一个字节都不变**。
// 那是写死的颜色，或者一个只在 `:root` 里定义过、没在深色块里重定义的变量。
//
//   node scripts/dark-audit.mjs <基址> <路径…>
//
// 需要一个能登录的会话 —— 从 `AUDIT_COOKIE` 环境变量读。
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [base, ...paths] = process.argv.slice(2);
if (!base || paths.length === 0) {
  console.error("用法：node scripts/dark-audit.mjs <基址> <路径…>");
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "dark-audit-"));

/*
 * 用**位置**当 key，不用选择器。
 *
 * 同一棵树在两次加载里结构一样，而 Tailwind 那一长串类名在两边是
 * 同一个字符串 —— 分不出同一个类名的第三个和第五个。
 */
const probe = `(() => {
  const out = {};
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 12) continue;
    const s = getComputedStyle(el);
    out[el.tagName + "@" + Math.round(r.x) + "," + Math.round(r.y) + "," + Math.round(r.width)] =
      s.backgroundColor + "|" + s.color + "|" + (el.className || "").toString().slice(0, 45);
  }
  return out;
})()`;
const probeFile = join(tmp, "probe.js");
writeFileSync(probeFile, probe);

const brightness = (css) => {
  const m = css.match(/[\d.]+/g);
  if (!m) return null;
  // 半透明的看不出真色 —— 它盖在什么上面决定了它长什么样
  if (m[3] !== undefined && Number(m[3]) < 0.5) return null;
  return 0.2126 * +m[0] + 0.7152 * +m[1] + 0.0722 * +m[2];
};

function capture(url, dark) {
  const out = execFileSync(
    "node",
    [
      "scripts/shoot.mjs",
      url,
      join(tmp, "shot.png"),
      "--size", "1440,1600",
      "--wait", "13000",
      ...(process.env.AUDIT_COOKIE ? ["--cookie", process.env.AUDIT_COOKIE] : []),
      ...(dark ? ["--dark"] : []),
      "--eval-file", probeFile,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  /*
   * 从整段输出里捞那一行 JSON，**不能按行找**。
   *
   * `--eval-file` 回显的是整个文件的内容，那是几十行 ——
   * 于是「以【开头的那一行」找到的是文件的第一行，而不是结果。
   * 结果跟在最后一个 `】 ` 后面，而 JSON.stringify 不会产生换行。
   */
  const at = out.lastIndexOf("】 ");
  if (at === -1) throw new Error(`没拿到样式快照：\n${out.slice(0, 400)}`);
  const json = out.slice(at + 2).split("\n")[0];
  const parsed = JSON.parse(json);
  /*
   * 下限定在 15 个，而不是 1 个。
   *
   * 「量到 3 个元素」和「量到 0 个」都说明抓的不是真页面，
   * 而只判 0 的话，一个只剩骨架的错误页照样能过。
   */
  if (Object.keys(parsed).length < 15) {
    throw new Error(`${url} 只量到 ${Object.keys(parsed).length} 个元素 —— 抓到的不像是真页面`);
  }
  return parsed;
}

/**
 * 先确认这一页**真的是那一页**。
 *
 * ─────────────────────────────────────────
 * 踩过：审计对着一个 500 页报了 ✅
 * ─────────────────────────────────────────
 *
 * 我往首页里塞了一块写死的浅色底，想验一下这把尺子量不量得出东西 ——
 * 结果它说「没问题」。而真相是我塞的那块 JSX 有语法错误，
 * 整页没编译过，浏览器拿到的是一个错误页。
 *
 * 错误页在浅色和深色下**长得完全一样**（它根本没用站里的配色），
 * 于是「两边一模一样」这个判据在它身上一个都不报 ——
 * 一页全绿，而我一个像素都没真的检查过。
 *
 * 这类失败最坏的地方在于它的形状和「全都对」一模一样。
 */
async function assertRealPage(url) {
  /*
   * ⚠️ 必须带上浏览器的 `Accept`。
   *
   * 裸域名的 `/` 对**命令行客户端**回的是安装脚本那段 shell
   * （`src/proxy.ts` 里那条改写）—— 而 `fetch` 在它眼里就是命令行。
   * 不带 Accept 的话，这个守卫验的是一段 shell：200、没有错误标记、
   * 一路绿灯，而浏览器那边拿到的是完全另一个东西。
   *
   * 守卫和被审的对象必须是**同一个响应**，否则它守的是别处。
   */
  const res = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 (dark-audit)",
      ...(process.env.AUDIT_COOKIE ? { cookie: process.env.AUDIT_COOKIE } : {}),
    },
    redirect: "manual",
  });
  if (res.status !== 200) {
    throw new Error(`${url} 返回 ${res.status} —— 这不是要审的那一页（没登录？编译错误？）`);
  }
  const html = await res.text();
  // Next 的错误页会带上它自己的错误覆盖层
  if (/__next_error__|Ecmascript file had an error|Build Error/.test(html)) {
    throw new Error(`${url} 是一个错误页 —— 先把编译错误修好`);
  }
}

let bad = 0;
for (const path of paths) {
  const url = base.replace(/\/$/, "") + path;
  await assertRealPage(url);
  const light = capture(url, false);
  const dark = capture(url, true);

  const seen = new Set();
  const hits = [];
  for (const [key, v] of Object.entries(dark)) {
    if (!(key in light)) continue;
    const [dbg, dfg, cls] = v.split("|");
    const [lbg] = light[key].split("|");
    if (dbg !== lbg) continue;                       // 变了就是好的
    const L = brightness(dbg);
    if (L === null || L < 140) continue;             // 不是浅色底就无所谓
    if (seen.has(cls)) continue;
    seen.add(cls);
    hits.push(`    ${cls}  bg=${dbg} fg=${dfg}`);
  }

  bad += hits.length;
  console.log(`${hits.length === 0 ? "✅" : "❌"} ${path}${hits.length ? `（${hits.length} 处）` : ""}`);
  for (const h of hits) console.log(h);
}

rmSync(tmp, { recursive: true, force: true });
console.log(bad === 0 ? "\n深色下没有发现没跟着主题走的表面" : `\n一共 ${bad} 处`);
process.exit(bad === 0 ? 0 : 1);
