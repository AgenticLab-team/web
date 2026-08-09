import { ImageResponse } from "next/og";
import { eq, inArray } from "drizzle-orm";

import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { messageWindows, messages, people } from "@/lib/db/schema";
import { assertGroupAccess } from "@/lib/queries/visibility";
import {
  attribution,
  canShareWindow,
  clampContent,
  trimForImage,
  type ShareMessage,
} from "@/lib/share/rules";
import { resolveDisplayName } from "@/lib/users/display-name";

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

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#0b0b0d",
          padding: "48px 52px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 18 }}>
          {omitted > 0 && (
            <div style={{ color: "#6b6b73", fontSize: 22 }}>…前面还有 {omitted} 条</div>
          )}
          {shown.map((m, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ color: "#8a8a94", fontSize: 22 }}>{m.senderName}</div>
              <div style={{ color: "#f2f2f5", fontSize: 30, lineHeight: 1.4 }}>
                {clampContent(m.content)}
              </div>
            </div>
          ))}
        </div>

        {/* 出处：让拿到图的人知道这是成员社区的内部内容，不是公开发布的东西 */}
        <div
          style={{
            display: "flex",
            borderTop: "1px solid #26262c",
            paddingTop: 20,
            marginTop: 24,
            color: "#6b6b73",
            fontSize: 22,
          }}
        >
          {attribution({ memberOnly: true })}
        </div>
      </div>
    ),
    { width: 1080, height: 1350 },
  );
}
