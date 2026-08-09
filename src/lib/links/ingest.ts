import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db, sqlite } from "@/lib/db";
import { linkMentions, links, messages } from "@/lib/db/schema";
import { contextFor, displayTitle, extractUrls, normalizeUrl } from "@/lib/links/extract";
import { env } from "@/lib/env";
import { isModuleEnabled } from "@/lib/modules/state";

/**
 * 把消息里的链接收进资源库。
 *
 * 同步每写一批消息就跑一次，另外有个回填脚本处理存量。
 *
 * **幂等**是硬要求：回填会被反复运行（改了抽取规则就要重跑一次），
 * 而不幂等的表现是 shareCount 每跑一次翻一倍 ——
 * 页面上「被分享 64 次」看起来还挺热闹，其实是跑了六遍。
 */

export interface IngestResult {
  scanned: number;
  created: number;
  mentions: number;
  skipped: number;
}

function selfHosts(): string[] {
  try {
    return [new URL(env.site.url).hostname.replace(/^www\./, "")];
  } catch {
    return [];
  }
}

export interface IngestMessage {
  id: string;
  convId: string;
  content: string;
  ts: number;
  senderWxId: string | null;
  senderName: string | null;
  type: string;
}

/** 只有文字类消息里才会有链接 */
const LINKABLE_TYPES = new Set(["text", "quote"]);

export function ingestMessages(rows: IngestMessage[]): IngestResult {
  const result: IngestResult = { scanned: 0, created: 0, mentions: 0, skipped: 0 };
  // 模块关掉时**不再收录新的**，已收录的照常可见 ——
  // 关一个模块是「先别再长了」，不是「把过去删掉」
  if (!isModuleEnabled("links")) return result;

  const hosts = selfHosts();

  db.transaction(() => {
    for (const row of rows) {
      if (!LINKABLE_TYPES.has(row.type)) continue;
      const urls = extractUrls(row.content);
      if (urls.length === 0) continue;
      result.scanned++;

      for (const raw of urls) {
        const normalized = normalizeUrl(raw, hosts);
        if (!normalized) {
          result.skipped++;
          continue;
        }

        const existing = db
          .select()
          .from(links)
          .where(eq(links.urlKey, normalized.key))
          .get();

        let linkId: string;
        if (existing) {
          linkId = existing.id;
        } else {
          linkId = db
            .insert(links)
            .values({
              urlKey: normalized.key,
              url: normalized.url,
              domain: normalized.domain,
              title: displayTitle(normalized.url, normalized.domain),
              note: contextFor(row.content, raw),
              shareCount: 0,
              firstSharedAt: row.ts,
              lastSharedAt: row.ts,
            })
            .returning({ id: links.id })
            .get().id;
          result.created++;
        }

        /*
         * 同一条消息里的同一个链接只记一次。
         * 靠唯一索引挡，不靠「先查再写」—— 回填和实时同步可能同时在跑。
         */
        const inserted = db
          .insert(linkMentions)
          .values({
            linkId,
            convId: row.convId,
            messageId: row.id,
            sharerWxId: row.senderWxId,
            sharerName: row.senderName,
            sharedAt: row.ts,
          })
          .onConflictDoNothing()
          .run();

        if (inserted.changes === 0) continue;
        result.mentions++;

        /*
         * 计数与时间戳从 mentions 现算，而不是 +1。
         *
         * +1 的话，回填一次就多一次，而**没有任何办法看出来多了** ——
         * 这张表上没有第二个地方能对账。
         */
        recountLink(linkId);
      }
    }
  });

  return result;
}

/** 用 link_mentions 重算冗余列 —— 冗余列的真值永远在明细里 */
export function recountLink(linkId: string): void {
  const stats = sqlite
    .prepare(
      `SELECT count(*) n, MIN(shared_at) first, MAX(shared_at) last
       FROM link_mentions WHERE link_id = ?`,
    )
    .get(linkId) as { n: number; first: number | null; last: number | null };

  if (stats.n === 0) {
    // 没有任何分享记录的链接不该留在库里
    db.delete(links).where(eq(links.id, linkId)).run();
    return;
  }

  db.update(links)
    .set({
      shareCount: stats.n,
      firstSharedAt: stats.first ?? Date.now(),
      lastSharedAt: stats.last ?? Date.now(),
    })
    .where(eq(links.id, linkId))
    .run();
}

/**
 * 回填存量消息。
 *
 * 可以反复跑：唯一索引挡住重复的 mention，计数每次都从明细现算。
 */
export function backfillLinks(options: { since?: number; limit?: number } = {}): IngestResult {
  const rows = db
    .select({
      id: messages.id,
      convId: messages.convId,
      content: messages.content,
      ts: messages.ts,
      senderWxId: messages.senderWxId,
      senderName: messages.senderName,
      type: messages.type,
    })
    .from(messages)
    .where(
      and(
        sql`${messages.content} LIKE '%http%'`,
        options.since ? sql`${messages.ts} >= ${options.since}` : undefined,
      ),
    )
    .limit(options.limit ?? 100_000)
    .all();

  return ingestMessages(rows);
}

/**
 * 按当前规则重算所有标题。
 *
 * 标题是存下来的，改了 displayTitle 之后**存量行不会自己变** ——
 * 那正是「代码改好了但线上还是旧样子」最常见的来源。
 * 改规则之后跑一次 `npm run links -- --retitle`。
 */
export function retitleAll(): number {
  const rows = db.select().from(links).all();
  let changed = 0;
  db.transaction(() => {
    for (const row of rows) {
      const title = displayTitle(row.url, row.domain);
      if (title === row.title) continue;
      db.update(links).set({ title }).where(eq(links.id, row.id)).run();
      changed++;
    }
  });
  return changed;
}

/**
 * 对账：冗余的 shareCount 和明细行数对不对得上。
 *
 * 对不上说明有地方在直接改计数而没走 recountLink ——
 * 而「被分享 64 次」这种数字没人会怀疑，除非有东西去查它。
 */
export function auditLinkCounts(): { linkId: string; stored: number; actual: number }[] {
  return sqlite
    .prepare(
      `SELECT l.id AS linkId, l.share_count AS stored, COUNT(m.id) AS actual
       FROM links l LEFT JOIN link_mentions m ON m.link_id = l.id
       GROUP BY l.id HAVING stored != actual`,
    )
    .all() as { linkId: string; stored: number; actual: number }[];
}
