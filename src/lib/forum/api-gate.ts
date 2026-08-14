import "server-only";

import type { NextResponse } from "next/server";

import { apiError } from "@/lib/api-tokens/auth";
import type { CurrentUser } from "@/lib/auth/session";
import { featureEnabled } from "@/lib/flags/server";

/**
 * 开放 API 上的论坛闸口。
 *
 * ═════════════════════════════════════════
 * 不判它的话，令牌就是一条绕过功能开关的后门
 * ═════════════════════════════════════════
 *
 * 网页那边关掉论坛之后 `requireFeature` 会 404。API 这条路
 * 如果不判，站长以为关掉了，实际上**带令牌照样读得到、发得出去** ——
 * 而这件事没有任何外部症状：他自己打开网页看到的确实是关着的。
 *
 * ─────────────────────────────────────────
 * 为什么是一个共用函数，而不是每条路由自己写三行
 * ─────────────────────────────────────────
 *
 * 论坛在 API 上有十几条路由。抄十几遍的话，下一条新加的
 * 十有八九会漏 —— 而漏掉的那一条不会报错，它只是**照常工作**。
 *
 * `tests/forum-public.test.ts` 盯着这个：论坛相关的每一条路由
 * 都要出现这个函数名。
 *
 * ─────────────────────────────────────────
 * 它**不**判 `canReadForum`
 * ─────────────────────────────────────────
 *
 * 那个开关管的是「对未登录访客开不开」，而 API 这条路上没有访客：
 * 一把有效令牌背后一定是一个真实账号。在这里判它等于永远为真，
 * 而一条永远为真的判定会让下一个人以为访客问题已经处理过了。
 */
export function forumGate(user: CurrentUser): NextResponse | null {
  if (featureEnabled("forum", user)) return null;
  return apiError(404, "not_found", "论坛模块没有开");
}
