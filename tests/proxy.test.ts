import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  CONDITIONAL_PREFIXES,
  MATCHER_EXTRAS,
  PROTECTED_PREFIXES,
  isProtectedPath,
  safeRedirect,
} from "@/lib/auth/routes";
import { NAV } from "@/lib/nav";
import { stripComments } from "./_source";

/**
 * 登录门禁与回跳地址的安全性。
 *
 * 回跳参数是最经典的开放重定向入口：允许绝对地址的话，
 * 攻击者可以拿一个看起来正常的登录链接把人导到钓鱼站。
 *
 * 这个文件以前抄了一份 isProtected / safeRedirect 在测试里，
 * 结果门禁漏掉 /admin 的时候测试照样全绿 —— 测的是抄件。
 * 现在两边引的是同一个 routes.ts。
 *
 * ─────────────────────────────────────────
 * middleware 改名成了 proxy
 * ─────────────────────────────────────────
 *
 * Next 16 废弃了 `middleware.ts`，改名 `proxy.ts`，导出的函数
 * 也从 `middleware` 改成 `proxy`，运行时固定为 nodejs。
 * 这里连文件名一起改了 —— 留着旧名字的测试会在下次有人
 * 搜索 middleware 时把他领到一个不存在的东西上。
 */

describe("回跳地址", () => {
  it("站内路径原样保留", () => {
    assert.equal(safeRedirect("/me/points"), "/me/points");
    assert.equal(safeRedirect("/forum/new"), "/forum/new");
  });

  it("**绝对地址一律拒绝**", () => {
    assert.equal(safeRedirect("https://evil.com"), "/");
    assert.equal(safeRedirect("http://evil.com"), "/");
  });

  it("协议相对地址也要拒绝", () => {
    // //evil.com 在浏览器里等价于 https://evil.com，最容易漏掉的一种
    assert.equal(safeRedirect("//evil.com"), "/");
    assert.equal(safeRedirect("//evil.com/path"), "/");
  });

  it("**反斜杠写法也是协议相对地址** —— 只挡 // 会漏掉它", () => {
    /*
     * 按 URL 规范，反斜杠在这个位置等同于斜杠：
     * 浏览器把 /\evil.com 解析成 https://evil.com。
     */
    assert.equal(safeRedirect("/\\evil.com"), "/");
    assert.equal(safeRedirect("/\\evil.com/path"), "/");
  });

  it("**查询串要留着** —— 丢掉的话登录后回到一个没有筛选条件的空页面", () => {
    assert.equal(safeRedirect("/search?q=台风"), "/search?q=台风");
    assert.equal(safeRedirect("/me/bookmarks?f=none"), "/me/bookmarks?f=none");
  });

  it("门禁把查询串一起放进 next", () => {
    const src = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");
    assert.match(src, /const \{ pathname, search \} = request\.nextUrl;/);
    assert.match(src, /set\("next", `\$\{pathname\}\$\{search\}`\)/);
  });

  it("空值退回首页", () => {
    assert.equal(safeRedirect(undefined), "/");
    assert.equal(safeRedirect(""), "/");
    assert.equal(safeRedirect(null), "/");
  });
});

describe("受保护路径匹配", () => {
  it("精确匹配与子路径都拦", () => {
    assert.equal(isProtectedPath("/me"), true);
    assert.equal(isProtectedPath("/me/points"), true);
    assert.equal(isProtectedPath("/notifications"), true);
    assert.equal(isProtectedPath("/forum/new"), true);
  });

  it("**后台整个树都要拦**", () => {
    // 漏了这条的时候，未登录访客拿到的是 200 空壳而不是跳转 ——
    // 内容没泄露，但状态码骗人，监控和爬虫都会当成正常页面
    assert.equal(isProtectedPath("/admin"), true);
    assert.equal(isProtectedPath("/admin/users"), true);
    assert.equal(isProtectedPath("/admin/users/u_123"), true);
    assert.equal(isProtectedPath("/admin/roles"), true);
    assert.equal(isProtectedPath("/admin/audit"), true);
  });

  it("公开路径不拦", () => {
    assert.equal(isProtectedPath("/"), false);
    assert.equal(isProtectedPath("/forum"), false);
    assert.equal(isProtectedPath("/leaderboard"), false, "总榜对未登录访客公开");
    assert.equal(isProtectedPath("/login"), false);
  });

  it("**前缀相同但不是子路径的不能误拦**", () => {
    // /messages 不该因为以 /me 开头就被当成 /me 的子路径
    assert.equal(isProtectedPath("/messages"), false);
    assert.equal(isProtectedPath("/forum/newest"), false);
    assert.equal(isProtectedPath("/administration"), false);
    assert.equal(isProtectedPath("/shopping"), false);
    assert.equal(isProtectedPath("/searchers"), false);
  });
});

