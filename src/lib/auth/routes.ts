/**
 * 登录门禁涉及的两条纯规则。
 *
 * 它们同时被中间件、登录页和测试用到。这三处以前各写了一份，
 * 于是测试测的是抄件 —— 中间件漏掉 /admin 的时候测试全绿。
 * 现在只有这一份，改这里三处一起变。
 *
 * 注意这个文件会被 `proxy.ts` 引入。Next 16 起 proxy 跑的是 nodejs
 * 运行时（不像旧的 middleware 是 edge），所以「不能碰数据库」这条
 * 硬限制没有了 —— 但**这个文件仍然保持纯粹**：它是一张名单，
 * 名单不该依赖运行时能不能查库。要查库的判定写在 proxy 里。
 *
 * 页面里再写一次 redirect() 不能代替这份名单：那样访客拿到的是
 * 一个 200 的空壳，然后才被客户端弹走 —— 页面主体确实没渲染，
 * 但地址栏、标题、加载过程全都发生过一遍。/admin 当初就是这个样子。
 *
 * 这一条在论坛那道门上又验证了一次：只在 layout 里 redirect，
 * 线上实测拿到的是 **200 + 壳**，跳转指令躺在流里等客户端执行 ——
 * 浏览器会跳，`curl`、爬虫、微信的预览抓取不会。
 */

/** 未登录一律拦下的路径前缀 */
export const PROTECTED_PREFIXES = [
  "/me",
  "/admin",
  "/notifications",
  "/members",
  "/links",
  "/radar",
  /*
   * 项目目录。
   *
   * 它跟着 `/members` 走，而不是跟着论坛走：那一页把「站内某个人」
   * 和「某个 GitHub 账号」摆在同一行上 —— 仓库本来就在 GitHub 上
   * 公开着，但**这条对应关系是这个站拼出来的**，
   * 它不该出现在访客和搜索引擎面前。
   */
  "/projects",
  "/shop",
  "/search",
  /*
   * 按天回看跟着「群聊」这个入口一起拦下来。
   *
   * 它的正文本来就 100% 靠 visibleGroupsFor 收口 —— 访客能拿到的
   * 只有一个「仅对社群成员开放」的空壳。既然给访客的是空壳，
   * 就按这个文件开头那条规矩办：拦在中间件里，而不是让他先看到
   * 一次地址栏、标题和加载过程。
   */
  "/archive",
  "/forum/new",
  "/forum/convert",
  "/onboarding",
  /*
   * 新人补课包。它把群名、常驻成员、活跃时段一次全端出来 ——
   * 「群列表属于隐私」这条规矩下，它比大多数页面更不能漏。
   *
   * 页面里已经有 redirect 了，但那不算数（见文件开头）：
   * 访客拿到的会是一个 200 的空壳。
   */
  "/welcome",
] as const;

/**
 * **有条件**受保护的前缀 —— 拦不拦由配置说了算。
 *
 * 和上面那张表的区别：上面是「未登录一律拦下」，这里是
 * 「未登录时，看管理员把开关拨到哪一边」。
 *
 * 目前只有论坛（`site.forum_public`「论坛允许未登录浏览」）。
 * 单列出来是因为 matcher 必须覆盖它 —— 而 matcher 与
 * `PROTECTED_PREFIXES` 的一致性有测试盯着，
 * 混在一起的话，要么测试报假警，要么就得把断言放松到没用。
 */
export const CONDITIONAL_PREFIXES = [
  {
    prefix: "/forum",
    setting: "site.forum_public",
    why: "论坛是否允许未登录浏览，由管理员配置",
  },
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
 *
 * `/\evil.com` 也一样：按 URL 规范，反斜杠在这个位置等同于斜杠，
 * 浏览器同样会把它解析成协议相对地址。只挡 `//` 会漏掉它。
 *
 * 查询串是放行的（`/search?q=台风`）—— 挡掉的话，
 * 登录后回到的是一个没有筛选条件的空页面，人得重新填一遍。
 */
export function safeRedirect(next: string | undefined | null): string {
  if (!next || !next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}
