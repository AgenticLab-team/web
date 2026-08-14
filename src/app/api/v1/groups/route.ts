import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { grantedGroups } from "@/lib/api-tokens/store";
import { visibleGroupsFor } from "@/lib/queries/visibility";

export const dynamic = "force-dynamic";

/**
 * 你在哪些群里。
 *
 * ═════════════════════════════════════════
 * 少了这一条，别的群接口全都用不了
 * ═════════════════════════════════════════
 *
 * 读消息要 `conv_id`，发消息也要 `conv_id` —— 而在这条接口之前，
 * **没有任何办法拿到它**。文档里写着 `47467058301@chatroom`
 * 那样一个示例值，谁也不知道自己的是什么。
 *
 * 站长的原话就是「开放平台看不到群列表啊」。
 *
 * ─────────────────────────────────────────
 * 「群列表属于隐私」在这里仍然成立
 * ─────────────────────────────────────────
 *
 * 这一条不是把群列表开出去：它走 `visibleGroupsFor`，
 * 返回的是**这个人自己所在的群**，和他在网页上看到的完全一样。
 * 没有令牌看不到，有令牌也只看得到自己的那几个。
 *
 * `can_send` 顺带给出来，因为「我能往哪个群发」是紧接着的下一个问题 ——
 * 不给的话，调用方只能挨个试，而试错的方式是**真的发一条出去**。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["groups:read"]);
  if (!auth.ok) return auth.response;

  const groups = visibleGroupsFor(auth.caller.user);
  /*
   * 授权是一个小集合，一次取回来做成 Set —— 逐个查的话
   * 一个在二十个群里的人会打二十次库。
   */
  const sendable = new Set(grantedGroups(auth.caller.user.id));

  return NextResponse.json({
    total: groups.length,
    groups: groups.map((g) => ({
      conv_id: g.convId,
      name: g.name,
      /*
       * 「能不能发」是两个条件的**交集**：站长授权过，而且他还在这个群里。
       * 这里已经只遍历「他在的群」，所以剩下的就是授权那一半。
       *
       * 只给其中一个的话，界面会列出一个调用必然失败的 conv_id ——
       * 而那次失败要等到他真的按下发送才知道。
       */
      can_send: sendable.has(g.convId),
    })),
  });
}