describe("matcher 与前缀表不能脱节", () => {
  /*
   * config.matcher 是构建期常量，不能用变量拼出来，
   * 所以只能手写一份。手写的东西一定会和前缀表跑偏 ——
   * 跑偏的后果是中间件根本不被调用，isProtectedPath 写得再对也没用。
   */
  const source = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");

  /*
   * ─────────────────────────────────────────
   * 只读 `matcher: [...]` 那个数组，不是扫全文
   * ─────────────────────────────────────────
   *
   * 原来这里用一个正则把**整个文件**里所有 `"/..."` 都当成 matcher 条目，
   * 然后特判掉 `/login`（那是函数体里跳转用的地址）。
   *
   * 那个写法的问题不是不准，是**它会随着 proxy 里多一条路径而误报**：
   * 加了「按 UA 改写去 /install.sh」之后，那个地址就被当成了
   * 一条没有理由的 matcher 条目。而人的第一反应是去 matcher 里
   * 删一条不存在的东西。
   *
   * 现在只截 `matcher: [` 到对应的 `]` 之间那一段。
   */
  /*
   * 先剥注释：数组里的注释在解释「为什么写成 / 而不是 /:path*」，
   * 而那句话里那两个带引号的路径会被当成两条真的 matcher 条目。
   * 这个仓库在别处已经踩过同一个坑（见 tests/_source.ts）。
   */
  const block = stripComments(source.slice(source.indexOf("matcher: [")));
  const matcher = [...block.slice(0, block.indexOf("],")).matchAll(/"(\/[^"]*)"/g)].map(
    (m) => m[1],
  );

  it("每个受保护前缀都在 matcher 里", () => {
    for (const prefix of PROTECTED_PREFIXES) {
      /*
       * 「被覆盖」有三种：写死这一条、写了它的 `/:path*`、
       * 或者被一条更宽的通配覆盖（`/forum/:path*` 罩住 `/forum/new`）。
       *
       * 只认前两种的话，把两条窄的合并成一条宽的就会报假警 ——
       * 而报假警的测试很快就没人看了。
       */
      const covered = matcher.some(
        (m) =>
          m === prefix ||
          m === `${prefix}/:path*` ||
          (m.endsWith("/:path*") && prefix.startsWith(`${m.slice(0, -"/:path*".length)}/`)),
      );
      assert.ok(covered, `${prefix} 不在 proxy 的 matcher 里，门禁根本不会被调用`);
    }
  });

  it("**有条件保护的前缀也要在 matcher 里**", () => {
    /*
     * 论坛平时是公开的，只有管理员把「允许未登录浏览」关掉时才拦。
     * 但 matcher 是构建期常量 —— 它不知道开关拨到哪边，
     * 所以必须**永远**覆盖，由 proxy 里的判定决定放不放行。
     *
     * 漏掉这条的后果最阴：开关拨过去了，管理员以为关上了，
     * 而门禁压根没被调用。
     */
    for (const { prefix } of CONDITIONAL_PREFIXES) {
      const covered = matcher.some((m) => m === prefix || m === `${prefix}/:path*`);
      assert.ok(covered, `${prefix} 是有条件保护的，matcher 必须永远覆盖它`);
    }
  });

  it("matcher 里没有多余的路径", () => {
    /*
     * matcher 每多覆盖一条无关路径，就多一次「某个请求经过了
     * 登录判定但判错了」的机会。所以这里要求每一条都说得出理由。
     *
     * 理由有三种，第三种是**逐条列名**的（`MATCHER_EXTRAS`）——
     * 把这条守卫改成「允许有例外」等于把它废掉。
     */
    const known = [
      ...PROTECTED_PREFIXES,
      ...CONDITIONAL_PREFIXES.map((c) => c.prefix),
    ] as readonly string[];
    const extras = new Set<string>(MATCHER_EXTRAS.map((e) => e.path));
    for (const entry of matcher) {
      const prefix = entry.replace("/:path*", "");
      assert.ok(
        extras.has(entry) || known.includes(prefix) || known.some((k) => prefix.startsWith(`${k}/`)),
        `matcher 里的 ${entry} 既不在受保护前缀表里、不在有条件保护表里，也不在 MATCHER_EXTRAS 里`,
      );
    }
  });

  it("**MATCHER_EXTRAS 里的每一条都真的在 matcher 里，而且写了理由**", () => {
    /*
     * 反方向：这张表是「例外」，而一条没有对应 matcher 条目的例外
     * 只会让下一个人以为某个路径被覆盖着，其实没有。
     */
    for (const e of MATCHER_EXTRAS) {
      assert.ok(matcher.includes(e.path), `MATCHER_EXTRAS 里的 ${e.path} 不在 matcher 里`);
      assert.ok(e.why.length > 10, `${e.path} 没说清楚为什么要进 matcher`);
    }
  });

  it("**有条件的那张表上写清楚了归哪个开关管**", () => {
    // 没写的话，下一个人只会看到一个「有时候拦有时候不拦」的路径
    for (const c of CONDITIONAL_PREFIXES) {
      assert.match(c.setting, /^[a-z0-9_.]+$/);
      assert.ok(c.why.length > 4, `${c.prefix} 没说为什么是有条件的`);
    }
  });
});

