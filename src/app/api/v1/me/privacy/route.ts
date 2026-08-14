import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, readJson } from "@/lib/api-tokens/route-helpers";
import { setPrivacySwitch } from "@/lib/privacy/actions";
import { privacyOf } from "@/lib/privacy/queries";
import { PRIVACY_SWITCHES, switchIsOn } from "@/lib/privacy/rules";

export const dynamic = "force-dynamic";

/**
 * 隐私开关。
 *
 * ═════════════════════════════════════════
 * 每一项都要带上「它**不管**什么」
 * ═════════════════════════════════════════
 *
 * 网页那一页顶上写着这条理由，这里照抄一遍，因为它同样成立：
 * 一个隐私开关最坏的形态不是没有，是**让人以为它管得比实际多** ——
 * 那样他会照着一个不存在的保护去说话。
 *
 * 在 API 上这件事更容易出问题：终端那侧只拿得到字段名
 * （`searchable`、`hide_from_leaderboard`），而字段名什么也没说清。
 * 所以说明文案跟着数据一起下发，终端直接显示，不自己编。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["me:read"]);
  if (!auth.ok) return auth.response;

  const settings = privacyOf(auth.caller.user.id);
  return NextResponse.json({
    switches: PRIVACY_SWITCHES.map((spec) => ({
      key: spec.key,
      label: spec.label,
      detail: spec.detail,
      /* 关掉之前先说清楚现在露的是什么 */
      exposure: spec.exposure,
      /* 「关掉之后它仍然**不管**什么」—— 这一栏是这条接口存在的理由，见上 */
      limit: spec.limit,
      on: switchIsOn(spec.key, settings[spec.key]),
    })),
  });
}

export async function POST(request: Request) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  const parsed = await readJson<{ key?: unknown; on?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const { key, on } = parsed.body;
  if (typeof key !== "string" || typeof on !== "boolean") {
    /*
     * `on` 这一条不套用 `toggleFlag` 的「缺省为真」。
     *
     * 那个缺省服务的是「打开这个」类的动作（收藏、关注）。
     * 隐私开关不是那样：两个方向都是明确的意图，
     * 而猜错的方向可能是**把一个人的保护关掉**。
     */
    return apiError(400, "bad_request", "要有 key（字符串）和 on（布尔）");
  }

  return runAsApiCaller(auth.caller, async () => fromResult(await setPrivacySwitch(key, on)));
}
