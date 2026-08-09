import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  GITHUB_SCOPE,
  authorizeUrl,
  callbackUrl,
  githubConfigured,
  isValidTokenKey,
  safeReturnPath,
  stateMatches,
} from "@/lib/github/oauth-rules";

/**
 * GitHub OAuth 的安全边界。
 *
 * ═════════════════════════════════════════
 * 这个文件里的每一条都对应「做错了会很久没人发现」的一件事
 * ═════════════════════════════════════════
 *
 * OAuth 的特点是：**做错了它照样能用**。
 * 不校验 state，绑定流程一样跑通；顺手做成「用 GitHub 登录」，
 * 站长自己点一下也一样能进。这类错误不会有任何功能上的症状，
 * 所以它只能靠测试挡，挡不住就会一直错下去。
 */

// lib/github/secret.ts 会经 env.ts 走一遍必填校验 —— 这里只是让它加载得起来
process.env.NEKOBOT_API_KEY ??= "nk_test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(path) ? [path] : [];
  });
}

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * 断言代码之前先去注释。
 *
 * 不去的话这些检查会被**自己的说明文字**骗过去：
 * callback 那个路由的注释里写着「没有 createSession」，
 * 而检查器看到 createSession 就报错 —— 越是把原因写清楚的地方越容易误报。
 */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("**绑定 GitHub 绝不能变成一条登录途径**", () => {
  /*
   * 这个站的门是微信群：只有群成员拿得到账号。
   * 如果绑定顺手做成了「用 GitHub 登录」，这道门等于拆了 ——
   * 全世界任何一个有 GitHub 账号的人都能进来。
   *
   * 而它**不会有任何症状**：站长自己点「用 GitHub 登录」是能进的，
   * 一切看起来都正常。所以只能在这里逐条钉死。
   */
  const files = [
    ...walk(join(ROOT, "src/lib/github")),
    join(ROOT, "src/app/api/auth/github/start/route.ts"),
    join(ROOT, "src/app/api/auth/github/callback/route.ts"),
  ];

  it("整个 GitHub 模块里没有任何一处建立会话", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const body = code(readFileSync(file, "utf8"));
      for (const forbidden of ["createSession", "setSessionCookie", "SESSION_COOKIE"]) {
        if (new RegExp(`\\b${forbidden}\\b`).test(body)) {
          offenders.push(`${file.replace(ROOT, "")} → ${forbidden}`);
        }
      }
    }
    assert.deepEqual(offenders, [], "GitHub 模块碰了会话 —— 这就是「用 GitHub 就能登录进来」");
  });

  it("整个 GitHub 模块里没有任何一处往 users 表插入", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const body = code(readFileSync(file, "utf8"));
      // insert(users) / insert(schema.users) 都算
      if (/\.insert\(\s*(schema\.)?users\s*\)/.test(body)) {
        offenders.push(file.replace(ROOT, ""));
      }
    }
    assert.deepEqual(offenders, [], "GitHub 模块会建账号 —— 那就是注册，不是绑定");
  });

  it("回调路由认的是**真实登录的人**，不是预览态里那个人", () => {
    /*
     * getCurrentUser() 在预览态下返回的是被预览的那个人。
     * 用它的话，管理员正预览着某个用户时点了绑定，
     * 绑定会落到那个用户头上 —— 一条永远解释不清楚的记录。
     */
    const callback = code(read("src/app/api/auth/github/callback/route.ts"));
    assert.match(callback, /getRealUser\(\)/, "回调没用 getRealUser");
    assert.doesNotMatch(callback, /getCurrentUser\(/, "回调用了 getCurrentUser —— 预览态下会绑错人");
  });

  it("拿不到登录用户时，回调**什么都不做**就结束", () => {
    const callback = code(read("src/app/api/auth/github/callback/route.ts"));
    assert.match(
      callback,
      /const user = await getRealUser\(\);\s*if \(!user\) return finish\("not_logged_in"\);/,
      "没登录时回调没有立刻结束 —— 后面任何一步都可能建出账号",
    );
  });

  it("发起授权之前也要求已登录 —— 未登录的人跳回登录页，不跳 GitHub", () => {
    const start = code(read("src/app/api/auth/github/start/route.ts"));
    assert.match(start, /getRealUser\(\)/);
    assert.match(start, /if \(!user\)/);
    assert.match(start, /"\/login"/);
  });
});