describe("**proxy 的形状**", () => {
  const source = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");

  it("导出的是 proxy，不是 middleware", () => {
    assert.match(source, /export function proxy\(/);
    assert.equal(/export function middleware\(/.test(source), false);
  });

  it("仓库里没有残留的 middleware.ts", () => {
    /*
     * 两个文件同时存在的话，Next 只认一个，而另一个看起来还在管事 ——
     * 改错那一个的人不会得到任何提示。
     */
    let exists = true;
    try {
      readFileSync(new URL("../src/middleware.ts", import.meta.url));
    } catch {
      exists = false;
    }
    assert.equal(exists, false, "src/middleware.ts 还在，Next 16 已经不认它了");
  });

  it("**登录判定仍然只看 cookie 在不在** —— 鉴权不在这一层", () => {
    /*
     * proxy 现在跑 nodejs，查得了库 —— 正因为查得了，这条要写死：
     * 光凭 cookie 自称就当成「这个人是谁」等于让客户端自证身份。
     * 会话有效性和权限仍然由页面里的 getCurrentUser / can() 判定。
     *
     * 读**站点配置**是另一回事：那是管理员拨的开关，不是「你是谁」。
     */
    // 注释里提到这些名字是**在解释为什么不用它们**，先去掉注释再断言
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    assert.equal(code.includes("getCurrentUser"), false);
    assert.equal(code.includes('can("'), false);
    assert.match(code, /cookies\.has\(SESSION_COOKIE\)/);
  });
});

const ALL_NAV_ITEMS = NAV.flatMap((s) => s.items);

describe("导航与门禁不能各说各的", () => {
  it("**导航里标了 requiresAuth 的入口，中间件必须也拦**", () => {
    /*
     * 两处分开维护的结果是：导航把入口藏起来了，而路径本身没保护。
     * 访客直接敲地址会拿到一个 200 的空壳 —— 主体没渲染，
     * 但标题、加载过程都发生过一遍，然后才被客户端弹走。
     * /admin 当初就是这个样子，而当时的测试是全绿的。
     */
    for (const item of ALL_NAV_ITEMS) {
      if (!item.requiresAuth || !item.ready) continue;
      assert.ok(
        isProtectedPath(item.href),
        `${item.href} 在导航里要求登录，但不在 PROTECTED_PREFIXES 里`,
      );
    }
  });

  it("反过来也查：拦下来的路径不该在导航里对访客可见", () => {
    for (const item of ALL_NAV_ITEMS) {
      if (!isProtectedPath(item.href) || !item.ready) continue;
      assert.ok(
        item.requiresAuth || item.permission,
        `${item.href} 被中间件拦着，但导航对访客也显示它 —— 点进去只会撞登录页`,
      );
    }
  });
});
