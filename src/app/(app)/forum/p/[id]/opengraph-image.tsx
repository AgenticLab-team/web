import { ImageResponse } from "next/og";

import { getCurrentUser } from "@/lib/auth/session";
import { buildViewerContext } from "@/lib/forum/context";
import { getPost } from "@/lib/forum/queries";
import { canReadForum } from "@/lib/forum/public-access";
import { isIndexable } from "@/lib/forum/visibility";
import { truncateAtBoundary } from "@/lib/text";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const runtime = "nodejs";

/**
 * 分享卡片。微信里发链接会带预览图，这是内容能不能被点开的关键。
 *
 * **只给公开内容生成真实卡片。** 受限内容返回一张不含任何标题与
 * 正文的通用图 —— 卡片图是公开可抓取的，把标题画上去
 * 等于给私密内容开了个后门。
 */
export default async function OpengraphImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // 生成卡片时没有会话，一律按访客判定
  const user = await getCurrentUser().catch(() => null);
  const viewer = buildViewerContext(user);
  const post = getPost(viewer, id);

  /*
   * 关了门就不发带标题的预览图。
   *
   * 卡片图是**独立路由**，`forum/layout.tsx` 那道门覆盖不到它 ——
   * 漏掉这一处的话，论坛对访客关着，而每条链接的预览图
   * 还在往微信、Telegram、抓取器里送标题和摘要。
   */
  const shareable =
    canReadForum(user?.id) &&
    post &&
    isIndexable({
      visibility: post.visibility,
      authorId: post.authorId,
      status: post.raw.status,
      fromGroupChat: post.raw.visibilityLocked,
    });

  const title = shareable ? post.title : "Agentic Lab";
  const subtitle = shareable
    ? truncateAtBoundary(post.excerpt ?? "", 76)
    : "AI Agent 社区 · 内容仅对成员开放";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#f5f5f3",
          padding: "72px 80px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 11,
              background: "#0d5c47",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 20,
              fontWeight: 700,
            }}
          >
            AL
          </div>
          <div style={{ fontSize: 24, color: "#3c3c43", fontWeight: 500 }}>Agentic Lab</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div
            style={{
              fontSize: title.length > 28 ? 56 : 68,
              fontWeight: 700,
              color: "#16161a",
              lineHeight: 1.2,
              letterSpacing: "-0.02em",
              display: "block",
            }}
          >
            {title.slice(0, 48)}
          </div>
          {subtitle && (
            <div style={{ fontSize: 28, color: "#6b6b73", lineHeight: 1.45, display: "block" }}>
              {subtitle}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 40, height: 4, background: "#0d5c47", borderRadius: 2 }} />
          <div style={{ fontSize: 22, color: "#8e8e93" }}>
            {shareable ? post.boardName : "agenticlab.sh"}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
