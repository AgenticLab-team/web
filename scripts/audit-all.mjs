#!/usr/bin/env node
//
// 把五项浏览器审计一次跑完，只报**新**问题。
//
// ═════════════════════════════════════════
// 为什么要有这一层
// ═════════════════════════════════════════
//
// 五个工具各自都能用，但要用对得记住一堆事：路由清单怎么来、
// 会话 cookie 从哪取、为什么必须用 localhost 而不是 127.0.0.1、
// 哪几处是已知的取舍不用再看。这些我知道，别人不知道，
// 而一个只有作者会用的工具等于没有。
//
//   npm run audit                 # 全部路由，全部五项
//   npm run audit -- --only=mobile,dark
//   npm run audit -- --routes=/forum,/me
//
// 需要一个已经在跑的 dev server（默认 http://localhost:3051）
// 和一个能登录的会话（`AUDIT_COOKIE`，或者 `.audit-session` 文件）。
//
// ─────────────────────────────────────────
// 基线：已知的、不打算改的
// ─────────────────────────────────────────
//
// 密集图标条上，一排 28px 的按钮各要 44 宽 —— 390px 的屏放不下。
// 这些量出来是「高度够了，宽度被邻居挤掉」，WCAG 2.5.8（AA）的线是
// 24×24，它们都过；44 是 AAA 的线。把它们记进基线，
// 这条命令报的就是**新**问题，而不是每次都刷一屏老账。
//
// ⚠️ 往基线里加东西要写清楚**为什么不改**。
// 基线是用来让新问题看得见的，不是用来让旧问题闭嘴的。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.AUDIT_BASE ?? "http://localhost:3051";

/*
 * ⚠️ 必须是 localhost，不能是 127.0.0.1。
 *
 * Next 16 的开发期跨源保护默认只认启动时那个 hostname ——
 * 用 127.0.0.1 访问的话 `/_next/static/chunks/*` 全被 403，
 * 页面**看着完全正常**（服务端渲染的 HTML 照常显示）而客户端一行没跑。
 * 五个工具跑之前都会卡这道闸，但在这里先说一声，省得撞上了再查。
 */
if (BASE.includes("127.0.0.1")) {
  console.error("⚠️  用 localhost，别用 127.0.0.1 —— 后者会被 Next 的开发期跨源保护挡掉 chunk");
  process.exit(1);
}

/** 已知的取舍：`路由 → [出现在报告里的片段, …]` */
const BASELINE = {
  // 编辑器工具条：一排 28px 的图标按钮，彼此挨着，44 宽放不下
  "/forum/new": ["粗体 ⌘B"],
  "/forum/p/*": ["粗体 ⌘B", "「👍」", "「收藏」", "只看楼主"],
  "/forum/p/*/edit": ["粗体 ⌘B"],
  // 后台密集列表里的次要入口（主操作是同一行的复选框，已经是 44）
  // 批量表格的复选框：包了 `<label>` 之后高度已经是 44，
  // 宽度差几像素是因为那个 label 就贴在行的左边缘 —— 再往左没有地方了
  "/admin/posts": ["truncate", "h-5 w-5"],
  "/admin/oauth": ["mt-1 h-5 w-5"],
  "/admin/groups": ["「配置」"],
  "/admin/roles": ["forum.post.create", "h-9 w-9"],
  "/admin/users/*": ["调整积分"],
};

const args = process.argv.slice(2);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const TOOLS = {
  mobile: { script: "mobile-audit.mjs", label: "手机档（横滚 / 点得到点不到）" },
  dark: { script: "dark-audit.mjs", label: "深色（表面 / 对比度）" },
  focus: { script: "focus-audit.mjs", label: "键盘焦点" },
  ax: { script: "ax-audit.mjs", label: "无障碍树" },
  console: { script: "console-audit.mjs", label: "控制台 / 水合" },
};

const only = opt("only")?.split(",").filter((k) => k in TOOLS);
const tools = only?.length ? only : Object.keys(TOOLS);

/** 把 `src/app` 下的静态路由列出来 */
function staticRoutes(dir, prefix = "", out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith("[") || e.name.startsWith("_") || e.name === "api") continue;
    // `(app)` 这种分组不出现在 URL 里
    const seg = e.name.startsWith("(") ? "" : `/${e.name}`;
    const full = join(dir, e.name);
    if (existsSync(join(full, "page.tsx"))) out.push(prefix + seg || "/");
    staticRoutes(full, prefix + seg, out);
  }
  return out;
}

const routes = opt("routes")
  ? opt("routes").split(",")
  : [...new Set(staticRoutes(new URL("../src/app", import.meta.url).pathname))].sort();

const cookieFile = new URL("../.audit-session", import.meta.url).pathname;
const cookie =
  process.env.AUDIT_COOKIE ??
  (existsSync(cookieFile) ? `al_session=${readFileSync(cookieFile, "utf8").trim()}` : "");
if (!cookie) {
  console.error("没有会话：设 AUDIT_COOKIE=al_session=…，或把 token 写进 .audit-session");
  process.exit(1);
}

/** 这一条报告是不是已知的取舍 */
function known(route, line) {
  for (const [pattern, needles] of Object.entries(BASELINE)) {
    const re = new RegExp("^" + pattern.replace(/\*/g, "[^/]+") + "$");
    if (!re.test(route)) continue;
    if (needles.some((n) => line.includes(n))) return true;
  }
  return false;
}

/*
 * 一批跑多少条路由。
 *
 * 太大的话单条命令会撞上超时，而超时的样子是「一个字都没输出」——
 * 那看起来像卡死，实际是**累计**。踩过一次，逐页跑了三轮才明白。
 */
const CHUNK = Number(process.env.AUDIT_CHUNK ?? 20);

let newIssues = 0;
let baselined = 0;

for (const key of tools) {
  const { script, label } = TOOLS[key];
  console.log(`\n━━ ${label}`);
  let route = null;

  for (let i = 0; i < routes.length; i += CHUNK) {
    const batch = routes.slice(i, i + CHUNK);
    let out = "";
    try {
      out = execFileSync("node", [new URL(script, import.meta.url).pathname, BASE, ...batch], {
        encoding: "utf8",
        env: { ...process.env, AUDIT_COOKIE: cookie },
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      // 有问题时这些工具以非零码退出，报告在 stdout 上
      out = (err.stdout ?? "") + (err.stderr ?? "");
    }

    for (const line of out.split("\n")) {
      /*
       * 路由名要在**中文括号**那里断开。
       *
       * 报告行长这样：`❌ /admin/posts（8 处）　（另有 …）`，
       * 而 `\S+` 会把「（8」一起抓走 —— 于是基线里的 `/admin/posts`
       * 一条都对不上，13 处已知取舍全被当成新问题报了出来。
       * 第一次跑就是这个样子：基线里 0 处，屏幕上 13 处。
       */
      const m = line.match(/^[✅❌] (\S+)/);
      if (m) { route = m[1].split("::")[0].split("（")[0]; continue; }
      if (!line.startsWith("    ") || !line.trim()) continue;
      if (line.includes("另有") || line.includes("找不到对照")) continue;
      if (known(route, line)) { baselined++; continue; }
      newIssues++;
      console.log(`  ${route}${line}`);
    }
  }
}

console.log(
  newIssues === 0
    ? `\n✅ ${routes.length} 条路由 × ${tools.length} 项：没有新问题（${baselined} 处在基线里）`
    : `\n❌ ${newIssues} 处新问题（另有 ${baselined} 处在基线里）`,
);
process.exit(newIssues === 0 ? 0 : 1);
