import "server-only";

import { asc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { boards, postSources, posts, users, visibilityRequests } from "@/lib/db/schema";
import type { Visibility } from "@/lib/db/schema/forum";
import { consentProgress } from "@/lib/moderation/escalation-rules";
import { visibilityLabel } from "@/lib/admin/board-rules";
import { resolveDisplayName } from "@/lib/users/display-name";

/**
 * 可见性提升队列。
 *
 * 每一行都要摆出**内容本身**，不只是标题。
 * 审核的问题是「这段群聊值不值得给全体成员看」——
 * 光看标题和申请理由回答不了，只能靠印象点通过，
 * 那这道审核就只是多了一步而已。
 */

export interface EscalationRow {
  id: string;
  postId: string;
  postTitle: string;
  postExcerpt: string | null;
  boardName: string;

  requestedBy: string;
  requesterName: string;
  postAuthorId: string;
  postAuthorName: string;

  fromVisibility: Visibility;
  toVisibility: Visibility;
  fromLabel: string;
  toLabel: string;
  reason: string;

  status: string;
  consent: ReturnType<typeof consentProgress>;
  /** 转帖引用了几条原始消息 */
  sourceMessages: number;

  reviewedBy: string | null;
  reviewNote: string | null;
  createdAt: number;
  waitingHours: number;
}

export function escalationQueue(
  query: { status?: string; limit?: number } = {},
  now = Date.now(),
): EscalationRow[] {
  const rows = db
    .select({
      req: visibilityRequests,
      post: posts,
      boardName: boards.name,
      requesterSite: users.siteNickname,
      requesterWx: users.wxNickname,
      requesterWxId: users.wxId,
    })
    .from(visibilityRequests)
    .innerJoin(posts, eq(posts.id, visibilityRequests.postId))
    .innerJoin(boards, eq(boards.id, posts.boardId))
    .leftJoin(users, eq(users.id, visibilityRequests.requestedBy))
    .where(
      query.status
        ? eq(visibilityRequests.status, query.status as "pending")
        : eq(visibilityRequests.status, "pending"),
    )
    // 最老的排最前：等待期间内容一直被锁着，申请人只能干等
    .orderBy(asc(visibilityRequests.createdAt))
    .limit(Math.min(query.limit ?? 100, 300))
    .all();

  if (rows.length === 0) return [];

  const authorIds = [...new Set(rows.map((r) => r.post.authorId))];
  const authorNames = new Map(
    db
      .select({
        id: users.id,
        site: users.siteNickname,
        wx: users.wxNickname,
        wxId: users.wxId,
      })
      .from(users)
      .where(sql`${users.id} in ${authorIds}`)
      .all()
      .map((u) => [
        u.id,
        resolveDisplayName([u.site, u.wx], { wxId: u.wxId, fallback: "社区成员" }),
      ]),
  );

  const sourceCounts = new Map(
    db
      .select({ postId: postSources.postId, ids: postSources.messageIds })
      .from(postSources)
      .where(sql`${postSources.postId} in ${rows.map((r) => r.post.id)}`)
      .all()
      .map((s) => [s.postId, Array.isArray(s.ids) ? s.ids.length : 0]),
  );

  return rows.map((r) => ({
    id: r.req.id,
    postId: r.post.id,
    postTitle: r.post.title,
    postExcerpt: r.post.excerpt,
    boardName: r.boardName,

    requestedBy: r.req.requestedBy,
    requesterName: resolveDisplayName([r.requesterSite, r.requesterWx], {
      wxId: r.requesterWxId,
      fallback: "社区成员",
    }),
    postAuthorId: r.post.authorId,
    postAuthorName: authorNames.get(r.post.authorId) ?? "社区成员",

    fromVisibility: r.req.fromVisibility,
    toVisibility: r.req.toVisibility,
    fromLabel: visibilityLabel(r.req.fromVisibility),
    toLabel: visibilityLabel(r.req.toVisibility),
    reason: r.req.reason,

    status: r.req.status,
    consent: consentProgress(r.req.consentRequired, r.req.consentGranted),
    sourceMessages: sourceCounts.get(r.post.id) ?? 0,

    reviewedBy: r.req.reviewedBy,
    reviewNote: r.req.reviewNote,
    createdAt: r.req.createdAt,
    waitingHours: Math.floor((now - r.req.createdAt) / 3600_000),
  }));
}

export function escalationFacets() {
  const byStatus = db
    .select({ status: visibilityRequests.status, n: sql<number>`count(*)` })
    .from(visibilityRequests)
    .groupBy(visibilityRequests.status)
    .all();

  const pending = Number(byStatus.find((r) => r.status === "pending")?.n ?? 0);
  const approved = Number(byStatus.find((r) => r.status === "approved")?.n ?? 0);
  const rejected = Number(byStatus.find((r) => r.status === "rejected")?.n ?? 0);
  const handled = approved + rejected;

  return {
    status: byStatus.map((r) => ({ value: r.status, count: Number(r.n) })),
    pending,
    handled,
    /*
     * 通过率。和申诉采纳率一样是**体检指标不是 KPI**：
     * 长期 100% 说明审核只是走过场，长期 0% 说明这条出口实际不存在，
     * 那大家就会绕过它 —— 比如直接把群聊内容复制成新帖。
     */
    approveRate: handled > 0 ? Math.round((approved / handled) * 100) : null,
  };
}

/** 某篇帖子是否已有待处理的申请 */
export function hasPendingRequest(postId: string): boolean {
  return (
    db
      .select({ id: visibilityRequests.id })
      .from(visibilityRequests)
      .where(
        sql`${visibilityRequests.postId} = ${postId} AND ${visibilityRequests.status} = 'pending'`,
      )
      .get() !== undefined
  );
}
