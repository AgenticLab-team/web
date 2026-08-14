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
import { readFileSync, writeFileSync } from "node:fs";

import { evaluate, launch, setViewport, sleep, waitForHydration } from "./lib/cdp.mjs";

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
 */
const prints = all("--print");
/*
 * 跑一段表达式并打印结果。
 *
 * `--print` 给的是文字，而排查布局要的是**数字** ——
 * 「这一页是不是比视口宽」这种问题看图看不出来（浏览器会把
 * 溢出的部分直接切掉，切得和「本来就这么短」一模一样）。
 */
const evals = all("--eval");
/*
 * 深色模式。站里的配色是浅深两套，而深色那一半一开始从来没被看过。
 * 一个只在深色下才不对的对比度问题，在浅色截图里完全隐形。
 */
const dark = args.includes("--dark");
/*
 * 从文件读一段要跑的 JS。
 *
 * `--eval` 走命令行，而一段稍微长一点的检查经过 shell 的引号、
 * 反斜杠、`!` 之后就不是原来那段了。放文件里就没有这一层。
 */
const evalFiles = all("--eval-file");
const cookies = all("--cookie");

const cdp = await launch({ width, height });

try {
  for (const c of cookies) {
    const [name, ...rest] = c.split("=");
    await cdp.send("Network.setCookie", { name, value: rest.join("="), url, path: "/" });
  }

  // 视口和触摸模拟的那几条坑记在 lib/cdp.mjs 里
  await setViewport(cdp, { width, height });

  /*
   * 减少动效。站里 CSS 里认真处理过它，而 JS 里传的
   * `behavior: "smooth"` **不受那条 CSS 管** —— 要验这件事
   * 就得能真的把这个偏好打开。
   */
  const reduceMotion = args.includes("--reduce-motion");

  const media = [
    ...(dark ? [{ name: "prefers-color-scheme", value: "dark" }] : []),
    ...(reduceMotion ? [{ name: "prefers-reduced-motion", value: "reduce" }] : []),
  ];
  if (media.length) await cdp.send("Emulation.setEmulatedMedia", { features: media });

  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url });
  /*
   * `--hydrated`：等到页面真的水合了就走，不再死等一个固定秒数。
   *
   * 那个固定值原来是 13 秒，纯拍脑袋 —— 而实测同一页在 1.5 秒和 13 秒
   * 量到的元素数、可点数、文字长度**一模一样**。
   * 批量跑的时候这笔账很吓人：深色审计每页要开两次浏览器，
   * 66 条路由就是半小时的纯等待。
   */
  if (args.includes("--hydrated")) await waitForHydration(cdp);
  else await sleep(waitMs);

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
    /*
     * ⚠️ 点完要**说出点中的是谁**。
     *
     * 「点不到就报错」只管有没有匹配，不管匹配对不对 ——
     * 而一个泛选择器（`button[aria-expanded]`）在这个站里
     * 第一个匹配到的是**侧栏的「更多」**，不是信。
     *
     * 我照着那个结果发过一份「信的详情在深色下没问题」的报告，
     * 而实际展开的是侧栏菜单。整条链路每一步都「成功」了：
     * 点到了、展开了、量到了、全绿 —— 只是量的是别的东西。
     *
     * 所以现在把点中元素的类名和文字打出来。选错目标不再是静悄悄的。
     */
    const value = await evaluate(cdp, `(() => {
        const list = [...document.querySelectorAll(${JSON.stringify(sel)})];
        const el = list[${Number(nth ?? 0)}];
        if (!el) return "找不到（一共 " + list.length + " 个）";
        el.click();
        /* 不用 \" 和 \n —— 它们会被外面那层模板字面量吃掉，页面拿到的是坏 JS */
        return "点中 <" + el.tagName.toLowerCase() + "> ." + (el.className || "").toString().slice(0, 40) +
          " ⟨" + (el.innerText || "").split(String.fromCharCode(10)).join("·").trim().slice(0, 30) + "⟩";
      })()`);
    if (!value.startsWith("点中")) throw new Error(`点不到 ${selector}：${value}`);
    console.log(`【点了 ${selector}】 ${value}`);
    await sleep(1200);
  }

  for (const selector of expects) {
    /*
     * 等它出现，而不是立刻判。点击之后要渲染，而渲染要时间；
     * 立刻判的话会误报，然后我会去加 sleep —— 那是猜。
     */
    let ok = false;
    for (let i = 0; i < 25; i++) {
      if (await evaluate(cdp, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)) {
        ok = true;
        break;
      }
      await sleep(400);
    }
    if (!ok) throw new Error(`点完之后没等到 ${selector} —— 多半是 React 还没水合，加大 --wait`);
  }

  for (const selector of prints) {
    const value = await evaluate(cdp, `[...document.querySelectorAll(${JSON.stringify(selector)})]
        .map((e) => e.innerText.trim().slice(0, 300)).join("\\n---\\n") || "（没匹配到）"`);
    console.log(`【${selector}】\n${value}`);
  }

  for (const file of evalFiles) evals.push(readFileSync(file, "utf8"));

  for (const expr of evals) {
    console.log(`【${expr}】 ${JSON.stringify(await evaluate(cdp, expr))}`);
  }

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`截好了 ${out}（点了 ${clicks.length} 下）`);
} finally {
  await cdp.close();
}
