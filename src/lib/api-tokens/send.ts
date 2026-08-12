import "server-only";

import { assertGroupAccess } from "@/lib/queries/visibility";
import type { CurrentUser } from "@/lib/auth/session";
import { nekobot } from "@/lib/nekobot/client";
import { sendFailed } from "@/lib/nekobot/types";

import { validateMessage, withAttribution } from "./rules";
import { recordSend, sendAllowance, sendGrantFor, senderNameOf } from "./store";

/**
 * 代成员往群里发一条消息。
 *
 * ═════════════════════════════════════════
 * 全站**只有这一条路**
 * ═════════════════════════════════════════
 *
 * API 和网页两个入口都走这里。两边各写一份的话，
 * 迟早有一份忘了加署名、忘了查授权、或者忘了记限流 ——
 * 而忘掉的那一次不会报错，只会安静地发出一条不该发的消息。
 *
 * 顺序也是有讲究的，从**便宜且致命**排到**贵**：
 *
 *   ① 授权（查一次索引）
 *   ② 可见性（他到底在不在这个群里）
 *   ③ 内容形状
 *   ④ 限流（三次 count）
 *   ⑤ 真的发出去（打外网，不可逆）
 *
 * 把限流放在发送之前是显然的；把**授权放在最前**没那么显然 ——
 * 但一个没被授权的人不该因为「内容太长」这种理由被拒，
 * 那等于告诉他「授权是有的，只是这条不行」。
 */

export type SendOutcome =
  | { ok: true; msgSvrId: string | null }
  | { ok: false; error: string; status: number; retryAfterSeconds?: number };

export async function sendToGroup(input: {
  user: CurrentUser;
  tokenId: string;
  convId: string;
  text: unknown;
}): Promise<SendOutcome> {
  const { user, tokenId, convId } = input;

  /*
   * ① 有没有被授权往这个群发 —— 顺带把**这条授权自己的额度**取回来。
   *
   * 一次查完，是因为限流那一步紧接着就要用：分两次查的话中间会有
   * 一个「授权已经收回、额度还是旧的」的窗口。
   */
  const grant = sendGrantFor(user.id, convId);
  if (!grant) {
    /*
     * 和「这个群不存在」用同一句话、同一个状态码。
     *
     * 分开说的话，一个没有授权的人可以拿这个接口**枚举出站里有哪些群** ——
     * 而群的存在本身就属于隐私（「群列表属于隐私，不要展示给游客」）。
     */
    return { ok: false, error: "没有这个群，或者你没有被授权往这里发消息", status: 404 };
  }

  /*
   * ② 授权之外**还要真的在这个群里**。
   *
   * 两道闸看起来重复，其实管的是两件事：授权是站长给的，
   * 而「他还在不在这个群」是随时会变的事实 —— 人退群之后
   * 那条授权还挂在库里，不查这一步他就还能往一个已经退了的群发消息。
   */
  if (!assertGroupAccess(user, convId)) {
    return { ok: false, error: "没有这个群，或者你没有被授权往这里发消息", status: 404 };
  }

  // ③ 内容。署名一定会加上去，所以正文预算要先扣掉它
  const senderName = senderNameOf(user.id);
  const message = validateMessage(input.text, senderName);
  if (!message.ok) return { ok: false, error: message.error ?? "内容不合要求", status: 400 };

  // ④ 限流。放在打外网之前
  const allowance = sendAllowance(tokenId, grant);
  if (!allowance.allowed) {
    return {
      ok: false,
      error: allowance.error ?? "太频繁了",
      status: 429,
      retryAfterSeconds: allowance.retryAfterSeconds ?? 60,
    };
  }

  /*
   * ⑤ 发。
   *
   * **署名在这里拼**，而且这是全站唯一拼它的地方 ——
   * 写成「调用前记得拼一下」的话，第二个调用点一定会忘。
   */
  const body = withAttribution(message.text, senderName);

  try {
    const result = await nekobot.sendText(convId, body);

    // 上游发失败时回的是 200 加 {"ok": false}，不看这个标志会把失败记成成功
    const rejected = sendFailed(result);
    if (rejected) {
      recordSend({
        tokenId,
        userId: user.id,
        convId,
        text: body,
        ok: false,
        error: rejected,
      });
      return { ok: false, error: rejected, status: 502 };
    }

    recordSend({
      tokenId,
      userId: user.id,
      convId,
      text: body,
      ok: true,
      msgSvrId: result.msg_svr_id ?? null,
    });
    return { ok: true, msgSvrId: result.msg_svr_id ?? null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    /*
     * 失败也要记。不记的话「试了一百次都失败」在限流上等于没发生 ——
     * 而那一百次每一次都真的打到了上游，扣的是全站共用的那份额度。
     */
    recordSend({
      tokenId,
      userId: user.id,
      convId,
      text: body,
      ok: false,
      error: detail,
    });
    return { ok: false, error: `发送失败：${detail}`, status: 502 };
  }
}
