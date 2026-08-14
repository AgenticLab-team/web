import { authenticate } from "@/lib/api-tokens/auth";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult } from "@/lib/api-tokens/route-helpers";
import { toggleSaveLink } from "@/lib/links/actions";

export const dynamic = "force-dynamic";

/** 收藏一条链接。再发一次就是取消 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  return runAsApiCaller(auth.caller, async () => {
    const result = await toggleSaveLink(id);
    return fromResult(result, { saved: (result as { active?: boolean }).active });
  });
}
