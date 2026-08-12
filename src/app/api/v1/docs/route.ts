import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { NOT_POSSIBLE, allowedFor, blockedFor } from "@/lib/api-tokens/catalog";
import { SEND_LIMIT } from "@/lib/api-tokens/rules";
import { grantedGroups } from "@/lib/api-tokens/store";
import { visibleGroupsFor } from "@/lib/queries/visibility";

export const dynamic = "force-dynamic";

/**
 * 「我这把令牌能干什么」——**按持有者算过的**那份文档。
 *
 * 一份写死的文档最常见的坏法不是过期，而是它描述的是另一个人的世界：
 * 读的人照着调，拿回一串 403，然后开始怀疑是自己写错了。
 *
 * 所以这里把三件事一起说清楚：能调什么、不能调什么（缺哪个 scope）、
 * 以及**上游根本做不到的那些**（群公告、踢人）。
 */
export async function GET(request: Request) {
  // 不要求任何 scope —— 它要回答的正是「我这把能干什么」
  const auth = await authenticate(request, []);
  if (!auth.ok) return auth.response;

  const { user, scopes } = auth.caller;

  /*
   * 能发到哪几个群，也按人算出来。
   *
   * 两个条件的交集：站长授权过 **且** 他确实还在那个群里 ——
   * 只列授权的话，一个退了群的人会看到一个调用必然失败的 conv_id，
   * 而失败信息是「没有这个群」，他会以为是我们记错了。
   */
  const visible = new Set(visibleGroupsFor(user).map((g) => g.convId));
  const sendable = grantedGroups(user.id).filter((c) => visible.has(c));

  return NextResponse.json({
    you: { id: user.id, name: user.siteNickname ?? user.wxNickname ?? null },
    scopes,
    endpoints: allowedFor(scopes),
    unavailable: blockedFor(scopes).map(({ endpoint, missing }) => ({
      method: endpoint.method,
      path: endpoint.path,
      summary: endpoint.summary,
      missing_scopes: missing,
    })),
    send: {
      groups: sendable,
      limits: SEND_LIMIT,
      note:
        "上游的额度是全站共用的（20 条/分钟），所以单把令牌的上限压得很低，" +
        "剩下的留给站长公告和系统告警",
      attribution: "每条消息都会自动追加一行「本消息由「你的昵称」使用 AgenticLab.sh 代发」",
    },
    not_possible: NOT_POSSIBLE,
  });
}
