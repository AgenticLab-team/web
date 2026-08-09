import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

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
 * 中间件不一样 —— 别顺手把它也禁了
 * ─────────────────────────────────────────
 *
 * `middleware.ts` 跑在 Edge 运行时，`NextRequest.url` 是 Next
 * 按请求头重建出来的公网地址，`new URL("/login", request.url)` 是对的
 * （线上实测跳的是 `https://agenticlab.sh/login`）。
 *
 * 两者长得一模一样而行为不同，所以这条规则**只管 Route Handler**。
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
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

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

describe("中间件是另一回事", () => {
  it("**它可以用 request.url** —— Edge 运行时重建过公网地址", () => {
    /*
     * 写在这里是为了下一个看到上面那条规则的人不会顺手把这里也改了：
     * 改成相对地址在中间件里反而是错的，`NextResponse.redirect` 要绝对地址。
     */
    const mw = strip(readFileSync(join(root, "src/middleware.ts"), "utf8"));
    assert.match(mw, /new URL\("\/login", request\.url\)/);
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
