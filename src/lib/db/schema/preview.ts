import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 「以某身份预览」的记录。
 *
 * 为什么是一张表而不是一个签名 cookie：
 *   · 可以**随时掐断** —— 出事时不必等 cookie 过期
 *   · 每一次预览都留痕，谁在什么时候看过谁，事后查得到
 *   · 不用为此引入一个新的签名密钥
 *
 * withheld 记的是「他有、你没有、预览里没给你」的那些权限点。
 * 存下来是因为事后复盘时要能回答「他当时看到的视角准不准」。
 */
export const previewSessions = sqliteTable(
  "preview_sessions",
  {
    id: ulidPk(),
    tokenHash: text("token_hash").notNull(),
    /** 真正的人 —— 审计永远记在他头上 */
    viewerId: text("viewer_id").notNull(),
    /** 被预览的人 */
    subjectId: text("subject_id").notNull(),
    /** JSON 数组：他有而 viewer 没有的权限点 */
    withheld: text("withheld").notNull(),

    createdAt: now("created_at"),
    expiresAt: integer("expires_at").notNull(),
    endedAt: integer("ended_at"),
    endReason: text("end_reason", { enum: ["exit", "expired", "revoked"] }),
  },
  (t) => [
    uniqueIndex("preview_sessions_token_idx").on(t.tokenHash),
    index("preview_sessions_viewer_idx").on(t.viewerId, t.createdAt),
  ],
);