describe("**state 必须有，而且必须真的校验**", () => {
  /*
   * 没有 state 校验的话：攻击者在自己的页面上放一个指向我们回调、
   * 带着**他自己的 code** 的链接。受害者点开，
   * 他的站内账号就绑上了攻击者的 GitHub —— 而受害者收不到任何提示。
   */
  it("对不上就是不通过", () => {
    assert.equal(stateMatches("a".repeat(32), "b".repeat(32)), false);
  });

  it("**两边都空不算通过**", () => {
    // 「空 === 空」是这类校验最经典的漏法：压根没带 state 反而通过了
    assert.equal(stateMatches(undefined, null), false);
    assert.equal(stateMatches("", ""), false);
    assert.equal(stateMatches(undefined, "abc"), false);
    assert.equal(stateMatches("abc", null), false);
  });

  it("太短的一律不认 —— 短 state 是可以枚举的", () => {
    assert.equal(stateMatches("abc", "abc"), false);
    assert.equal(stateMatches("a".repeat(15), "a".repeat(15)), false);
    assert.equal(stateMatches("a".repeat(16), "a".repeat(16)), true);
  });

  it("长度不同直接不认，不做前缀匹配", () => {
    const s = "x".repeat(32);
    assert.equal(stateMatches(s, s.slice(0, 24)), false);
    assert.equal(stateMatches(s, `${s}extra`), false);
  });

  it("一样就通过", () => {
    const s = "9f".repeat(20);
    assert.equal(stateMatches(s, s), true);
  });

  it("回调路由确实调了它，而且在换 token 之前", () => {
    const callback = code(read("src/app/api/auth/github/callback/route.ts"));
    // 比的是**调用点**的位置，不是 import 的位置 —— import 永远在最上面
    const stateAt = callback.indexOf("stateMatches(");
    const exchangeAt = callback.indexOf("exchangeCode({");
    assert.ok(stateAt > 0, "回调压根没校验 state");
    assert.ok(exchangeAt > stateAt, "先换 token 再校验 state —— 校验就没有意义了");
  });

  it("state cookie 用完就删，一个 state 只能用一次", () => {
    const callback = code(read("src/app/api/auth/github/callback/route.ts"));
    assert.match(callback, /cookies\.delete\(GITHUB_STATE_COOKIE\)/);
  });

  it("state cookie 必须是 httpOnly，而且 sameSite 只能是 lax", () => {
    /*
     * strict 的话，从 github.com 跳回来的那一下浏览器不会带上这个 cookie，
     * 于是**每一次绑定都会以「state 对不上」告终** —— 一个把功能
     * 完全弄坏、但看起来像是安全加固的改动。
     */
    const start = code(read("src/app/api/auth/github/start/route.ts"));
    assert.match(start, /httpOnly:\s*true/);
    assert.match(start, /sameSite:\s*"lax"/);
    assert.doesNotMatch(start, /sameSite:\s*"strict"/);
  });
});

