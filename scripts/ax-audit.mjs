#!/usr/bin/env node
//
// 把**读屏看到的那棵树**拿出来查。
//
// ═════════════════════════════════════════
// 为什么静态扫源码不够
// ═════════════════════════════════════════
//
// 仓库里已经有一套 `lib/a11y/audit.ts` 在扫 JSX：有没有 aria-label、
// 有没有裸的 onClick div。那一层拦住了大部分低级错误。
//
// 但它看的是**源码**，而读屏看的是**运行完之后的树**，中间隔着：
//
//   · 名字来自变量 —— `aria-label={label}` 静态看是「有」，
//     而 label 是空字符串时读屏念出来的是「按钮」
//   · 名字来自子元素 —— 一个只包着 `<svg>` 的按钮，源码里干干净净，
//     树上是个没有名字的按钮
//   · 条件渲染 —— 某个分支下标题层级跳了一级，另一个分支没有
//   · 同一页出现两个 main、或者一个都没有
//
//   node scripts/ax-audit.mjs <基址> <路径…>
//
// `AUDIT_COOKIE` 给会话，`AUDIT_SIZE` 换视口。
import { assertHydrated, waitForHydration, launch, setViewport } from "./lib/cdp.mjs";

const [base, ...paths] = process.argv.slice(2);
if (!base || paths.length === 0) {
  console.error("用法：node scripts/ax-audit.mjs <基址> <路径…>");
  process.exit(1);
}

const [width, height] = (process.env.AUDIT_SIZE ?? "1440,1600").split(",").map(Number);

/** 这些角色**必须有名字** —— 读屏念到它们时要说得出「这是什么」 */
const NEEDS_NAME = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "switch",
  "slider",
  "tab",
  "menuitem",
  "image",
]);

/** 拿一个节点在页面里长什么样，用来定位 */
async function describe(cdp, backendNodeId) {
  try {
    const { object } = await cdp.send("DOM.resolveNode", { backendNodeId });
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        /* SVG 的 className 是 SVGAnimatedString，不是字符串 —— 直接 toString 会得到 [object …] */
        const raw = this.className;
        const cls = (typeof raw === "string" ? raw : (raw && raw.baseVal) || "").slice(0, 34);
        const txt = (this.textContent || "").trim().slice(0, 20);
        const html = (this.outerHTML || "").slice(0, 90).split(String.fromCharCode(10)).join(" ");
        return this.tagName.toLowerCase() + (cls ? "." + cls : "") +
          (txt ? " ⟨" + txt + "⟩" : "") + "  " + html;
      }`,
    });
    return result.value;
  } catch {
    return `backendNodeId=${backendNodeId}`;
  }
}

/**
 * 这个节点是不是长在 Next 的开发覆盖层里。
 *
 * `<nextjs-portal>` 是 dev 专有的错误提示 / 指示器，线上根本不存在，
 * 而它里面有个**没有名字的 40×40 logo**，会被稳稳报成一条无障碍问题。
 *
 * 它还藏在影子 DOM 里 —— `document.querySelectorAll` 穿不过去，
 * 所以我第一次照着报告去页面上找那个 svg，找不到。
 * 而无障碍树是穿得过去的：读屏看得见影子里的东西。
 *
 * 往上走时要 `parentNode || host`：影子根的 parentNode 是 null，
 * 只有 host 能跨回宿主那一侧。
 */
async function inDevOverlay(cdp, backendNodeId) {
  try {
    const { object } = await cdp.send("DOM.resolveNode", { backendNodeId });
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        let n = this;
        while (n) {
          if (n.tagName && n.tagName.toLowerCase() === "nextjs-portal") return true;
          n = n.parentNode || n.host;
        }
        return false;
      }`,
    });
    return Boolean(result.value);
  } catch {
    return false;
  }
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
    await cdp.send("Page.enable");
    await cdp.send("Accessibility.enable");
    await cdp.send("Page.navigate", { url });
    await waitForHydration(cdp);

    await assertHydrated(cdp, path);

    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    if (!nodes || nodes.length < 20) {
      throw new Error(`${path} 的无障碍树只有 ${nodes?.length ?? 0} 个节点 —— 抓到的不像是真页面`);
    }

    const lines = [];
    const seen = new Set();

    /*
     * ① 该有名字而没有名字的。
     *
     * `ignored` 的跳过 —— 那是读屏根本不会念到的节点
     * （aria-hidden、display:none、纯装饰）。把它们算进来的话，
     * 每个图标 `<svg>` 都会被报一遍，而它们**本来就该**没名字。
     */
    for (const n of nodes) {
      if (n.ignored) continue;
      const role = n.role?.value;
      if (!NEEDS_NAME.has(role)) continue;
      const name = (n.name?.value ?? "").trim();
      if (name) continue;
      const key = role + ":" + n.backendDOMNodeId;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({ kind: "noname", role, backendNodeId: n.backendDOMNodeId });
    }

    /*
     * ② 地标。
     *
     * 一个页面要有且只有一个 main —— 读屏用户靠它一键跳到正文。
     * 没有的话他只能从头 Tab；有两个的话「跳到正文」变成一次猜。
     */
    const mains = nodes.filter((n) => !n.ignored && n.role?.value === "main");
    if (mains.length !== 1) {
      lines.push({ kind: "main", count: mains.length });
    }

    /*
     * ③ 标题层级不能跳。
     *
     * 读屏用户是按标题层级在页面里导航的（「下一个二级标题」）。
     * 从 h1 直接跳到 h3，中间那一级的缺口在视觉上完全看不出来 ——
     * 而对他来说，那是一段结构上凭空消失的内容。
     *
     * 只报**往下跳超过一级**的；往上跳（h3 回到 h2）是正常的章节切换。
     */
    let prev = 0;
    for (const n of nodes) {
      if (n.ignored || n.role?.value !== "heading") continue;
      const lv = Number(n.properties?.find((p) => p.name === "level")?.value?.value ?? 0);
      if (!lv) continue;
      if (prev && lv > prev + 1) {
        lines.push({
          kind: "heading",
          from: prev,
          to: lv,
          name: (n.name?.value ?? "").trim().slice(0, 22),
        });
      }
      prev = lv;
    }

    const out = [];
    for (const l of lines) {
      if (l.kind === "noname") {
        if (await inDevOverlay(cdp, l.backendNodeId)) continue;   // dev 覆盖层，线上没有
        out.push(`    没有名字的 ${l.role}：${await describe(cdp, l.backendNodeId)}`);
      } else if (l.kind === "main") {
        out.push(`    这一页有 ${l.count} 个 main 地标（要正好 1 个）`);
      } else {
        out.push(`    标题从 h${l.from} 跳到 h${l.to}：「${l.name}」`);
      }
    }

    problems += out.length;
    console.log(`${out.length === 0 ? "✅" : "❌"} ${path}${out.length ? `（${out.length} 处）` : ""}`);
    for (const o of out.slice(0, 12)) console.log(o);
    if (out.length > 12) console.log(`    …另有 ${out.length - 12} 处`);
  } finally {
    await cdp.close();
  }
}

console.log(problems === 0 ? "\n读屏那棵树上：每个控件都有名字，地标和标题层级也对" : `\n一共 ${problems} 处`);
process.exit(problems === 0 ? 0 : 1);
