import "server-only";

import { desc, eq, isNull, like, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { previewSessions, roles, userRoles, users } from "@/lib/db/schema";
import { resolveDisplayName } from "@/lib/users/display-name";

import { effectivePermissions } from "./can";

/**
 * 预览面板要的数据。
 *
 * 和 preview.ts 分开是因为那边是 "use server" 之外的写入口，
 * 而这里全是读 —— 混在一起的话，页面渲染会把整个写入模块拖进来。
 */

export interface PreviewCandidate {
  id: string;
  name: string;
  wxId: string | null;
  status: string;
  /** 身份组，让人一眼看出「这是个版主」而不是靠猜 */
  roleNames: string[];
  permissionCount: number;
}

/**
 * 找可以预览的人。
 *
 * **必须搜索，不能列全站。** 一千八百人的下拉框选不出东西，
 * 而且把整份名册铺在后台页面上本身就不合适。
 */
export function findPreviewCandidates(query: string, limit = 8): PreviewCandidate[] {
  const q = query.trim();
  if (!q) return [];

  const pattern = `%${q}%`;
  const rows = db
    .select()
    .from(users)
    .where(
      or(
        like(users.wxId, pattern),
        like(users.wxNickname, pattern),
        like(users.siteNickname, pattern),
      ),
    )
    .limit(limit)
    .all();

  return rows.map((u) => {
    const held = db
      .select({ name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, u.id))
      .all();

    return {
      id: u.id,
      name: resolveDisplayName([u.siteNickname, u.wxNickname], { wxId: u.wxId }),
      wxId: u.wxId,
      status: u.status,
      roleNames: held.map((r) => r.name),
      permissionCount: effectivePermissions(u).size,
    };
  });
}

export interface PreviewHistoryRow {
  id: string;
  viewerName: string;
  subjectName: string;
  createdAt: number;
  endedAt: number | null;
  endReason: string | null;
  withheldCount: number;
}

/**
 * 最近谁预览过谁。
 *
 * 这一段是这个功能里最要紧的 UI：一个只读的功能，
 * 它的**唯一**制衡就是「事后看得见」。
 * 没有这张表，「以他人身份预览」就是一个没人看得见的特权。
 */
export function recentPreviews(limit = 20): PreviewHistoryRow[] {
  const rows = db
    .select()
    .from(previewSessions)
    .orderBy(desc(previewSessions.createdAt))
    .limit(limit)
    .all();

  const nameOf = (id: string) => {
    const u = db.select().from(users).where(eq(users.id, id)).get();
    if (!u) return "（已删除）";
    return resolveDisplayName([u.siteNickname, u.wxNickname], { wxId: u.wxId });
  };

  return rows.map((r) => ({
    id: r.id,
    viewerName: nameOf(r.viewerId),
    subjectName: nameOf(r.subjectId),
    createdAt: r.createdAt,
    endedAt: r.endedAt,
    endReason: r.endReason,
    withheldCount: (JSON.parse(r.withheld) as string[]).length,
  }));
}

/** 现在有几个人正处在预览态 —— 挂着没退出的那种 */
export function livePreviewCount(nowMs: number): number {
  return db
    .select()
    .from(previewSessions)
    .where(isNull(previewSessions.endedAt))
    .all()
    .filter((r) => r.expiresAt > nowMs).length;
}
