import { NextResponse } from "next/server";

import { getRealUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import {
  authorizeUrl,
  callbackUrl,
  GITHUB_STATE_COOKIE,
  GITHUB_STATE_TTL_MS,
  safeReturnPath,
} from "@/lib/github/oauth-rules";
import { githubConfig, newState } from "@/lib/github/secret";

export const dynamic = "force-dynamic";

/**
 * 去 GitHub 授权。
 *
 * ═════════════════════════════════════════
 * 这是「加一个绑定」，不是「一种登录方式」
 * ═════════════════════════════════════════
 *
 * 第一行就是 `getRealUser()`：**没登录的人走不进这条路**。
 * 拿不到会话不是跳去 GitHub，是跳回登录页。
 *
 * 这个站的门是微信群 —— 只有群成员能拿到账号。如果这里对未登录的人
 * 也放行，那么「授权 GitHub」就会变成第二扇门，而那扇门朝全世界开着。
 * 更糟的是这件事**不会有任何症状**：站长自己点一下是能进的。
 *
 * 用 getRealUser() 而不是 getCurrentUser()：后者在预览态下返回的是
 * **被预览的那个人**。管理员正预览着某个用户时点了绑定，
 * 绑定会落到那个用户头上 —— 而这是一条不可能被解释清楚的记录。
 */
export async function GET(request: Request) {
  const config = githubConfig();
  /*
   * 没配置 = 这个功能不存在。
   *
   * 给 404 而不是「未配置」：后者会告诉外面的人「这里本来有个东西」，
   * 而且它对用户毫无意义 —— 一个用户既无法判断也无法解决这件事。
   */
  if (!config) return new NextResponse(null, { status: 404 });

  const user = await getRealUser();
  if (!user) {
    const login = new URL("/login", env.site.url);
    login.searchParams.set("next", "/me/security");
    return NextResponse.redirect(login, 307);
  }

  const url = new URL(request.url);
  const returnTo = safeReturnPath(url.searchParams.get("return"));

  const state = newState();

  const response = NextResponse.redirect(
    authorizeUrl({
      clientId: config.clientId,
      redirectUri: callbackUrl(env.site.url),
      state,
    }),
    307,
  );

  /*
   * state 与回跳地址一起放进**同一个 httpOnly cookie**。
   *
   * 回跳地址不能走 query —— 那样它就是攻击者可控的，
   * 而一个可控的回跳地址加上我们的域名就是一个开放重定向。
   * 放进 httpOnly cookie 之后，它只可能是我们自己在上面这行
   * 用 safeReturnPath() 洗过的值。
   *
   * sameSite 必须是 lax，不能是 strict：strict 的话，
   * 从 github.com 跳回来的那一下浏览器**不会带上这个 cookie**，
   * 于是每一次绑定都会以「state 对不上」告终。
   */
  // 写在 response 上而不是 cookies() 上 —— 与 /api/auth/bind/start 同一套写法。
  // 重定向响应是这里就地构造的，cookie 必须挂在它身上才会随这一跳发出去
  response.cookies.set(GITHUB_STATE_COOKIE, `${state}|${returnTo}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(GITHUB_STATE_TTL_MS / 1000),
  });

  return response;
}
