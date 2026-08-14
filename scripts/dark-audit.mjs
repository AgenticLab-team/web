#!/usr/bin/env node
//
// 深色模式体检。两件事：**有没有忘了主题化的表面**、**文字读不读得出来**。
//
// ═════════════════════════════════════════
// 判据一：两套配色下颜色一模一样 = 没跟着主题走
// ═════════════════════════════════════════
//
// 第一版判据是「深色下底色偏亮」，结果全是误报：反应按钮的珊瑚色、
// 发布按钮的薄荷绿都是品牌色，它们在深色下**本来就该亮**。
//
// 而一个忘了主题化的表面有个明确的指纹：它在两套配色下**一个字节都不变**。
// 那是写死的颜色，或者一个只在 `:root` 里定义过、没在深色块里重定义的变量。
//
// ═════════════════════════════════════════
// 判据二：对比度
// ═════════════════════════════════════════
//
// 判据一查不出最常见的那类深色 bug —— 一段文字**完全跟着主题走了**，
// 只是走到了一个和背景差不多深的地方。它在浅色下是「低调的次要文字」，
// 在深色下是「看不见」。颜色变了，所以判据一放它过去。
//
//   node scripts/dark-audit.mjs <基址> <路径…>
//
// 需要一个能登录的会话 —— 从 `AUDIT_COOKIE` 环境变量读。
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * 视口宽度。默认桌面，`AUDIT_SIZE=390,1600` 换手机档。
 *
 * ─────────────────────────────────────────
 * 手机端不是「同一套东西窄一点」
 * ─────────────────────────────────────────
 *
 * 窄视口下换的是另一批组件：底部导航、抽屉、折叠起来的侧栏，
 * 还有一整条按 `maxTouchPoints` 走的分支（要不要提键盘快捷键）。
 * 那些东西在 1440 宽下**根本不渲染** —— 桌面档全绿，
 * 说明的是桌面那一套没问题，而不是这一页没问题。
 */
const SIZE = process.env.AUDIT_SIZE ?? "1440,1600";

const [base, ...paths] = process.argv.slice(2);
if (!base || paths.length === 0) {
  console.error("用法：node scripts/dark-audit.mjs <基址> <路径…>");
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "dark-audit-"));

/*
 * 在页面里跑的那段。
 *
 * 用**位置**当 key，不用选择器：同一棵树在两次加载里结构一样，
 * 而 Tailwind 那一长串类名在两边是同一个字符串 ——
 * 分不出同一个类名的第三个和第五个。
 */
