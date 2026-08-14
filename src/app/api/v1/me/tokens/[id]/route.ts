import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { revokeAllSshTokensOf, revokeToken } from "@/lib/api-tokens/store";

export const dynamic = "force-dynamic";

/**
 * 撤销令牌。
 *
 * ═════════════════════════════════════════
 * `?source=ssh` 是「网关失守时第一个要按的按钮」
 * ═════════════════════════════════════════
 *
 * SSH 网关那台机器上放着一批令牌明文（`TUI.md` 第四节）。
 * 怀疑它失守的时候，逐个去找「哪些是那台机器上的」做不到 ——
 * 令牌名字是人起的，一眼看不出来。
 *
 * 所以按来源一刀切。代价是他要重新登录一次，
 * 而那正是这个动作应有的代价。
 *
 * 路径上仍然要一个 `id`（传什么都行，习惯上传 `all`），
 * 因为 Next 的路由段不能是可选的。这一点在文档里写清楚。
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  const { user, tokenId } = auth.caller;
  const source = new URL(request.url).searchParams.get("source");

  if (source === "ssh") {
    const n = revokeAllSshTokensOf(user.id, "用户从终端一键撤销了全部 SSH 网关令牌");
    return NextResponse.json({ ok: true, revoked: n });
  }

  const id = decodeURIComponent((await params).id);

  /*
   * 撤自己正在用的那把要**明确确认**。
   *
   * 不拦的话，一次手滑的后果是当场掉线，而错误信息会是
   * 「令牌无效」—— 他会以为是服务端出了问题，
   * 而不是「我刚刚把自己踢了」。
   */
  if (id === tokenId && new URL(request.url).searchParams.get("confirm") !== "1") {
    return apiError(
      409,
      "self_revoke",
      "这就是你正在用的那把，撤掉会当场掉线。确定的话加上 ?confirm=1",
    );
  }

  const done = revokeToken(id, user.id, "用户撤销");
  if (!done) return apiError(404, "not_found", "没有这把令牌，或者它已经撤过了");
  return NextResponse.json({ ok: true });
}
