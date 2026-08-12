"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";

import { sendToGroup } from "./send";

/**
 * 网页上的代发。
 *
 * ═════════════════════════════════════════
 * 它和 API 走的是**同一条路**
 * ═════════════════════════════════════════
 *
 * 站长的原话是「他可以通过 api 调用 也可以通过网页调用」——
 * 两个**入口**，但只有一条**路**：都进 `sendToGroup`。
 *
 * 在这里另写一份「查授权、拼署名、记一条」会短很多，
 * 而那正是署名会丢的地方 —— 丢了不会报错，只会安静地
 * 往一千六百人的群里发一条看不出是谁让机器人说的消息。
 *
 * ─────────────────────────────────────────
 * 这个文件是 "use server"，所以每个导出都是客户端能直接调的
 * ─────────────────────────────────────────
 *
 * 于是这里只能有这一个函数，而且它**自己去取当前用户** ——
 * 收 `user` 当参数的话，任何人都能传一个别人的 id 进来，
 * 那就是以别人的名义发消息。
 */

export type WebSendResult =
  | { ok: true; note: string }
  | { ok: false; error: string; retryAfterSeconds?: number };

export async function sendToGroupFromWeb(
  convId: string,
  text: string,
): Promise<WebSendResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "先登录" };

  /*
   * `tokenId` 传 null —— 网页这条路本来就没有令牌。
   *
   * 硬塞一个假的（比如 "web"）会让代发日志里「这条是怎么发出去的」
   * 永远查不清：那一栏看起来像个令牌 id，其实不是。
   */
  const outcome = await sendToGroup({ user, tokenId: null, convId, text });

  if (!outcome.ok) {
    return {
      ok: false,
      error: outcome.error,
      retryAfterSeconds: outcome.retryAfterSeconds,
    };
  }

  revalidatePath("/me/api");
  return { ok: true, note: "发出去了。群里看到的那一条带着你的代发署名" };
}
