import { NextResponse } from "next/server";

import { getRealUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { exchangeCode, fetchViewer } from "@/lib/github/api";
import { linkGithub } from "@/lib/github/link";
import {
  callbackUrl,
  GITHUB_STATE_COOKIE,
  safeReturnPath,
  stateMatches,
  type LinkFailure,
} from "@/lib/github/oauth-rules";
import { refreshGithubData } from "@/lib/github/repos";
import { githubConfig } from "@/lib/github/secret";

export const dynamic = "force-dynamic";

/**
 * GitHub 授权回调。
 *
 * ═════════════════════════════════════════
 * 这条路上有三道门，顺序不能换
 * ═════════════════════════════════════════
 *
 * ① **配置**：没配就 404，功能整体不存在。
 * ② **state**：对不上就到此为止。这是防 CSRF 的全部 —— 没有它，
 *    攻击者可以在自己的页面上放一个带着**他自己的 code** 的回调链接，
 *    受害者点开之后，他的站内账号就绑上了攻击者的 GitHub。
 *    受害者不会收到任何提示，只会某天发现主页上多了几个不认识的仓库。
 * ③ **会话**：`getRealUser()` 必须拿得到人。**拿不到就跳登录页，
 *    绝不建号、绝不发会话。**
 *
 * ③ 是这个站的底线。账号只能靠在微信群里收验证码建立 ——
 * 「只有群成员能登录」这一条如果在这里被绕过去，
 * 等于把整个站对全世界开放，而且没有任何外部症状。
 *
 * 所以这个文件里没有 createSession、没有 setSessionCookie、
 * 没有对 users 表的 insert。tests/github-oauth.test.ts 会逐条核对
 * 这几个名字一个都不出现在 lib/github 与这两个路由里。
 *
 * ─────────────────────────────────────────
 * 先验 state 还是先验会话？
 * ─────────────────────────────────────────
 *
 * 先 state。会话检查放前面的话，一个没登录的人带着伪造 state 过来
 * 会被跳去登录页 —— 登录完之后浏览器不会回到这个回调，
 * 结果是一次沉默的失败，而且看起来像是「GitHub 又抽风了」。
 * 先验 state 能让「链接失效了，重新点一次」这句话是准确的。
 */
export async function GET(request: Request) {
  const config = githubConfig();
  if (!config) return new NextResponse(null, { status: 404 });

  const url = new URL(request.url);
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${GITHUB_STATE_COOKIE}=`))
    ?.slice(GITHUB_STATE_COOKIE.length + 1);

  const [cookieState, cookieReturn] = (cookie ?? "").split("|");
  const returnTo = safeReturnPath(cookieReturn);

  /** 无论成功失败都把 state cookie 清掉 —— 一个 state 只能用一次 */
  const finish = (result: LinkFailure | "ok") => {
    const target = new URL(returnTo, env.site.url);
    target.searchParams.set("github", result);
    const response = NextResponse.redirect(target, 303);
    response.cookies.delete(GITHUB_STATE_COOKIE);
    return response;
  };

  // 用户在 GitHub 上点了「取消」。这不是错误，说清楚就行
  if (url.searchParams.get("error")) return finish("denied");

  if (!stateMatches(cookieState, url.searchParams.get("state"))) return finish("bad_state");

  const code = url.searchParams.get("code");
  if (!code) return finish("bad_state");

  /*
   * 会话。**这里是「不能凭 GitHub 登录」这条约束的落点。**
   * 没有登录态就什么都不做 —— 不建账号、不发会话、不写任何一行数据。
   */
  const user = await getRealUser();
  if (!user) return finish("not_logged_in");

  let viewer;
  let token;
  try {
    token = await exchangeCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: callbackUrl(env.site.url),
    });
    viewer = await fetchViewer(token.accessToken);
  } catch {
    // 具体原因不外传 —— 这一路的错误信息里带着 client_secret 的回显
    return finish("exchange_failed");
  }

  const result = linkGithub(user.id, viewer, token, config.tokenKey);
  if (!result.ok) return finish(result.reason);

  /*
   * 第一次绑定立刻抓一轮，**而且是 baseline** ——
   * 把他现在已有的仓库和 PR 全部记成「见过了」，一条提示都不产生。
   *
   * 不这么做的话，一个写了十年代码的人绑完会立刻收到一批提示，
   * 内容是他三年前建的仓库。那一刻这个功能就已经死了：
   * 他学会的是「这块地方净是废话」，而下一条真正有用的提示
   * 会和这些一起被划掉。
   *
   * 失败也不影响绑定 —— 绑上了就是绑上了，数据可以下次再抓。
   */
  if (result.firstTime) {
    try {
      await refreshGithubData(user.id, { baseline: true });
    } catch {
      // 抓取失败不回滚绑定：下一次打开「我的」会再试一次
    }
  }

  return finish("ok");
}
