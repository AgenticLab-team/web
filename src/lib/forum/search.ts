import "server-only";

import { db, sqlite } from "@/lib/db";
import { buildMatchExpression, segmentForIndex } from "@/lib/db/fts";
import { posts, replies } from "@/lib/db/schema";

import { canSeePost, type ViewerContext } from "./visibility";

/**
 * 论坛全文检索。
 *
 * 复用群消息那套中文方案（CJK 逐字切分 + unicode61 + 短语查询）——
 * trigram 对「鉴权」这类 2 字词完全失效，这个坑踩过一次就够了。
 *
 * **可见性在检索结果上二次收口**：FTS 表里没有可见性信息，
 * 所以先搜出候选再逐条精判。搜索是最容易绕过权限的入口 ——
 * 只要能搜到标题，私密内容就已经泄露了一半。
 */

let ensured = false;

function ensureIndex() {
  if (ensured) return;
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS forum_fts USING fts5(
      post_id UNINDEXED,
      kind UNINDEXED,
      title,
      body,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  ensured = true;
}

export function indexPost(postId: string, title: string, content: string) {
  ensureIndex();
  sqlite.prepare(`DELETE FROM forum_fts WHERE post_id = ? AND kind = 'post'`).run(postId);
  sqlite
    .prepare(`INSERT INTO forum_fts (post_id, kind, title, body) VALUES (?, 'post', ?, ?)`)
    .run(postId, segmentForIndex(title), segmentForIndex(content));
}

export function indexReply(postId: string, replyId: string, content: string) {
  ensureIndex();
  sqlite.prepare(`DELETE FROM forum_fts WHERE post_id = ? AND kind = ?`).run(postId, `reply:${replyId}`);
  sqlite
    .prepare(`INSERT INTO forum_fts (post_id, kind, title, body) VALUES (?, ?, '', ?)`)
    .run(postId, `reply:${replyId}`, segmentForIndex(content));
}

export function removeFromIndex(postId: string) {
  ensureIndex();
  sqlite.prepare(`DELETE FROM forum_fts WHERE post_id = ?`).run(postId);
}

export interface SearchHit {
  postId: string;
  title: string;
  excerpt: string | null;
  boardId: string;
  matchedInReply: boolean;
}

export function searchForum(
  viewer: ViewerContext,
  query: string,
  limit = 30,
): SearchHit[] {
  ensureIndex();
  const expr = buildMatchExpression(query);
  if (!expr) return [];

  /*
   * 标题命中权重更高：搜「鉴权」时，标题就叫「MCP 鉴权」的帖子
   * 显然比正文里顺带提了一句的更相关。bm25 的列权重从左到右。
   */
  const rows = sqlite
    .prepare(
      `SELECT post_id, kind, bm25(forum_fts, 0, 0, 10.0, 1.0) AS score
       FROM forum_fts
       WHERE forum_fts MATCH ?
       ORDER BY score
       LIMIT ?`,
    )
    .all(expr, limit * 4) as { post_id: string; kind: string; score: number }[];

  if (rows.length === 0) return [];

  // 同一帖子标题与回复都命中时只保留一条，取更相关的那次
  const bestByPost = new Map<string, { kind: string; score: number }>();
  for (const row of rows) {
    const current = bestByPost.get(row.post_id);
    if (!current || row.score < current.score) {
      bestByPost.set(row.post_id, { kind: row.kind, score: row.score });
    }
  }

  const candidates = db
    .select()
    .from(posts)
    .all()
    .filter((p) => bestByPost.has(p.id));

  const hits: SearchHit[] = [];
  for (const post of candidates) {
    // 可见性精判。搜索是最容易绕过权限的入口，这一步不能省
    const verdict = canSeePost(
      {
        visibility: post.visibility,
        visibilityRoleId: post.visibilityRoleId,
        visibilityGroupId: post.visibilityGroupId,
        authorId: post.authorId,
        status: post.status,
        fromGroupChat: post.visibilityLocked,
      },
      viewer,
    );
    if (!verdict.visible) continue;

    const best = bestByPost.get(post.id)!;
    hits.push({
      postId: post.id,
      title: post.title,
      excerpt: post.excerpt,
      boardId: post.boardId,
      matchedInReply: best.kind.startsWith("reply:"),
    });
    if (hits.length >= limit) break;
  }

  return hits;
}

/** 一次性重建索引，schema 或分词方案改动后用 */
export function rebuildIndex(): number {
  ensureIndex();
  sqlite.exec(`DELETE FROM forum_fts`);

  const allPosts = db.select().from(posts).all();
  for (const post of allPosts) {
    indexPost(post.id, post.title, post.content);
  }

  const allReplies = db.select().from(replies).all();
  for (const reply of allReplies) {
    indexReply(reply.postId, reply.id, reply.content);
  }

  return allPosts.length + allReplies.length;
}
