import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stripComments as strip } from "./_source";

/**
 * 「这台机器以为自己叫什么」。
 *
 * ─────────────────────────────────────────
 * Route Handler 里的 request.url 是内网地址
 * ─────────────────────────────────────────
 *
 * 站点在 nginx 后面，Node 收到的请求行写的是 `http://localhost:3000/...`。
 * 在一个 Route Handler 里 `new URL("/somewhere", request.url)` 拼出来的
 * 就是 `https://localhost:3000/somewhere` —— 也就是**把访客送回他自己的机器**。
 *
 * 这是短链上线之后当场撞见的：`/p/<code>` 在本地怎么点都对，
 * 部署到线上第一次点就跳去了 localhost。本地测不出来，
 * 因为本地它恰好就是对的。
 *
 * ─────────────────────────────────────────
 * 门禁那一层曾经是例外，现在不是了
 * ─────────────────────────────────────────
 *
 * 旧的 `middleware.ts` 跑在 Edge 运行时，`NextRequest.url` 是 Next
 * 按请求头重建出来的公网地址，同样的写法在那儿**是对的**
 * （线上实测跳的是正确域名）。
 *
 * Next 16 把它改名成 `proxy.ts`，**运行时固定成了 nodejs** ——
 * 那条豁免随之失效：同一行代码，换个运行时就开始把人送去 localhost。
 *
 * 所以现在规则是一条，没有例外：**谁都不许拿 request.url 拼绝对地址**。
 *
 * ─────────────────────────────────────────
 * 但「该用什么代替」两层不一样
 * ─────────────────────────────────────────
 *
 *   · **Route Handler** → 相对 Location。`Response.redirect` 只收
 *     绝对地址，所以要手写 `new Response(null, { headers: { Location } })`。
 *   · **proxy** → 绝对地址，来自 `env.site.url`。这一层的 Location
 *     会被 Next 自己 `new URL()` 一遍，给相对地址会 `ERR_INVALID_URL`，
 *     整条 matcher 覆盖的路径一起 500。
 *
 * 同一个词在两层里含义相反，所以两处各写了一遍原因。
 *
 * ─────────────────────────────────────────
 * 那该用什么
 * ─────────────────────────────────────────
 *
 *   · 跳到站内 → 直接写相对地址：`{ Location: "/forum/p/x" }`。
 *     浏览器按它实际访问的地址解析，这台机器不需要知道自己叫什么。
 *   · 非要绝对地址不可（OAuth 的 redirect_uri、邮件里的链接、
 *     OG 图、Webhook 回调）→ 用 `env.site.url`，那是配出来的、
 *     唯一一个说了算的答案。
 *
 * 读 `new URL(request.url).searchParams` 不在此列 ——
 * 路径和查询串本来就是对的，错的只有 host。
 */

const root = new URL("..", import.meta.url).pathname;

function routeHandlers(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) routeHandlers(full, out);
    else if (e.name === "route.ts" || e.name === "route.tsx") out.push(full);
  }
  return out;
}

const files = routeHandlers(join(root, "src/app"));

describe("**Route Handler 不拿 request.url 拼绝对地址**", () => {
  it("确实扫到了东西 —— 否则这条测试是在空转", () => {
    assert.ok(files.length > 5, `只找到 ${files.length} 个 route.ts`);
  });

  for (const file of files) {
    const rel = file.slice(root.length);
    it(rel, () => {
      const body = strip(readFileSync(file, "utf8"));

      /*
       * 只揪「用它当 base 去拼一个新地址」这一种写法。
       * `new URL(request.url).searchParams` 是读查询串，那个是对的。
       */
      const asBase = /new URL\(\s*[^)]*?,\s*(?:request|req)\.url\s*\)/.test(body);
      assert.equal(
        asBase,
        false,
        `拿 request.url 当 base 拼地址了 —— 线上它是 http://localhost:3000，` +
          `跳出去的链接会把人送回他自己的机器。跳站内写相对地址，` +
          `非要绝对地址就用 env.site.url`,
      );

      // `Response.redirect` 只收绝对地址，出现在这里基本就是上面那个错
      assert.equal(
        /Response\.redirect\(\s*new URL\([^)]*(?:request|req)\.url/.test(body),
        false,
        `Response.redirect 只收绝对地址，而这里的绝对地址是内网的`,
      );
    });
  }
});

describe("**门禁那一层也一样**", () => {
  const proxy = strip(readFileSync(join(root, "src/proxy.ts"), "utf8"));

  it("不拿 request.url 拼登录地址", () => {
    /*
     * 这一条是改名改出来的：edge 时代它是对的，换成 nodejs 就错了。
     * 同一行代码，换个运行时就开始把人送去 localhost。
     */
    assert.equal(proxy.includes("request.url"), false);
  });

  it("**用 env.site.url，不是相对地址** —— 这一层和 Route Handler 正相反", () => {
    /*
     * proxy 这一层的 Location 会被 Next 自己 `new URL()` 一遍，
     * 相对地址直接 `ERR_INVALID_URL`，整条 matcher 覆盖的路径
     * 全部 500 —— 登录、后台、论坛一起挂。本地构建跑起来才发现的。
     *
     * 所以两条限制方向相反：不能相对、也不能来自 request.url，
     * 同时满足的只有配出来的那个域名。
     */
    assert.match(proxy, /new URL\("\/login", env\.site\.url\)/);
  });
});

describe("要绝对地址的地方用 env.site.url", () => {
  it("GitHub 的 redirect_uri 不跟着请求走", () => {
    /*
     * OAuth 的 redirect_uri 必须跟注册在 GitHub 那边的完全一致。
     * 跟着请求走的话，换一个入口进来就对不上，而报错信息只会说
     * 「redirect_uri 不匹配」，看不出是这儿的问题。
     */
    const start = strip(readFileSync(join(root, "src/app/api/auth/github/start/route.ts"), "utf8"));
    assert.match(start, /callbackUrl\(env\.site\.url\)/);
  });

  it("回调跳回来也用它", () => {
    const cb = strip(
      readFileSync(join(root, "src/app/api/auth/github/callback/route.ts"), "utf8"),
    );
    assert.match(cb, /new URL\(returnTo, env\.site\.url\)/);
  });
});
