import "server-only";

import type { CurrentUser } from "@/lib/auth/session";
import { nekobot } from "@/lib/nekobot/client";
import { sendFailed } from "@/lib/nekobot/types";
import { assertGroupAccess } from "@/lib/queries/visibility";

import { MAX_MESSAGE_CHARS, withAttribution } from "./rules";
import { recordSend, sendAllowance, sendGrantFor, senderNameOf } from "./store";

/**
 * 改群公告。
 *
 * ═════════════════════════════════════════
 * 它比发消息更狠，所以门槛只能更高
 * ═════════════════════════════════════════
 *
 * 一条消息发出去会往下滚，一小时后没人看得见。
 * 群公告是**所有人打开群就看见的那段字**，而且改它是**整条替换** ——
 * 上游没有「追加」这种操作，写进去的东西会把原来的公告顶掉。
 *
 * 于是这里有两件发消息那条路上没有的事：
 *
 *   ① **先读一遍旧的**，让调用方看得见自己即将覆盖掉什么
 *   ② 覆盖掉的原文**记进留痕**，否则那段字就永久消失了 ——
 *      群公告在微信里没有历史版本
 *
 * 除此之外，授权、限流、署名全部沿用发消息那一套，一个字都不另写：
 * 「能往这个群发消息」和「能改这个群的公告」共用同一条授权是有意的 ——
 * 拆成两种权限听起来更细，实际是给站长增加一个几乎永远不会用到的选择，
 * 而每多一个选择就多一次选错。
 */

export type AnnounceOutcome =
  | { ok: true; previous: string | null }
  | { ok: false; error: string; status: number; retryAfterSeconds?: number };

/** 读现在的公告。只要在群里就能读 —— 群里每个人本来就看得见 */
export async function readAnnouncement(
  user: CurrentUser,
  convId: string,
): Promise<{ ok: true; text: string | null } | { ok: false; error: string; status: number }> {
  if (!assertGroupAccess(user, convId)) {
    return { ok: false, error: "没有这个群，或者你不在里面", status: 404 };
  }
  try {
    const result = await nekobot.announcement(convId);
    return { ok: true, text: result.text ?? null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `读不到群公告：${detail}`, status: 502 };
  }
}

export async function setAnnouncement(input: {
  user: CurrentUser;
  tokenId: string | null;
  convId: string;
  text: unknown;
}): Promise<AnnounceOutcome> {
  const { user, tokenId, convId } = input;

  // ① 授权。和发消息同一条 —— 顺序与理由见 send.ts
  const grant = sendGrantFor(user.id, convId);
  if (!grant) {
    return { ok: false, error: "没有这个群，或者你没有被授权改这里的公告", status: 404 };
  }
  if (!assertGroupAccess(user, convId)) {
    return { ok: false, error: "没有这个群，或者你没有被授权改这里的公告", status: 404 };
  }

  // ② 内容
  if (typeof input.text !== "string") {
    return { ok: false, error: "text 必须是字符串", status: 400 };
  }
  const text = input.text.trim();
  if (!text) {
    /*
     * 空字符串会**清空群公告**。那可能正是他要的，但更可能是
     * 一个没填的表单 —— 而这个操作没有撤销。要清空就明说。
     */
    return { ok: false, error: "公告不能为空。真要清空的话，写一句「本群暂无公告」", status: 400 };
  }

  const senderName = senderNameOf(user.id);
  const body = withAttribution(text, senderName);
  if ([...body].length > MAX_MESSAGE_CHARS) {
    return { ok: false, error: `连署名一共不能超过 ${MAX_MESSAGE_CHARS} 字`, status: 400 };
  }

  // ③ 限流。和发消息共用额度 —— 改公告同样是在打上游、同样会打扰所有人
  const allowance = sendAllowance(user.id, convId, grant);
  if (!allowance.allowed) {
    return {
      ok: false,
      error: allowance.error ?? "太频繁了",
      status: 429,
      retryAfterSeconds: allowance.retryAfterSeconds ?? 60,
    };
  }

  /*
   * ④ 先把旧的读出来。
   *
   * 读失败**不拦着写** —— 上游读接口挂了不该导致公告改不了。
   * 但那时候留痕里那一栏是空的，而这正是它要如实反映的：
   * 我们确实不知道覆盖掉了什么。
   */
  let previous: string | null = null;
  try {
    previous = (await nekobot.announcement(convId)).text ?? null;
  } catch {
    previous = null;
  }

  // ⑤ 写
  try {
    const result = await nekobot.setAnnouncement(convId, body);
    const rejected = sendFailed(result);

    recordSend({
      tokenId,
      userId: user.id,
      convId,
      /*
       * 留痕里存的是**新公告加上被覆盖的原文**。
       *
       * 只存新的话，「原来写的是什么」就永久没了 ——
       * 群公告在微信里没有历史版本，我们这条记录是唯一的一份。
       */
      text: previous === null ? body : `${body}\n\n[被覆盖的原公告]\n${previous}`,
      ok: !rejected,
      error: rejected ?? null,
    });

    if (rejected) return { ok: false, error: rejected, status: 502 };
    return { ok: true, previous };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    recordSend({ tokenId, userId: user.id, convId, text: body, ok: false, error: detail });
    return { ok: false, error: `改公告失败：${detail}`, status: 502 };
  }
}
