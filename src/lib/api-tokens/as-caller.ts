import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import type { CurrentUser } from "@/lib/auth/session";
import type { ScopeKey } from "./rules";

/**
 * 让**开放 API 的调用**能复用站里已有的那批写操作。
 *
 * ═════════════════════════════════════════
 * 先说清楚它有没有打穿 `auth.ts` 顶上那条红线
 * ═════════════════════════════════════════
 *
 * 那条红线是：「**绝不让令牌走进网页那条路，也绝不让 cookie 走进
 * API 这条路**」，理由两条 ——
 *
 *   ① 令牌能开网页的话，一次 CSRF 就等于一次登录
 *   ② cookie 能开 API 的话，任何第三方页面都能用浏览器替用户调接口
 *
 * 这个文件**两条都没有碰**：
 *
 *   · 它不读 cookie。API 那条路上仍然只认 `Authorization: Bearer`
 *   · 它不发 cookie，也不建会话。令牌永远进不了浏览器那条路
 *   · 这个存储只在 `src/app/api/v1/**` 的路由处理器里被设上。
 *     浏览器发起的请求（页面渲染、Server Action）**从来不经过那里**，
 *     所以它们看到的永远是空的存储，行为一个字都没变
 *
 * 变的只有一件事：`getCurrentUser()` 在 API 请求期间能答出「是谁」。
 *
 * ═════════════════════════════════════════
 * 为什么必须这么做，而不是把动作重写一遍
 * ═════════════════════════════════════════
 *
 * 站里的写操作（打卡、收藏、关注、报名、下单、改资料、后台的一百来个
 * 管理动作）全都是 `"use server"` 的动作函数，身份从
 * `getCurrentUser()` 里取，不收 `user` 参数。
 *
 * 要让令牌调得动它们，只有两条路：
 *
 *   **A. 每个动作拆成 `xxxAs(user, input)` 核心 + 薄壳**
 *       —— 一百多次机械改动，而每一次都是一个把
 *       `requireWritableAdmin` / `audit` / 预览态拦截漏掉的机会。
 *       论坛那两个（`createPostAs` / `createReplyAs`）就是这么拆的，
 *       拆两个可以，拆一百个必然漏。
 *
 *   **B. 让身份这一层认识「API 调用者」这种身份**（这个文件）
 *       —— 一处改动，动作函数一个字不动，
 *       于是它们的权限判定、审计、限流**逐字**还是网页那一套。
 *
 * 选 B 的决定性理由不是省事，是 `tests/api-surface.test.ts` 顶上
 * 那句话：另写一份「简化版」，两份规则迟早分叉，
 * **而分叉的方向永远是 API 那份更宽松**。B 让「两份」根本不存在。
 *
 * ═════════════════════════════════════════
 * 代价，以及它被什么拦着
 * ═════════════════════════════════════════
 *
 * 代价是这个存储一旦在别处被设上，令牌就真的能冒充会话了。
 * 所以有一条结构性守卫（`tests/tui-api-caller.test.ts`）：
 * `runAsApiCaller` 的调用点**只允许出现在 `src/app/api/v1/` 底下**。
 * 多一处就红。
 */

export interface ApiCallerIdentity {
  user: CurrentUser;
  tokenId: string;
  scopes: ScopeKey[];
}

const store = new AsyncLocalStorage<ApiCallerIdentity>();

/**
 * 在这次调用期间，把「当前的人」设成这把令牌背后的账号。
 *
 * 只在 `/api/v1` 的路由处理器里用。
 */
export function runAsApiCaller<T>(identity: ApiCallerIdentity, fn: () => T): T {
  return store.run(identity, fn);
}

/**
 * 当前请求是不是一次 API 调用；是的话给出是谁。
 *
 * `getCurrentUser()` / `getRealUser()` 会先问这一句。
 */
export function currentApiCaller(): ApiCallerIdentity | null {
  return store.getStore() ?? null;
}