const probe = `(() => {
  const parse = (c) => {
    const m = String(c).match(/[\\d.]+/g);
    if (!m) return null;
    return [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]];
  };
  /** 把 fg 叠在 bg 上 —— 半透明的颜色单看没有意义 */
  const over = (fg, bg) => [
    fg[0] * fg[3] + bg[0] * (1 - fg[3]),
    fg[1] * fg[3] + bg[1] * (1 - fg[3]),
    fg[2] * fg[3] + bg[2] * (1 - fg[3]),
    1,
  ];
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  /*
   * 有效背景：从元素往上走，把每一层的底色叠起来。
   *
   * 直接读 backgroundColor 绝大多数时候拿到的是 rgba(0,0,0,0) ——
   * 站里的卡片、行、标签几乎都是透明底加一层浅浅的 overlay，
   * 真正的底色在祖先身上。不往上走的话，几乎每一段文字都会被
   * 当成「透明底」而算不出对比度。
   */
  const effBg = (el) => {
    const stack = [];
    let n = el;
    while (n && n.nodeType === 1) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) stack.push(c);
      n = n.parentElement;
    }
    const scheme = getComputedStyle(document.documentElement).colorScheme || "";
    let acc = scheme.indexOf("dark") !== -1 ? [18, 18, 18, 1] : [255, 255, 255, 1];
    for (let i = stack.length - 1; i >= 0; i--) acc = over(stack[i], acc);
    return acc;
  };

  /** 一路乘下来的 opacity —— 半透明的容器会把里面的字一起拉淡 */
  const cumulativeOpacity = (el) => {
    let o = 1, n = el;
    while (n && n.nodeType === 1) {
      o *= Number(getComputedStyle(n).opacity || 1);
      n = n.parentElement;
    }
    return o;
  };

  const surfaces = {};
  const text = [];

  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 12) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden") continue;

    const key = el.tagName + "@" + Math.round(r.x) + "," + Math.round(r.y) + "," + Math.round(r.width);
    const cls = (el.className || "").toString().slice(0, 45);
    surfaces[key] = s.backgroundColor + "|" + s.color + "|" + cls;

    /*
     * 只看**自己直接带文字**的元素。
     *
     * 不加这一条的话，一段文字会被它的每一层祖先重复报一遍
     * （color 是继承的），而那些祖先的有效背景还各不相同 ——
     * 同一句话报出五条互相矛盾的对比度。
     */
    let own = "";
    for (const node of el.childNodes) {
      if (node.nodeType === 3) own += node.nodeValue;
    }
    own = own.trim();
    if (own.length < 2) continue;

    const fg = parse(s.color);
    if (!fg) continue;
    const bg = effBg(el);
    const alpha = fg[3] * cumulativeOpacity(el);
    if (alpha <= 0.05) continue;   // 基本是隐藏的，不是对比度问题
    const composed = over([fg[0], fg[1], fg[2], alpha], bg);

    const size = parseFloat(s.fontSize) || 16;
    const weight = Number(s.fontWeight) || 400;
    // WCAG：大字（≥24px，或 ≥18.66px 且加粗）门槛是 3:1，其余 4.5:1
    const large = size >= 24 || (size >= 18.66 && weight >= 700);

    text.push({
      key,
      cls,
      sample: own.slice(0, 24),
      ratio: Math.round(ratio(composed, bg) * 100) / 100,
      need: large ? 3 : 4.5,
      fg: s.color,
      bg: "rgb(" + Math.round(bg[0]) + ", " + Math.round(bg[1]) + ", " + Math.round(bg[2]) + ")",
    });
  }
  return { surfaces, text };
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

function capture(url, dark, clicks) {
  const out = execFileSync(
    "node",
    [
      "scripts/shoot.mjs",
      url,
      join(tmp, "shot.png"),
      "--size", SIZE,
      "--wait", "13000",
      ...(process.env.AUDIT_COOKIE ? ["--cookie", process.env.AUDIT_COOKIE] : []),
      ...(dark ? ["--dark"] : []),
      ...clicks.flatMap((c) => ["--click", c]),
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
  const parsed = JSON.parse(out.slice(at + 2).split("\n")[0]);
  /*
   * 下限定在 15 个，而不是 1 个。
   *
   * 「量到 3 个元素」和「量到 0 个」都说明抓的不是真页面，
   * 而只判 0 的话，一个只剩骨架的错误页照样能过。
   */
  if (Object.keys(parsed.surfaces).length < 15) {
    throw new Error(`${url} 只量到 ${Object.keys(parsed.surfaces).length} 个元素 —— 抓到的不像是真页面`);
  }
  return parsed;
}

let bad = 0;
for (const spec of paths) {
  /*
   * `路径::选择器::选择器` —— 点开之后再量。
   *
   * ─────────────────────────────────────────
   * 只量「刚打开的样子」等于没量展开态
   * ─────────────────────────────────────────
   *
   * 信的详情、域名编辑器、可折叠的后台行 —— 那些状态在客户端，
   * URL 里没有。而它们恰恰是这个站里最容易出错的地方
   * （今晚三个线上真 bug 全在展开之后）。
   *
   * 点不到的话 `shoot.mjs` 会直接报错退出，这里就跟着炸 ——
   * 静默继续的话量的是没展开的那一页，而它和「展开了但没变化」
   * 长得一模一样。
   */
  const [path, ...clicks] = spec.split("::");
  const url = base.replace(/\/$/, "") + path;
  await assertRealPage(url);
  const light = capture(url, false, clicks);
  const dark = capture(url, true, clicks);

  /*
   * 两次加载得对得上，否则「相同」这个判据无从谈起。
   *
   * 位置当 key，而只要有一点渲染差异（动画没停、时间戳变了一个字、
   * 随机排序），两边的 key 就整片对不上 —— 表现是
   * 「一条都不报」，和「全都对」一模一样。踩过一次错误页，
   * 不想再踩第二次同形状的。
   */
  const overlap = Object.keys(dark.surfaces).filter((k) => k in light.surfaces).length;
  const cover = overlap / Object.keys(dark.surfaces).length;
  if (cover < 0.6) {
    throw new Error(
      `${spec}：两次加载只有 ${Math.round(cover * 100)}% 的元素对得上（${overlap}/${Object.keys(dark.surfaces).length}）—— ` +
      "布局在两次之间动了，这一页的结果不能信",
    );
  }

  /* ── 判据一：两边一模一样的浅色表面 ── */
  const seenSurface = new Set();
  const unthemed = [];
  for (const [key, v] of Object.entries(dark.surfaces)) {
    if (!(key in light.surfaces)) continue;
    const [dbg, dfg, cls] = v.split("|");
    const [lbg] = light.surfaces[key].split("|");
    if (dbg !== lbg) continue;                       // 变了就是好的
    const L = brightness(dbg);
    if (L === null || L < 140) continue;             // 不是浅色底就无所谓
    if (seenSurface.has(cls)) continue;
    seenSurface.add(cls);
    unthemed.push(`    没跟着主题走：${cls}  bg=${dbg} fg=${dfg}`);
  }

  /* ── 判据二：深色下读不出来的文字 ── */
  const lightByKey = new Map(light.text.map((t) => [t.key, t]));
  const seenText = new Set();
  const lowContrast = [];
  /*
   * 两套配色下都不够的单独记一笔，**不算这一轮的问题**。
   *
   * 那是全站一致的取舍（四级文字、占位符、禁用态），不是深色回归。
   * 但也不能就这么消失 —— 它是另一件该查的事，
   * 藏起来的话下一个人会以为对比度全站都过了。
   */
  const both = [];
  for (const t of dark.text) {
    if (t.ratio >= t.need) continue;
    /*
     * 只报**深色下才不够**的。
     *
     * 两套配色下都不够的，那是全站一致的设计取舍（比如四级文字），
     * 而这一轮问的是「深色这一半有没有被落下」。
     * 混在一起报的话，真正的深色回归会被淹在几十条设计取舍里。
     */
    const l = lightByKey.get(t.key);
    if (l && l.ratio < l.need) { both.push({ ...t, lightRatio: l.ratio }); continue; }
    if (seenText.has(t.cls + t.ratio)) continue;
    seenText.add(t.cls + t.ratio);
    lowContrast.push(
      `    对比度 ${t.ratio}（要 ${t.need}，浅色下 ${l ? l.ratio : "?"}）：「${t.sample}」\n` +
      `      ${t.fg} on ${t.bg}  ${t.cls}`,
    );
  }

  const hits = [...unthemed, ...lowContrast];
  bad += hits.length;
  const note = both.length ? `　（另有 ${both.length} 处两套配色下都不够，不算深色回归）` : "";
  console.log(`${hits.length === 0 ? "✅" : "❌"} ${spec}${hits.length ? `（${hits.length} 处）` : ""}${note}`);
  for (const h of hits) console.log(h);
  if (process.env.AUDIT_SHOW_BOTH && both.length) {
    const seenBoth = new Set();
    for (const t of both) {
      if (seenBoth.has(t.cls)) continue;
      seenBoth.add(t.cls);
      console.log(`    深 ${t.ratio} / 浅 ${t.lightRatio}（要 ${t.need}）：「${t.sample}」 ${t.fg}  ${t.cls}`);
    }
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(bad === 0 ? "\n深色下没有发现问题" : `\n一共 ${bad} 处`);
process.exit(bad === 0 ? 0 : 1);
