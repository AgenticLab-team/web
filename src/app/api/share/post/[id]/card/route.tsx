import { ImageResponse } from "next/og";

import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { buildViewerContext } from "@/lib/forum/context";
import { getPost } from "@/lib/forum/queries";
import { attribution, canSharePost, clampContent } from "@/lib/share/rules";

export const runtime = "nodejs";

/**
 * 帖子的分享图。
 *
 * ─────────────────────────────────────────
 * 和 opengraph-image 不是一回事
 * ─────────────────────────────────────────
 *
 * `opengraph-image.tsx` 是给**链接预览**用的：微信抓取时没有会话，
 * 所以它只给公开内容画真实卡片。
 *
 * 这一张是给**人手动保存转发**用的：请求带着会话，
 * 所以成员可见的帖子也能生成 —— 但要在图上标出「成员社区内部内容」，
 * 让拿到图的人知道这不是公开发布的东西。
 *
 * 草稿、已删除、私密一律不给：那些做成图之后，
 * **连作者自己都控制不住它去哪**。
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser().catch(() => null);

  const viewer = buildViewerContext(user);
  const post = getPost(viewer, id);
  // 看不到就当不存在 —— 403 等于确认了这个 id 有东西
  if (!post) return new Response("找不到这个帖子", { status: 404 });

  const verdict = canSharePost({
    visibility: post.visibility,
    status: post.raw.status,
    viewerCanSee: true,
  });
  if (!verdict.ok) return new Response(verdict.reason, { status: 403 });

  if (user) {
    audit(
      { actorId: user.id },
      {
        action: "share.post.image",
        targetType: "post",
        targetId: post.id,
        reason: "生成帖子分享图",
      },
    );
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#0b0b0d",
          padding: "72px 64px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div style={{ color: "#8a8a94", fontSize: 26 }}>{post.boardName}</div>
          <div style={{ color: "#f2f2f5", fontSize: 60, lineHeight: 1.25, fontWeight: 600 }}>
            {clampContent(post.title, 44)}
          </div>
          {post.excerpt && (
            <div style={{ color: "#a8a8b2", fontSize: 30, lineHeight: 1.5 }}>
              {clampContent(post.excerpt, 96)}
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            color: "#6b6b73",
            fontSize: 24,
          }}
        >
          <span>{post.authorName}</span>
          <span>{attribution({ memberOnly: verdict.redactGroupName })}</span>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
