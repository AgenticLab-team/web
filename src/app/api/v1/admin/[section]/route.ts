import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { paging, param, readJson } from "@/lib/api-tokens/route-helpers";
import { adminActionSpec, adminSection } from "@/lib/admin/api-registry";
import { PreviewWriteError } from "@/lib/auth/session";
import { can } from "@/lib/rbac/can";

export const dynamic = "force-dynamic";

/**
 * 后台的读与写，三十个分区共用这一个路由。
 *
 * ═════════════════════════════════════════
 * 这里**不做**权限判定，它只是把 HTTP 翻译成一次调用
 * ═════════════════════════════════════════
 *
 * 真正的判定在动作函数内部的 `requireWritableAdmin("权限点")` 里 ——
 * 那是网页那边用的同一段代码，带着审计和预览态拦截。
 *
 * 这里那句 `can(...)` 是**列表用的**：它决定「这个分区在不在你的
 * 终端里出现」，判宽了的后果是多出一个点进去 403 的入口，
 * 而不是越权。两者的方向不同，所以不能合并成一处。
 *
 * ─────────────────────────────────────────
 * `runAsApiCaller` 是这条路由存在的全部技巧
 * ─────────────────────────────────────────
 *
 * 那些动作函数的身份是从 `getCurrentUser()` 里取的。包一层之后，
 * 它们在这条路上取到的就是这把令牌背后的账号，而**函数本身
 * 一个字没改** —— 权限点、审计、限流逐字还是网页那一套。
 *
 * 为什么不给一百个动作各加一个 `user` 参数：
 * 见 `lib/api-tokens/as-caller.ts`。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ section: string }> },
) {
  const auth = await authenticate(request, ["admin:all"]);
  if (!auth.ok) return auth.response;

  const key = decodeURIComponent((await params).section);
  const section = adminSection(key);
  /*
   * 「没有这个分区」和「你进不了这个分区」给同一个 404。
   *
   * 分开报的话，一个权限有限的人能靠这条接口把后台的功能清单
   * 摸出来 —— 而后台的功能清单本身也是信息
   * （`lib/admin/guard.ts` 顶上那条原则）。
   */
  if (!section || !can(auth.caller.user, section.permission).allowed) {
    return apiError(404, "not_found", "没有这个后台分区");
  }

  const { limit, offset, query } = paging(request, 200);

  return runAsApiCaller(auth.caller, async () => {
    const data = section.read({ id: param(request, "id"), query, limit, offset });
    return NextResponse.json({ section: section.key, data });
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ section: string }> },
) {
  const auth = await authenticate(request, ["admin:all"]);
  if (!auth.ok) return auth.response;

  const key = decodeURIComponent((await params).section);
  const section = adminSection(key);
  if (!section || !can(auth.caller.user, section.permission).allowed) {
    return apiError(404, "not_found", "没有这个后台分区");
  }

  const parsed = await readJson<{ action?: unknown; confirm?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as Record<string, unknown>;

  const actionKey = typeof body.action === "string" ? body.action : "";
  const spec = adminActionSpec(section, actionKey);
  if (!spec) {
    return apiError(
      400,
      "bad_request",
      `这个分区上没有「${actionKey}」这个动作。可做的动作见 GET /api/v1/admin/sections`,
    );
  }

  /*
   * 危险级 ≥2 的要显式确认。
   *
   * 它挡的不是恶意 —— 恶意的那个人当然会把 `confirm` 填上。
   * 它挡的是**脚本手滑**：一个 for 循环写错了对象、
   * 或者一次复制粘贴把「封禁」的请求体发给了「加备注」。
   */
  if ((spec.danger ?? 0) >= 2 && body.confirm !== true) {
    return apiError(
      409,
      "needs_confirm",
      `「${spec.label}」是不可逆或影响很大的动作，请求体里要带 "confirm": true`,
    );
  }

  return runAsApiCaller(auth.caller, async () => {
    try {
      const result = await spec.run(body);
      if (!result.ok) return apiError(400, "rejected", result.error ?? "没做成");
      return NextResponse.json({ ...result, ok: true });
    } catch (err) {
      /*
       * 预览态下的写入会抛出来。
       *
       * 令牌这条路上其实进不了预览态（预览是一个 cookie，
       * 而这条路不读 cookie）—— 但这个 catch 仍然要在：
       * 它保证的是「哪天有人把预览接进了别的地方」时，
       * 这里报的是一句人话，而不是一个 500。
       */
      if (err instanceof PreviewWriteError) {
        return apiError(403, "preview_readonly", err.message);
      }
      throw err;
    }
  });
}
