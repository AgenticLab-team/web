import { NextResponse, type NextRequest } from "next/server";

import { isProtectedPath } from "@/lib/auth/routes";

/**
 * 登录门禁。
 *
 * 为什么需要它：页面里的 `redirect("/login")` 在有 loading.tsx 的路由下
 * 会变成**流式响应里的客户端跳转** —— 状态码在重定向确定前就发出去了，
 * 于是 curl 看到的是 200 + 一个空壳，而不是 307。
 * 内容没泄露，但多渲染了一遍外壳，也不利于爬虫与监控判断。
 *
 * 中间件在渲染开始前就拦下，既快又干净。
 *
 * **它只看 cookie 在不在，不做真正的鉴权** ——
 * 会话是否有效、有没有权限，仍然由页面里的 getCurrentUser 与 can() 判定。
 * 把授权判断放进中间件是危险的：middleware 拿不到数据库，
 * 只能靠 cookie 自称，等于让客户端自证身份。
 * 后台页另有 requireAdmin 逐权限点把关，这里拦下只是为了少渲染一次外壳。
 */

const SESSION_COOKIE = "al_session";

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (!isProtectedPath(pathname)) return NextResponse.next();

  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  const login = new URL("/login", request.url);
  /*
   * 登录后回到原来想去的地方，而不是一律扔回首页。
   *
   * **带上查询串**。只存 pathname 的话，`/search?q=台风`、
   * `/me/bookmarks?f=none`、`/forum?board=xx` 登录后回到的都是
   * 一个没有筛选条件的空页面 —— 人得重新填一遍，
   * 而且多半会以为是刚才那一下没生效。
   */
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login, 307);
}

/*
 * matcher 必须与 PROTECTED_PREFIXES 覆盖同一批路径。
 * 它是构建期常量，不能用变量拼 —— 所以只能手写，
 * 由 tests/middleware.test.ts 断言两者不脱节。
 */
export const config = {
  matcher: [
    "/me/:path*",
    "/admin/:path*",
    "/notifications/:path*",
    "/members/:path*",
    "/links/:path*",
    "/radar/:path*",
    "/shop/:path*",
    "/search/:path*",
    "/archive/:path*",
    "/forum/new",
    "/forum/convert",
    "/onboarding",
  ],
};
