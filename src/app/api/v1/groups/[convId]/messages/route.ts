import { NextResponse } from "next/server";

import { authenticate, apiError } from "@/lib/api-tokens/auth";
import { sendToGroup } from "@/lib/api-tokens/send";
import { assertGroupAccess } from "@/lib/queries/visibility";
import { searchMessages } from "@/lib/search/messages";

export const dynamic = "force-dynamic";

/**
 * 读这个群的消息。
 *
 * 走 `searchMessages` 而不是自己写一条 SQL —— 可见性收口、
 * 隐私开关（关掉「别人能搜到我的发言」的人不出现）都在那里面，
 * 而且**过滤是落在 SQL 里的**，不是查出来再 filter。
 * 另写一份必然漏掉其中一条。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ convId: string }> },
) {
  const auth = await authenticate(request, ["groups:read"]);
  if (!auth.ok) return auth.response;

  const convId = decodeURIComponent((await params).convId);
  /*
   * 先判在不在这个群里。不判的话，`searchMessages` 会返回空结果，
   * 而「这个群我不在」和「这个群没有匹配的消息」在调用方看来一模一样。
   */
  if (!assertGroupAccess(auth.caller.user, convId)) {
    return apiError(404, "not_found", "没有这个群，或者你不在里面");
  }

  const url = new URL(request.url);
  /*
   * ─────────────────────────────────────────
   * `offset` 是「往上翻」的全部机制
   * ─────────────────────────────────────────
   *
   * 网页那边翻历史走的是「按天回看」——它按日期切片，
   * 因为一页 HTML 装不下四万条。
   *
   * 而终端里的群聊是一个**常驻窗口**：人会往上滚，
   * 期望的是「再往前一屏」，不是「跳到某一天」。
   * 没有这一个参数的话，终端里永远只看得到最近的那几十条，
   * 而那和「聊天软件」的差距不是少一个功能，是它不成立。
   *
   * 上限仍然按 200 封顶 —— 一个 `?limit=100000`
   * 长得和正常请求一模一样，而它能把一台小服务器的内存吃掉。
   */
  const num = (key: string, fallback: number) => {
    const raw = Number(url.searchParams.get(key));
    return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
  };

  const result = searchMessages(auth.caller.user, {
    // 空查询 = 不按关键词筛，按时间倒序给最近的
    query: url.searchParams.get("q") ?? "",
    convId,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    limit: Math.min(num("limit", 50) || 50, 200),
    offset: Math.floor(num("offset", 0)),
  });

  return NextResponse.json({
    total: result.total,
    messages: result.hits.map((h) => ({
      id: h.id,
      sender: h.senderName,
      content: h.content,
      ts: h.ts,
      type: h.type,
    })),
  });
}

/**
 * 往一个群发一条文本。
 *
 * ```
 * POST /api/v1/groups/<conv_id>/messages
 * Authorization: Bearer al_…
 * {"text": "大家好"}
 * ```
 *
 * ⚠️ 发出去的消息**一定会带一行代发署名** —— 见 `lib/api-tokens/rules.ts`。
 * 这不是可选项：消息由机器人账号发出，不署名的话群里没有人知道是谁说的。
 *
 * 所有检查（授权、在不在这个群、内容、限流、留痕）都在 `sendToGroup` 里，
 * 这个文件只负责把 HTTP 翻译成那次调用 —— 网页那个入口调的是同一个函数。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ convId: string }> },
) {
  const auth = await authenticate(request, ["groups:send"]);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_json", "请求体不是合法的 JSON");
  }

  const { convId } = await params;
  const result = await sendToGroup({
    user: auth.caller.user,
    tokenId: auth.caller.tokenId,
    convId: decodeURIComponent(convId),
    text: (body as { text?: unknown } | null)?.text,
  });

  if (!result.ok) {
    return apiError(
      result.status,
      result.status === 429 ? "rate_limited" : "send_failed",
      result.error,
      result.retryAfterSeconds
        ? { "Retry-After": String(result.retryAfterSeconds) }
        : undefined,
    );
  }

  return NextResponse.json({ ok: true, msg_svr_id: result.msgSvrId });
}
