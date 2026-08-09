/**
 * 登录门禁涉及的两条纯规则。
 *
 * 它们同时被中间件、登录页和测试用到。这三处以前各写了一份，
 * 于是测试测的是抄件 —— 中间件漏掉 /admin 的时候测试全绿。
 * 现在只有这一份，改这里三处一起变。
 *
 * 注意这个文件会被 middleware 引入，跑在 edge runtime 里：
 * **不能碰数据库、不能引 server-only**。
 *
 * 页面里再写一次 redirect() 不能代替这份名单：那样访客拿到的是
 * 一个 200 的空壳，然后才被客户端弹走 —— 页面主体确实没渲染，
 * 但地址栏、标题、加载过程全都发生过一遍。/admin 当初就是这个样子。
 */

/** 未登录一律拦下的路径前缀 */
export const PROTECTED_PREFIXES = [
  "/me",
  "/admin",
  "/notifications",
  "/members",
  "/links",
  "/shop",
  "/search",
  "/forum/new",
  "/forum/convert",
  "/onboarding",
] as const;

/**
 * 前缀匹配要区分「子路径」和「恰好同前缀」——
 * /members 不该因为以 /me 开头就被当成 /me 的子路径。
 */
export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * 登录后的回跳地址。
 *
 * 回跳参数是最经典的开放重定向入口：放行绝对地址的话，
 * 一个看起来完全正常的本站登录链接就能把人导到钓鱼站。
 * 只接受站内路径，且 `//evil.com` 这种协议相对写法必须一起挡掉 ——
 * 浏览器把它当 https://evil.com。
 */
export function safeRedirect(next: string | undefined | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
