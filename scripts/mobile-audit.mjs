#!/usr/bin/env node
//
// 手机档体检：**页面有没有横着溢出**、**点得到点不到**。
//
// ═════════════════════════════════════════
// 为什么这两件事看截图看不出来
// ═════════════════════════════════════════
//
// 横向溢出：浏览器会把溢出的部分**直接切掉**，切得和「本来就这么短」
// 一模一样。截图上是一段看起来正常结束的文字，而真机上它右边还有半句
// 要横着拖才看得见。
//
// 点击目标：44×44 这个数是拇指的物理尺寸，而屏幕上 30px 的按钮
// 看起来一点问题都没有 —— 它只是**点不中**。眼睛量不出这个。
//
//   node scripts/mobile-audit.mjs <基址> <路径…>
//
// `AUDIT_COOKIE` 给会话，`AUDIT_SIZE` 换视口（默认 390,1600）。
import { readFileSync } from "node:fs";

import { evaluate, launch, setViewport, sleep } from "./lib/cdp.mjs";

const [base, ...paths] = process.argv.slice(2);
if (!base || paths.length === 0) {
  console.error("用法：node scripts/mobile-audit.mjs <基址> <路径…>");
  process.exit(1);
}

const [width, height] = (process.env.AUDIT_SIZE ?? "390,1600").split(",").map(Number);
/** 拇指够得着的最小尺寸。Apple HIG 和 WCAG 2.5.5 都是 44 */
const MIN_TAP = Number(process.env.AUDIT_MIN_TAP ?? 44);

/*
 * 探针住在真文件里，不住在模板字面量里。
 *
 * 它本来是这个文件里的一段反引号字符串，而我在里面写注释时
 * **连着两次**被反引号截断 —— 注释里提一句 .tap-target，
 * 探针的 JS 就从那儿断掉，报错还落在 Node 检查语法那一层。
 * 搬出去之后 `node --check` 和 eslint 都管得着它。
 */
const probeJs = readFileSync(new URL("./lib/probe-mobile.js", import.meta.url), "utf8")
  .replaceAll("__MIN_TAP__", String(MIN_TAP));

let problems = 0;
for (const path of paths) {
  const url = base.replace(/\/$/, "") + path;
  const cdp = await launch({ width, height });
  try {
    await setViewport(cdp, { width, height });
    if (process.env.AUDIT_COOKIE) {
      const [name, ...rest] = process.env.AUDIT_COOKIE.split("=");
      await cdp.send("Network.setCookie", { name, value: rest.join("="), url, path: "/" });
    }
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url });
    await sleep(13_000);

    const r = await evaluate(cdp, probeJs);
    if (!r || r.total < 15) {
      throw new Error(`${path} 只量到 ${r?.total ?? 0} 个元素 —— 抓到的不像是真页面`);
    }

    const lines = [];
    if (r.scrollW > r.docW + 1) {
      lines.push(`    整页横着能滚：scrollWidth ${r.scrollW} > 视口 ${r.docW}`);
    }
    for (const o of r.overflow) {
      lines.push(`    右边越界 ${o.right} > ${o.docW}：「${o.label}」 ${o.cls}`);
    }
    for (const t of r.small) {
      lines.push(
        `    命中区 ${t.ew}×${t.eh}（要 ${MIN_TAP}，元素本身 ${t.w}×${t.h}）：<${t.tag}>「${t.label}」 ${t.cls}`,
      );
    }

    problems += lines.length;
    console.log(`${lines.length === 0 ? "✅" : "❌"} ${path}${lines.length ? `（${lines.length} 处）` : ""}`);
    for (const l of lines.slice(0, 14)) console.log(l);
    if (lines.length > 14) console.log(`    …另有 ${lines.length - 14} 处`);
  } finally {
    await cdp.close();
  }
}

console.log(problems === 0 ? "\n手机档：不横滚，点得到" : `\n一共 ${problems} 处`);
process.exit(problems === 0 ? 0 : 1);
