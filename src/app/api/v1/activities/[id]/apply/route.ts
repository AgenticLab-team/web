import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, readJson, toggleFlag } from "@/lib/api-tokens/route-helpers";
import { applyToActivity, cancelApplication } from "@/lib/activities/actions";
import { featureEnabled } from "@/lib/flags/server";

export const dynamic = "force-dynamic";

/**
 * 报名 / 退出。
 *
 * ─────────────────────────────────────────
 * 名额和资格判定都在 `applyToActivity` 里
 * ─────────────────────────────────────────
 *
 * 这里不预判「他够不够格」。预判是第二份规则，而这一份必然更松或更紧：
 * 更松的话人报上了名却在开始那天被刷下来，更紧的话
 * 一个本来够格的人被这条接口挡在门外，而网页上他能报。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["activities:write"]);
  if (!auth.ok) return auth.response;

  if (!featureEnabled("events", auth.caller.user)) {
    return apiError(404, "not_found", "活动模块没有开");
  }

  const parsed = await readJson<{ on?: unknown; answers?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const { id } = await params;
  const on = toggleFlag(parsed.body);

  return runAsApiCaller(auth.caller, async () =>
    fromResult(
      on
        ? await applyToActivity({
            activityId: id,
            payload:
              parsed.body.answers && typeof parsed.body.answers === "object"
                ? (parsed.body.answers as Record<string, unknown>)
                : {},
          })
        : await cancelApplication({ id }),
    ),
  );
}
