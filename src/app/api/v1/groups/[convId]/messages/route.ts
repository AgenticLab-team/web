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
   * 上下界都要夹，而且 `offset` 也要。
   *
   * ─────────────────────────────────────────
   * 负数 LIMIT 在 SQLite 里等于不限
   * ─────────────────────────────────────────
   *
   * 原来只有 `Math.min(..., 200)`，于是 `?limit=-1` 一次就能把
   * 整个群的消息全拖走。它移掉的不是「一次返回多少」，
   * 是批量抽取的天花板。
   * （`searchMessages` 里也夹了一次 —— 这里是 HTTP 边界，
   * 那里是所有调用方的兜底。）
   *
   * 上界是 **100 不是 200**：`searchMessages` 本来就夹在 100，
   * 这边写 200 只是让调用方以为自己能要到 200，然后拿到 100 ——
   * 一个够不着的上限比没有上限更让人费解。两边写同一个数。
   *
   * ─────────────────────────────────────────
   * `offset` 是「往上翻」的全部机制
   * ─────────────────────────────────────────
   *
   * 网页那边翻历史走的是「按天回看」—— 一页 HTML 装不下四万条。
   * 而终端里的群聊是一个**常驻窗口**：人往上滚，期望的是
   * 「再往前一屏」，不是「跳到某一天」。没有这个参数的话，
   * 终端里永远只看得到最近那几十条 —— 那和「聊天软件」的差距
   * 不是少一个功能，是它不成立。
   *
   * 它和 limit 走同一个取数器，所以负数那条口子在两个参数上
   * 都是堵着的 —— 分开写的话，堵了一个漏一个，而漏的那个
   * 长得和正常请求一模一样。
   */
  const num = (key: string, fallback: number) => {
    const raw = Number(url.searchParams.get(key));
    return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : fallback;
  };
  const limit = Math.min(Math.max(1, num("limit", 50)), 100);
  const offset = num("offset", 0);

  const result = searchMessages(auth.caller.user, {
    query: url.searchParams.get("q") ?? "",
    /*
     * 不给 `q` 就列最近的 —— 这个接口的主用途是「读这个群的聊天记录」，
     * 关键词只是可选的筛选条件。
     *
     * 原来这里只在注释里这么写，代码却做不到：空关键词让 FTS 表达式变成 null，
     * 查询直接短路返回空。自带的调试控制台默认就不带 query string，
     * 所以**每一次运行都复现**，而 200 + 空数组把「你没给关键词」和
     * 「这个群这段时间真的没消息」混成了同一件事。
     */
    listWhenEmpty: true,
    convId,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    limit,
    offset,
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