describe("**回跳地址不能变成开放重定向**", () => {
  it("只收站内相对路径", () => {
    assert.equal(safeReturnPath("/me/points"), "/me/points");
    assert.equal(safeReturnPath("/forum?board=x"), "/forum?board=x");
  });

  it("绝对地址、协议相对地址、反斜杠写法一律退回默认", () => {
    // `//evil.com` 和 `/\evil.com` 浏览器都当成 https://evil.com
    for (const bad of [
      "https://evil.com",
      "//evil.com",
      "/\\evil.com",
      "javascript:alert(1)",
      "/ok\r\nSet-Cookie: x=1",
    ]) {
      assert.equal(safeReturnPath(bad), "/me/security", `${bad} 没被挡住`);
    }
  });

  it("回跳地址走 httpOnly cookie，不走查询参数", () => {
    /*
     * 走 query 的话它就是攻击者可控的，而它挂在我们的域名下 ——
     * 一个看起来完全可信的钓鱼跳板。
     */
    const callback = code(read("src/app/api/auth/github/callback/route.ts"));
    assert.match(callback, /safeReturnPath\(cookieReturn\)/);
    assert.doesNotMatch(callback, /searchParams\.get\("return"\)/);
  });
});

describe("**只要公开权限**", () => {
  it("scope 是空的 —— 一个私有仓库的门都碰不到", () => {
    assert.equal(GITHUB_SCOPE, "");
  });

  it("授权链接里根本不带 scope 参数", () => {
    const url = authorizeUrl({
      clientId: "cid",
      redirectUri: "https://example.com/api/auth/github/callback",
      state: "s".repeat(32),
    });
    assert.doesNotMatch(url, /[?&]scope=/);
    assert.match(url, /client_id=cid/);
    assert.match(url, /state=s{32}/);
  });

  it("抓仓库走的是「按定义只返回公开仓库」的那个接口", () => {
    /*
     * `/users/{login}/repos` 无论拿什么 token 调都只返回公开仓库。
     * 而 `/user/repos` 会跟着 scope 走 —— 哪天有人为了别的需求
     * 加了 repo scope，私有仓库就会**自动**出现在所有人主页上，
     * 而没有任何一行代码改动看起来和这件事有关。
     */
    const api = code(read("src/lib/github/api.ts"));
    assert.match(api, /\/users\/\$\{encodeURIComponent\(login\)\}\/repos/);
    assert.doesNotMatch(api, /["'`]\/user\/repos/);
    assert.doesNotMatch(api, /visibility=private|type=private/);
  });

  it("PR 走的是公开动态流", () => {
    const api = code(read("src/lib/github/api.ts"));
    assert.match(api, /\/events\/public/);
  });
});

describe("**没配置的时候整个功能不出现**", () => {
  it("三项缺一不可", () => {
    const key = "ab".repeat(32);
    assert.equal(githubConfigured({ clientId: "a", clientSecret: "b", tokenKey: key }), true);
    assert.equal(githubConfigured({ clientSecret: "b", tokenKey: key }), false);
    assert.equal(githubConfigured({ clientId: "a", tokenKey: key }), false);
    assert.equal(githubConfigured({ clientId: "a", clientSecret: "b" }), false);
    assert.equal(githubConfigured({}), false);
  });

  it("加密密钥必须是 32 字节的十六进制串", () => {
    assert.equal(isValidTokenKey("ab".repeat(32)), true);
    assert.equal(isValidTokenKey("ab".repeat(16)), false, "16 字节的密钥不该被当成 AES-256 的");
    assert.equal(isValidTokenKey("zz".repeat(32)), false, "非十六进制字符没挡住");
    assert.equal(isValidTokenKey(undefined), false);
  });

  it("两个路由在没配置时都是 404，而不是报错", () => {
    /*
     * 给 404 而不是「未配置」：后者会告诉外面的人「这里本来有个东西」，
     * 而且对用户毫无意义 —— 他既无法判断也无法解决这件事。
     */
    for (const rel of [
      "src/app/api/auth/github/start/route.ts",
      "src/app/api/auth/github/callback/route.ts",
    ]) {
      const body = code(read(rel));
      assert.match(body, /if \(!config\) return new NextResponse\(null, \{ status: 404 \}\)/, rel);
    }
  });

  it("入口按钮也跟着消失 —— 只藏路由的话页面上会剩一个点了报错的按钮", () => {
    const page = code(read("src/app/(app)/me/security/page.tsx"));
    assert.match(page, /githubEnabled\(\)/);
    assert.match(page, /\{githubOn && \(/);
  });

  it("环境变量没有硬编码的兜底值", () => {
    /*
     * `?? "某个默认值"` 在这里是最危险的写法：它会让「没配置」
     * 变成「配了一个假的」，于是功能出现、点下去在 GitHub 那边失败，
     * 而用户会以为是自己的 GitHub 有问题。
     */
    const envSrc = code(read("src/lib/env.ts"));
    const block = envSrc.slice(envSrc.indexOf("github: {"), envSrc.indexOf("webauthn: {"));
    assert.ok(block.includes("GITHUB_CLIENT_ID"), "env.ts 里没有 github 段");
    for (const m of block.matchAll(/\?\?\s*"([^"]*)"/g)) {
      assert.equal(m[1], "", `GitHub 配置里有硬编码兜底值：${m[1]}`);
    }
  });
});

describe("**token 落库前要加密，而且改一个字节就必须读不出来**", () => {
  it("加解密能对上", async () => {
    const { encryptToken, decryptToken } = await import("@/lib/github/secret");
    const key = "3f".repeat(32);
    const cipher = encryptToken("gho_secrettoken", key);
    assert.notEqual(cipher, "gho_secrettoken", "根本没加密");
    assert.doesNotMatch(cipher, /gho_/, "密文里能看到明文片段");
    assert.equal(decryptToken(cipher, key), "gho_secrettoken");
  });

  it("同样的明文两次加密结果不同 —— iv 每次都得重取", () => {
    // GCM 下同一密钥重复 iv 会同时泄露两条明文，这是它唯一的致命误用方式
    return import("@/lib/github/secret").then(({ encryptToken }) => {
      const key = "3f".repeat(32);
      assert.notEqual(encryptToken("same", key), encryptToken("same", key));
    });
  });

  it("被改过一个字节就解不出来（GCM 认证失败），而不是解出垃圾", async () => {
    const { encryptToken, decryptToken } = await import("@/lib/github/secret");
    const key = "3f".repeat(32);
    const cipher = encryptToken("gho_secrettoken", key);
    const tampered = `${cipher.slice(0, -2)}${cipher.endsWith("AA") ? "BB" : "AA"}`;
    assert.equal(decryptToken(tampered, key), null);
  });

  it("换了密钥读不出来，但**返回 null 而不是抛异常**", async () => {
    /*
     * 换 GITHUB_TOKEN_KEY 是一个运维动作，它不该表现成一片页面 500。
     * 正确的表现是「这个人的数据刷不了了，等他重新绑一次」。
     */
    const { encryptToken, decryptToken } = await import("@/lib/github/secret");
    const cipher = encryptToken("gho_x", "3f".repeat(32));
    assert.equal(decryptToken(cipher, "a1".repeat(32)), null);
    assert.equal(decryptToken(null, "3f".repeat(32)), null);
    assert.equal(decryptToken("garbage", "3f".repeat(32)), null);
  });

  it("token 不写进审计日志", () => {
    const link = code(read("src/lib/github/link.ts"));
    const auditBlock = link.slice(link.indexOf("audit("), link.indexOf("return { ok: true, connection"));
    assert.doesNotMatch(auditBlock, /accessToken|token\.accessToken/, "审计里带上了 token");
  });

  it("GitHub 的错误信息里不回显响应体 —— 那里面带着 client_secret 的回显", () => {
    const api = code(read("src/lib/github/api.ts"));
    assert.doesNotMatch(api, /error_description/);
    assert.doesNotMatch(api, /console\.(log|error)\(/, "API 客户端在往日志里打东西");
  });
});

describe("回调地址是拼出来的，不是配出来的", () => {
  it("跟着 SITE_URL 走，末尾多余的斜杠不会拼出双斜杠", () => {
    assert.equal(
      callbackUrl("https://example.com/"),
      "https://example.com/api/auth/github/callback",
    );
    assert.equal(
      callbackUrl("https://example.com"),
      "https://example.com/api/auth/github/callback",
    );
  });
});
