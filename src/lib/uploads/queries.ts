import "server-only";

import { and, count, desc, eq, gt } from "drizzle-orm";

import { db } from "@/lib/db";
import { uploads } from "@/lib/db/schema";
import type { UploadKind } from "@/lib/uploads/rules";

/**
 * 上传的记账与限流。
 *
 * ─────────────────────────────────────────
 * 限流按人，而且必须比上游更严
 * ─────────────────────────────────────────
 *
 * 上游的访客通道是**按 IP** 限的（10 分钟 20 次），而我们是从服务器
 * 代传的 —— 全站共用一个出口 IP。也就是说上游那条限制在我们这里
 * 变成了**全站共享的一条队列**：不在自己这一侧按人限住的话，
 * 一个人连传 20 张，剩下所有人在接下来十分钟里一张都发不出去，
 * 而他们看到的是一句莫名其妙的「太频繁」。
 *
 * 所以每人 10 分钟 8 次：够一篇图文并茂的帖子，
 * 不够一个人把全站的额度吃掉。
 *
 * 管理端的限流这个项目已经全部去掉了（站长的原话：「我有数」），
 * **但用户侧的保留** —— 这一条属于用户侧。
 */

export const USER_WINDOW_MS = 10 * 60_000;
export const USER_QUOTA = 8;

export interface QuotaVerdict {
  allowed: boolean;
  /** 还能传几次。给界面显示，让人知道自己离上限还有多远 */
  remaining: number;
  retryAfterSeconds: number;
}

export function checkQuota(userId: string, now = Date.now()): QuotaVerdict {
  const since = now - USER_WINDOW_MS;

  const recent = db
    .select({ n: count(), oldest: uploads.createdAt })
    .from(uploads)
    .where(and(eq(uploads.userId, userId), gt(uploads.createdAt, since)))
    .get();

  const used = recent?.n ?? 0;
  if (used < USER_QUOTA) {
    return { allowed: true, remaining: USER_QUOTA - used, retryAfterSeconds: 0 };
  }

  /*
   * 窗口内最早那一次到期时才腾出名额 —— 所以「还要等多久」
   * 是从它算起，不是从现在算起十分钟。
   *
   * 差别不小：一个刚好撞上限的人，实际上可能再等十几秒就行了。
   * 告诉他「等十分钟」会让他直接放弃。
   */
  const oldest = db
    .select({ createdAt: uploads.createdAt })
    .from(uploads)
    .where(and(eq(uploads.userId, userId), gt(uploads.createdAt, since)))
    .orderBy(uploads.createdAt)
    .get();

  const freeAt = (oldest?.createdAt ?? now) + USER_WINDOW_MS;
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: Math.max(1, Math.ceil((freeAt - now) / 1000)),
  };
}

export function recordUpload(input: {
  userId: string;
  url: string;
  kind: UploadKind;
  mime: string;
  bytes: number;
  filename?: string | null;
  ip?: string | null;
}): void {
  db.insert(uploads)
    .values({
      userId: input.userId,
      url: input.url,
      kind: input.kind,
      mime: input.mime,
      bytes: input.bytes,
      filename: input.filename ?? null,
      ip: input.ip ?? null,
    })
    .run();
}

/**
 * 这条链接是谁传的。
 *
 * 审核用：一张图出现在帖子里时，转帖的人和上传的人往往不是同一个，
 * 而链接本身不带任何身份信息 —— 没有这个查询，
 * 「谁传的」这个问题就没有答案。
 */
export function uploaderOf(url: string) {
  return db
    .select({ userId: uploads.userId, createdAt: uploads.createdAt, ip: uploads.ip })
    .from(uploads)
    .where(eq(uploads.url, url))
    .orderBy(uploads.createdAt)
    .get();
}

/** 我最近传过的。给编辑器里的「最近上传」用，省得同一张图传两遍 */
export function myRecentUploads(userId: string, limit = 12) {
  return db
    .select({
      url: uploads.url,
      kind: uploads.kind,
      filename: uploads.filename,
      createdAt: uploads.createdAt,
    })
    .from(uploads)
    .where(eq(uploads.userId, userId))
    .orderBy(desc(uploads.createdAt))
    .limit(limit)
    .all();
}
