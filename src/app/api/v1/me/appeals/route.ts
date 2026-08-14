import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, readJson } from "@/lib/api-tokens/route-helpers";
import { submitAppeal } from "@/lib/forum/appeals";

export const dynamic = "force-dynamic";

/** 对一条处罚提申诉 */
export async function POST(request: Request) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  const parsed = await readJson<{ action_id?: unknown; reason?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const { action_id: actionId, reason } = parsed.body;
  if (typeof actionId !== "string" || typeof reason !== "string") {
    return apiError(400, "bad_request", "要有 action_id 和 reason");
  }

  return runAsApiCaller(auth.caller, async () =>
    fromResult(await submitAppeal({ actionId, content: reason })),
  );
}
