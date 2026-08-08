import { NextResponse } from "next/server";

import { revokeCurrentSession } from "@/lib/auth/session";
import { env } from "@/lib/env";

/**
 * 退出登录。**只有 POST，绝不能提供 GET** ——
 * 这里曾经有个 GET 入口配合 <Link> 做成链接，结果 Next 在生产环境
 * 会对进入视口的 Link 自动预取：用户一打开「我的」页，预取的 GET
 * 就带着 cookie 把会话撤销了，表现为「一刷新就掉登录」。
 * GET 还会被爬虫和跨站 <img src> 触发 —— 带副作用的操作必须收在 POST 里。
 */
export async function POST(request: Request) {
  await revokeCurrentSession("logout");

  // 表单提交（顶层导航）要回首页；fetch 调用要 JSON。按 Accept 区分
  if (request.headers.get("accept")?.includes("text/html")) {
    return NextResponse.redirect(new URL("/", env.site.url), 303);
  }
  return NextResponse.json({ ok: true });
}
