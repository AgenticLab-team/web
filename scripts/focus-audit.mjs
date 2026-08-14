#!/usr/bin/env node
//
// 用 Tab 走一遍，看**每一步停在哪儿看不看得出来**。
//
// ═════════════════════════════════════════
// 为什么必须发真的按键，不能 `el.focus()`
// ═════════════════════════════════════════
//
// 现在的焦点圈几乎都挂在 `:focus-visible` 上 —— 而按规范，
// **程序性的 `focus()` 不算键盘操作**，那条规则不生效。
//
// 也就是说：用 `el.focus()` 去查焦点圈，会得到一份「全站都没有焦点圈」
// 的报告，而真相是浏览器根本没进入键盘模式。
// 那种假阳性最费时间 —— 它看起来像个大发现。
//
// 所以这里走 `Input.dispatchKeyEvent`，发真的 Tab。
//
// ─────────────────────────────────────────
// 查两件事
// ─────────────────────────────────────────
//
//   ① 焦点落上去之后，**样式一点都没变** —— 那就是看不见自己在哪
//   ② 焦点落到了一个**量不出尺寸**的元素上 —— 键盘走到了看不见的地方
//
//   node scripts/focus-audit.mjs <基址> <路径…>
//
// `AUDIT_COOKIE` 给会话，`AUDIT_DARK=1` 查深色，`AUDIT_SIZE=390,1600` 查手机档。
import { assertHydrated, evaluate, launch, setViewport, sleep } from "./lib/cdp.mjs";

const [base, ...paths] = process.argv.slice(2);
if (!base || paths.length === 0) {
  console.error("用法：node scripts/focus-audit.mjs <基址> <路径…>");
  process.exit(1);
}

const [width, height] = (process.env.AUDIT_SIZE ?? "1440,1600").split(",").map(Number);
const dark = Boolean(process.env.AUDIT_DARK);
const MAX_TABS = Number(process.env.AUDIT_TABS ?? 60);

/*
 * 焦点圈可能长在哪几个属性上。
 *
 * ⚠️ **`outlineOffset` 不在里面，而它差点毁掉整个判据。**
 *
 * 第一版把它算进「变了就是有反馈」，然后变异测试没抓到那个
 * `style={{ outline: "none" }}` 的按钮 —— 因为站里的
 * `:focus-visible` 同时设了 `outline-offset: 2px`，
 * 那一条**没有被行内的 `outline: none` 盖掉**（它不在 outline 简写里）。
 * 于是：圈根本没画，偏移量却变了，判据说「有反馈」。
 *
 * 偏移量自己是看不见的东西。它只在有圈的时候才有意义。
 */
const MARKS = ["boxShadow", "backgroundColor", "borderColor", "color"];
/** outline 要单独判**有没有真的画出来**，而不是判「变没变」 */
const OUTLINE = ["outlineStyle", "outlineWidth", "outlineColor"];

const baselineJs = `(() => {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const sel = 'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])';
  const out = [];
  document.querySelectorAll(sel).forEach((el, i) => {
    el.setAttribute("data-fa", String(i));
    const s = getComputedStyle(el);
    out.push({${[...MARKS, ...OUTLINE].map((m) => `${m}: s.${m}`).join(", ")}});
  });
  return out;
})()`;

/*
 * `<nextjs-portal>` 要跳过 —— 那是 Next **开发期**的错误覆盖层，
 * 线上根本不存在。它可聚焦、又量不出尺寸，于是每一页都会被报一条。
 *
 * 这一条是页面**真的水合之后**才冒出来的：在没水合的页面上
 * 那个覆盖层还没挂载，于是它一直藏着。
 */
const DEV_ONLY = "nextjs-portal";

const focusedJs = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  if (el.tagName.toLowerCase() === "${DEV_ONLY}" || el.closest("${DEV_ONLY}")) return null;
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    i: el.getAttribute("data-fa"),
    tag: el.tagName,
    cls: (el.className || "").toString().slice(0, 40),
    label: ((el.innerText || el.getAttribute("aria-label") || el.value || "") + "").trim().slice(0, 24),
    w: Math.round(r.width), h: Math.round(r.height),
    ${[...MARKS, ...OUTLINE].map((m) => `${m}: s.${m}`).join(", ")}
  };
})()`;

async function tab(cdp) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    });
  }
  await sleep(60);
}

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
    if (dark) {
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: "dark" }],
      });
    }
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url });
    await sleep(13_000);

    await assertHydrated(cdp, path);

    const baseline = await evaluate(cdp, baselineJs);
    if (!baseline || baseline.length < 3) {
      throw new Error(`${path} 上只找到 ${baseline?.length ?? 0} 个可聚焦元素 —— 抓到的不像是真页面`);
    }

    const noRing = [];
    const invisible = [];
    const seen = new Set();
    let landed = 0;

    for (let n = 0; n < MAX_TABS; n++) {
      await tab(cdp);
      const cur = await evaluate(cdp, focusedJs);
      if (!cur) continue;                       // 焦点还在 body 上，继续走
      const key = cur.i ?? `${cur.tag}.${cur.cls}`;
      if (seen.has(key)) break;                 // 转回来了，走完一圈
      seen.add(key);
      landed++;

      if (cur.w === 0 || cur.h === 0) {
        invisible.push(`    量不出尺寸：<${cur.tag.toLowerCase()}> 「${cur.label}」 ${cur.cls}`);
        continue;
      }

      /*
       * 两条合起来才算「看得见」：outline **画出来了**，
       * 或者别的属性相对没聚焦时**变了**。
       *
       * 只认 outline 会把用 box-shadow 描边、用换底色做反馈的
       * 全报成 bug；而只判「变没变」会被 outline-offset 这种
       * 看不见的属性骗过去（上面那条注释记着怎么骗的）。
       */
      const b = cur.i === null ? null : baseline[Number(cur.i)];
      if (!b) continue;                         // 加载后才出现的元素，没有基线可比

      /* outline 判**画没画出来**：三样缺一样就等于没有圈 */
      const drawn =
        cur.outlineStyle !== "none" &&
        parseFloat(cur.outlineWidth) > 0 &&
        !/rgba\(.*,\s*0\)/.test(cur.outlineColor);
      const changed = MARKS.some((m) => b[m] !== cur[m]);
      if (!drawn && !changed) {
        noRing.push(`    聚焦后一点没变：<${cur.tag.toLowerCase()}> 「${cur.label}」 ${cur.cls}`);
      }
    }

    const hits = [...noRing, ...invisible];
    problems += hits.length;
    console.log(
      `${hits.length === 0 ? "✅" : "❌"} ${path}（走了 ${landed} 站${hits.length ? `，${hits.length} 处` : ""}）`,
    );
    for (const h of hits.slice(0, 12)) console.log(h);
    if (hits.length > 12) console.log(`    …另有 ${hits.length - 12} 处`);
  } finally {
    await cdp.close();
  }
}

console.log(problems === 0 ? "\n键盘走一圈，每一站都看得出自己在哪" : `\n一共 ${problems} 处`);
process.exit(problems === 0 ? 0 : 1);
