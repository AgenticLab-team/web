import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readCode, srcRoot, walkSource } from "./_source";

/**
 * 「让开放 API 的调用复用站里已有的写操作」这件事的边界。
 *
 * ═════════════════════════════════════════
 * 这是全站唯一一处能让令牌变成「当前登录的人」的东西
 * ═════════════════════════════════════════
 *
 * `lib/api-tokens/auth.ts` 顶上画了一条线：
 * **绝不让令牌走进网页那条路，也绝不让 cookie 走进 API 这条路**。
 *
 * `runAsApiCaller` 没有打穿它 —— 它不读 cookie、不发会话，
 * 而且只在 `/api/v1` 的路由处理器里被设上，浏览器发起的请求
 * 永远看到空的存储。
 *
 * 但这条性质**完全依赖「它只在那儿被调用」**。
 * 一旦有第二处调用点（比如某个页面为了图方便包了一层），
 * 令牌就真的能冒充会话了 —— 而那不会报错，
 * 它只会让一个本该 401 的请求正常返回。
 *
 * 所以这份测试是那条性质的唯一保障。
 */

const ROUTE_PREFIX = "app/api/v1/";

function filesUsing(name: string): string[] {
  return walkSource(srcRoot())
    .map((f) => f.slice(srcRoot().length + 1))
    .filter((rel) => {
      /* 定义它的那个文件本身不算调用点 */
      if (rel === "lib/api-tokens/as-caller.ts") return false;
      return new RegExp(`\\b${name}\\(`).test(readCode(rel));
    })
    .sort();
}

describe("**`runAsApiCaller` 只许出现在 /api/v1 底下**", () => {
  const users = filesUsing("runAsApiCaller");

  it("扫描没退化 —— 一个调用点都没扫到的话，这条测试是在空转", () => {
    assert.ok(users.length > 10, `只扫到 ${users.length} 处，八成是路径或正则坏了`);
  });

  for (const f of users) {
    it(f, () => {
      assert.ok(
        f.startsWith(ROUTE_PREFIX),
        `${f} 用了 runAsApiCaller，而它不在 ${ROUTE_PREFIX} 底下。\n` +
          "在别处设上这个存储，等于让令牌冒充登录会话 —— " +
          "而那不会报错，只会让一个本该 401 的请求正常返回。",
      );
    });
  }
});

describe("**`currentApiCaller` 只许被身份那一层问**", () => {
  /*
   * 它是「这次是不是 API 调用」的判据。散到业务代码里的话，
   * 同一个动作会长出「网页版」和「API 版」两条分支 ——
   * 而那正是这整套设计要避免的东西
   * （见 `lib/api-tokens/as-caller.ts` 里 A/B 两条路的取舍）。
   */
  it("只有 lib/auth/session.ts 在问它", () => {
    assert.deepEqual(filesUsing("currentApiCaller"), ["lib/auth/session.ts"]);
  });
});

describe("身份那一层的两个入口都认得 API 调用者", () => {
  const session = readCode("lib/auth/session.ts");

  it("`getCurrentUser` 先问它，而且**问完就不读 cookie 了**", () => {
    /*
     * 「读了但优先用令牌」和「根本不去读」在行为上一样，
     * 但后者才让 `auth.ts` 那条红线继续成立 ——
     * 前者是一处随时会被改回去的巧合。
     */
    const fn = session.slice(session.indexOf("export async function getCurrentUser"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    const callerAt = body.indexOf("currentApiCaller()");
    const cookieAt = body.indexOf("await cookies()");
    assert.ok(callerAt >= 0, "getCurrentUser 没问 currentApiCaller");
    assert.ok(callerAt < cookieAt, "先读了 cookie 才问 —— 顺序反了");
    assert.match(body, /if \(caller\) return caller\.user;/);
  });

  it("**`getRealUser` 也要认** —— 否则写操作会以为没人登录", () => {
    /*
     * 站里一批写操作用的是 `getRealUser()`（它不受预览态偏移）。
     * 只改 `getCurrentUser` 的话，那些操作在 API 这条路上
     * 会一律返回「请先登录」—— 而调用方明明带了一把有效令牌。
     */
    const fn = session.slice(session.indexOf("export async function getRealUser"));
    assert.match(fn.slice(0, 400), /currentApiCaller\(\)/);
  });

  it("**API 调用永远不是预览态**", () => {
    /*
     * 预览是一个 cookie，而这条路不读 cookie —— 所以它本来就进不去。
     * 但写成一条判定而不是靠「反正读不到」：
     * 后者是一个碰巧成立的事实，前者是一条能被读到的规则。
     */
    const fn = session.slice(session.indexOf("export async function currentPreview"));
    assert.match(fn.slice(0, 300), /if \(currentApiCaller\(\)\) return null;/);
  });
});
