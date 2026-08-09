import { ImageResponse } from "next/og";
import { eq, inArray } from "drizzle-orm";

import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { messageWindows, messages, people } from "@/lib/db/schema";
import { assertGroupAccess } from "@/lib/queries/visibility";
import { canShareWindow, trimForImage, type ShareMessage } from "@/lib/share/rules";
import { resolveDisplayName } from "@/lib/users/display-name";

import { WindowCard } from "./card";

export const runtime = "nodejs";

/**
 * 群聊片段的分享图。
 *
 * ─────────────────────────────────────────
 * 图上永远不出现群名
 * ─────────────────────────────────────────
 *
 * 「这条消息来自哪个群」比消息本身敏感得多 —— 它同时泄露了
 * 群的存在、群的主题、以及分享者在那个群里。
 *
 * 所以这个路由**根本不去查群名**：不是「查了但不画」，
 * 是压根不取。查了不画的写法，下一个来加功能的人很容易顺手画上去。
 *
 * ─────────────────────────────────────────
 * 生成即记审计
 * ─────────────────────────────────────────
 *
 * 图跑出去之后我们什么都做不了 —— 至少要查得到是谁生成的。
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser().catch(() => null);

  const win = db.select().from(messageWindows).where(eq(messageWindows.id, id)).get();
  if (!win) return new Response("找不到这段对话", { status: 404 });

  /*
   * 用 404 而不是 403。
   *
   * 403 等于回答了「这个 id 存在」，而 id 是可以枚举的 ——
   * 那就成了一个「这个群里有没有聊过某段」的探测接口。
   */
  if (!user || !assertGroupAccess(user, win.convId)) {
    return new Response("找不到这段对话", { status: 404 });
  }

  const verdict = canShareWindow({ viewerIsMember: true });
  if (!verdict.ok) return new Response(verdict.reason, { status: 403 });

  const ids = JSON.parse(win.messageIds) as string[];
  const rows =
    ids.length > 0
      ? db.select().from(messages).where(inArray(messages.id, ids)).all()
      : [];

  const nameOf = (wxId: string | null) => {
    if (!wxId) return "某人";
    const p = db.select().from(people).where(eq(people.wxId, wxId)).get();
    return p ? resolveDisplayName([p.displayName], { wxId, fallback: "某人" }) : "某人";
  };

  const all: ShareMessage[] = rows
    .sort((a, b) => a.ts - b.ts)
    .map((m) => ({ senderName: nameOf(m.senderWxId), content: m.content ?? "", ts: m.ts }));

  const { shown, omitted } = trimForImage(all);

  audit(
    { actorId: user.id },
    {
      action: "share.window.image",
      targetType: "message_window",
      targetId: win.id,
      after: { messages: shown.length },
      reason: "生成群聊分享图",
    },
  );

  // 画面在 ./card.tsx —— 拆出去是为了让测试能真的画一遍，
  // 这张图过去就是在渲染那一步 500 的
  return new ImageResponse(<WindowCard shown={shown} omitted={omitted} />, {
    width: 1080,
    height: 1350,
  });
}
