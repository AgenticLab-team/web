import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { paging, param } from "@/lib/api-tokens/route-helpers";
import { searchMessages } from "@/lib/search/messages";
import { semanticSearch } from "@/lib/search/semantic";

export const dynamic = "force-dynamic";

/**
 * 全站检索。
 *
 * ═════════════════════════════════════════
 * 可见性在 SQL 层切掉 —— 这一条没有例外
 * ═════════════════════════════════════════
 *
 * `ARCHITECTURE.md` 第五节：**搜索是最容易绕过权限的入口**。
 * 只要能搜到只言片语，私密内容就已经泄露了。
 *
 * 所以这里一行 SQL 都不写，全部走 `searchMessages(user, …)` ——
 * 那里面同时收口了「你在哪些群」和「谁关掉了『别人能搜到我的发言』」。
 *
 * ─────────────────────────────────────────
 * 语义检索**没配 LLM 就当它不存在**
 * ─────────────────────────────────────────
 *
 * 不是报错，也不是返回一个空的 `semantic` 字段说「功能未启用」——
 * 是这一栏根本不出现。这个仓库反复出现的一条原则是
 * 「半套配置比没配置更糟」：一个显示成「有但空」的功能
 * 会让人以为是自己搜的词不对。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["groups:read"]);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;
  const { query, limit } = paging(request, 100);
  if (!query) return NextResponse.json({ query: "", total: 0, hits: [] });

  const convId = param(request, "conv_id");
  const result = searchMessages(user, {
    query,
    convId: convId ?? undefined,
    from: param(request, "from") ?? undefined,
    to: param(request, "to") ?? undefined,
    limit,
  });

  const body: Record<string, unknown> = {
    query,
    total: result.total,
    hits: result.hits,
  };

  /*
   * 语义那一段是**尽力而为**：它要打外网、可能超时、可能没配。
   * 任何一种失败都不该让全文检索的结果一起消失 ——
   * 后者是这条接口的主体，前者是锦上添花。
   */
  if (param(request, "semantic") === "1") {
    try {
      const semantic = await semanticSearch(user, query, 10);
      /*
       * `error` 有值就当没有这一栏。
       *
       * 把一句「向量库还没建好」摆在结果旁边，人只会以为
       * 是自己搜的词不对 —— 而那句话对他没有任何可做的事。
       */
      if (!semantic.error) body.semantic = semantic;
    } catch {
      /* 语义检索挂了不影响主结果 —— 上面那段注释说的就是这一行 */
    }
  }

  return NextResponse.json(body);
}
