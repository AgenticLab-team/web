import { NextResponse, type NextRequest } from "next/server";

import { isProtectedPath } from "@/lib/auth/routes";
import { env } from "@/lib/env";
import { forumOpenToGuests } from "@/lib/forum/public-access";

/**
 * 登录门禁。
 *
 * ─────────────────────────────────────────
 * 从 middleware 改名成 proxy
 * ─────────────────────────────────────────
 *
 * Next 16 把 `middleware.ts` 废弃、改名为 `proxy.ts`，导出的函数
 * 也从 `middleware` 改成 `proxy`。**顺带换掉的还有运行时**：
 * proxy 固定跑 nodejs，不再是 edge，而且不可配置。
 *
 * 这个改名不只是改名 —— 它把「拿不到数据库」这条限制去掉了，
 * 下面那道论坛的门正是靠它才能做成真正的 HTTP 跳转。
 *
 * ─────────────────────────────────────────
 * 为什么门要开在这里，而不是页面里
 * ─────────────────────────────────────────
 *
 * 页面或 layout 里的 `redirect("/login")`，在有 loading.tsx 的路由下
 * 会变成**流式响应里的客户端跳转** —— 状态码在重定向确定之前
 * 就已经发出去了。
 *
 * 这不是推测：论坛那道门第一版就写在 layout 里，线上实测
 * 访客拿到的是 `200` + 一个空壳，跳转指令躺在 HTML 流里等客户端执行。
 * **浏览器会跳，`curl`、爬虫、微信的预览抓取不会。**
 * 内容没泄露（页面主体确实没渲染），但地址栏、标题、加载过程
 * 全都发生过一遍，监控和爬虫看到的也是 200。
 *
 * proxy 在渲染开始前就拦下，出来的是干净的 307。
 *
 * ─────────────────────────────────────────
 * 它仍然不做鉴权
 * ─────────────────────────────────────────
 *
 * 登录判定这里**只看 cookie 在不在**。会话是否有效、有没有权限，
 * 仍然由页面里的 `getCurrentUser` 与 `can()` 说了算 ——
 * 光凭 cookie 自称就放行等于让客户端自证身份。
 * 这一层拦下只是为了少渲染一次外壳。
 *
 * 论坛那道门是另一回事：它读的是**站点配置**（管理员拨的开关），
 * 不是「你是谁」。配置可以在这里读，身份不行。
 */

const SESSION_COOKIE = "al_session";

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const loggedIn = request.cookies.has(SESSION_COOKIE);

  if (loggedIn) return NextResponse.next();

  const needsLogin =
    isProtectedPath(pathname) ||
    // 论坛：关掉「允许未登录浏览」之后，访客连门都进不来
    ((pathname === "/forum" || pathname.startsWith("/forum/")) && !forumOpenToGuests());

  if (!needsLogin) return NextResponse.next();

  /*
   * ─────────────────────────────────────────
   * 这一层的跳转地址必须是**绝对**的，而且不能来自 request.url
   * ─────────────────────────────────────────
   *
   * 两条限制，方向正好相反，缺一条就是线上事故：
   *
   * **① 不能用相对地址。** proxy 这一层的 Location 会被 Next 自己
   * `new URL()` 一遍，相对地址直接 `ERR_INVALID_URL`，
   * 整条 matcher 覆盖的路径全部 500 —— 也就是登录、后台、论坛一起挂。
   * （Route Handler 那边恰恰相反，那里相对地址才是对的。
   * 同一个词在两层里含义不同，所以两处各写了一遍原因。）
   *
   * **② 不能用 `request.url` 拼。** 以前这里写的是
   * `new URL("/login", request.url)` —— 那时候 middleware 跑 edge，
   * Next 会按请求头重建公网地址，拼出来是对的。
   * 改成 proxy 之后运行时变成 nodejs，`request.url` 成了 nginx
   * 转进来的内网地址，拼出来是 `https://localhost:3000/login`：
   * **每一个未登录访客都被送回他自己的机器**。
   *
   * 两条一起满足的只有一个答案：**配出来的那个域名**。
   * 它不随请求变，也不需要这台机器知道自己叫什么。
   *
   * ── next 参数 ──
   *
   * 登录后回到原来想去的地方，而不是一律扔回首页。
   * **带上查询串**：只存 pathname 的话，`/search?q=台风`、
   * `/me/bookmarks?f=none`、`/forum?board=xx` 登录后回到的都是
   * 一个没有筛选条件的空页面 —— 人得重新填一遍，
   * 而且多半会以为是刚才那一下没生效。
   */
  const login = new URL("/login", env.site.url);
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login, 307);
}

/*
 * matcher 必须覆盖 PROTECTED_PREFIXES 和 CONDITIONAL_PREFIXES 两张表。
 * 它是构建期常量，不能用变量拼 —— 所以只能手写，
 * 由 tests/proxy.test.ts 断言三者不脱节。
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
    /*
     * 整个 /forum 都进 matcher。
     *
     * 以前这里只挂了 /forum/new 和 /forum/convert 两条写入路径，
     * 因为浏览是公开的。现在「公开不公开」成了可配的，
     * 所以每一条都得经过这里 —— 由上面的判定决定放不放行。
     *
     * 开关开着时（默认）行为和以前完全一样：
     * 除了那两条写入路径，其余一律放行。
     */
    "/forum/:path*",
    "/forum",
    "/onboarding",
  ],
};
