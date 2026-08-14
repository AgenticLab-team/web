import { authenticate } from "@/lib/api-tokens/auth";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult } from "@/lib/api-tokens/route-helpers";
import { removeKeyword } from "@/lib/radar/actions";
import { mySubs } from "@/lib/radar/queries";

export const dynamic = "force-dynamic";

/** 删掉一个关键词 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  return runAsApiCaller(auth.caller, async () =>
    fromResult(await removeKeyword(id), { keywords: mySubs(auth.caller.user.id) }),
  );
}
