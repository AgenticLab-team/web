import { authenticate } from "@/lib/api-tokens/auth";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult } from "@/lib/api-tokens/route-helpers";
import { toggleVoteLink } from "@/lib/links/actions";

export const dynamic = "force-dynamic";

/**
 * 给一条链接点「有用」。再发一次就是取消。
 *
 * 点赞是公开信号，但**能不能点仍然按可见性收口** ——
 * 判定在 `toggleVoteLink` 里：看不到的东西不该能点。
 * 少了那一步的话，一个人可以靠「点一下看报不报错」
 * 试出别的群里有没有某条链接。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  return runAsApiCaller(auth.caller, async () => {
    const result = await toggleVoteLink(id);
    return fromResult(result, { voted: (result as { active?: boolean }).active });
  });
}
