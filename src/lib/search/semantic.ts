import "server-only";

import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { groups, messageWindows, messages, people } from "@/lib/db/schema";
import { LlmNotConfigured, embed } from "@/lib/llm/client";
import { visibleGroupIds } from "@/lib/queries/visibility";
import { resolveDisplayName } from "@/lib/users/display-name";

import {
  blobToVector,
  buildWindows,
  cosine,
  vectorToBlob,
  windowKey,
  type MessageWindow,
} from "./windows";

/**
 * 语义检索：按会话窗口。
 *
 * ─────────────────────────────────────────
 * 权限收口和 FTS 那条路是同一套
 * ─────────────────────────────────────────
 *
 * `search/messages.ts` 的文件头写着：「只能搜自己所在的群，
 * 且在 SQL 层就限制，不是查出来再过滤。搜索是最容易绕过权限的入口 ——
 * 只要能搜到只言片语，私密内容就已经泄露了。」
 *
 * 语义检索更要守这条，因为它天然是「全库打分再排序」的形状 ——
 * 顺手写成先算分后过滤，看起来结果也对，
 * 而**耗时会随着不可见内容的多少变化**，那本身就是一条侧信道。
 *
 * 所以 conv_id 冗余存在 message_windows 上，在 SQL 里就把范围切掉。
 */

export interface SemanticHit {
  windowId: string;
  convId: string;
  groupName: string;
  startTs: number;
  endTs: number;
  score: number;
  /** 这一段里的消息，命中后展开给人看 */
  messages: { id: string; senderName: string; content: string; ts: number }[];
}

export interface SemanticResult {
  hits: SemanticHit[];
  /** 可见范围为空 —— 用来区分「没搜到」和「没权限」 */
  noAccess: boolean;
  /** 还没嵌过的段数；大于 0 时结果是不完整的，要如实说 */
  pending: number;
  error: string | null;
}

/**
 * 低于这个分的不返回。
 *
 * ─────────────────────────────────────────
 * 这个数字是量出来的
 * ─────────────────────────────────────────
 *
 * 语义检索**总能**算出个最相似的，哪怕毫不相干 ——
 * 所以必须有个地板。第一版拍了 0.35，上线一测才发现它形同虚设:
 * 拿这个社区从没聊过的话题去搜，照样每条都返回 5 个结果。
 *
 * 在生产语料上量了两组:
 *
 *   没聊过的话题（噪音）  红烧肉 39% · 小提琴调音 47% · 宋朝科举 50% · 南极企鹅 52%
 *   真聊过的话题（信号）  部署工具 57% · 招人 62% · 封号 66% · 台风 69%
 *
 * 噪音最高 52%、信号最低 57%，中间这条缝就是门槛该待的地方。
 * 定在 0.55:上面四个查询一条都不返回，下面四个一条不少。
 *
 * 换嵌入模型之后这个数字要重新量 —— 不同模型的相似度分布完全不同，
 * 照搬会让门槛要么形同虚设、要么把真结果全挡掉。
 */
export const MIN_SCORE = 0.55;

/**
 * 切段并写进库（不嵌入）。
 *
 * 和嵌入分开是因为两者的失败方式不同：切段是纯本地计算、不会失败；
 * 嵌入要打网络、要花钱、会超时。混在一起的话，
 * 一次网络抖动会让这一批消息**连段都没切**，下次还得从头来。
 */
export function rebuildWindows(options: { since?: number } = {}): {
  scanned: number;
  created: number;
} {
  const rows = db
    .select({
      id: messages.id,
      convId: messages.convId,
      ts: messages.ts,
      content: messages.content,
      senderWxId: messages.senderWxId,
    })
    .from(messages)
    .where(
      options.since
        ? and(eq(messages.type, "text"), gt(messages.ts, options.since))
        : eq(messages.type, "text"),
    )
    /*
     * 必须按 (convId, ts) 排 —— buildWindows 不自己排序，
     * 顺序不对时它会抛。那是刻意的：调用方拿错了数据的话，
     * 替它兜住只会把错误藏起来。
     */
    .orderBy(asc(messages.convId), asc(messages.ts))
    .all();

  const nameCache = new Map<string, string>();
  const nameOf = (wxId: string | null): string => {
    if (!wxId) return "某人";
    const cached = nameCache.get(wxId);
    if (cached) return cached;
    const p = db.select().from(people).where(eq(people.wxId, wxId)).get();
    const name = p ? resolveDisplayName([p.displayName], { wxId, fallback: "某人" }) : "某人";
    nameCache.set(wxId, name);
    return name;
  };

  const windows = buildWindows(
    rows.map((r) => ({
      id: r.id,
      convId: r.convId,
      ts: r.ts,
      senderName: nameOf(r.senderWxId),
      content: r.content ?? "",
    })),
  );

  let created = 0;
  for (const w of windows) {
    const key = windowKey(w);
    const existing = db
      .select({ id: messageWindows.id })
      .from(messageWindows)
      .where(eq(messageWindows.windowKey, key))
      .get();

    /*
     * 已经有了就跳过，**连文本也不更新**。
     *
     * 更新文本而不清空向量的话，那一段的向量就和文本对不上了 ——
     * 而检索结果只是「略微不准」，不会有任何报错。
     * 群聊消息不会被编辑，所以已存在的段本来也不该变。
     */
    if (existing) continue;

    db.insert(messageWindows)
      .values({
        windowKey: key,
        convId: w.convId,
        startTs: w.startTs,
        endTs: w.endTs,
        messageCount: w.messageIds.length,
        messageIds: JSON.stringify(w.messageIds),
        text: w.text,
      })
      .run();
    created++;
  }

  return { scanned: rows.length, created };
}

/** 一次送几段去嵌入 —— 太大容易撞上接口的输入上限，太小则来回太多次 */
const EMBED_BATCH = 32;

export interface EmbedReport {
  pending: number;
  embedded: number;
  failed: number;
  notes: string[];
}

/** 把还没嵌过的段嵌了 */
export async function embedPendingWindows(limit = 500): Promise<EmbedReport> {
  const report: EmbedReport = { pending: 0, embedded: 0, failed: 0, notes: [] };

  const pending = db
    .select()
    .from(messageWindows)
    .where(isNull(messageWindows.embeddedAt))
    .orderBy(desc(messageWindows.endTs))
    .limit(limit)
    .all();

  report.pending = pending.length;

  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const batch = pending.slice(i, i + EMBED_BATCH);
    try {
      const result = await embed(
        batch.map((w) => w.text),
        { timeoutMs: 120_000 },
      );

      const now = Date.now();
      for (let j = 0; j < batch.length; j++) {
        const vector = result.vectors[j];
        db.update(messageWindows)
          .set({
            vector: vectorToBlob(vector),
            model: result.model,
            dimensions: vector.length,
            embeddedAt: now,
          })
          .where(eq(messageWindows.id, batch[j].id))
          .run();
        report.embedded++;
      }
      invalidateVectorCache();
    } catch (error) {
      report.failed += batch.length;
      if (error instanceof LlmNotConfigured) {
        report.notes.push(error.message);
        break;
      }
      report.notes.push(error instanceof Error ? error.message : String(error));
    }
  }

  return report;
}

/**
 * 向量缓存。
 *
 * 3,506 段 × 1024 维 = 14 MB，整份放内存里。每次检索都从 SQLite
 * 读一遍 14 MB 也不是不行，但那会让检索的耗时被 IO 主导，
 * 而这条路的意义就在于「快到可以边打字边看结果」。
 *
 * 用行数 + 最后嵌入时间当版本号：两者任一变了就重载。
 * 比「写入时手动清缓存」可靠 —— 手动清总会有人忘记加，
 * 而忘记的表现是**搜不到刚同步进来的内容**，很难联想到缓存。
 */
let cache: { stamp: string; rows: { id: string; convId: string; vector: Float32Array }[] } | null =
  null;

export function invalidateVectorCache() {
  cache = null;
}

function vectorStamp(): string {
  const row = db
    .select({
      n: sql<number>`count(*)`,
      last: sql<number>`coalesce(max(${messageWindows.embeddedAt}), 0)`,
    })
    .from(messageWindows)
    .where(sql`${messageWindows.embeddedAt} is not null`)
    .get();
  return `${row?.n ?? 0}:${row?.last ?? 0}`;
}

function loadVectors() {
  const stamp = vectorStamp();
  if (cache?.stamp === stamp) return cache.rows;

  const rows = db
    .select({
      id: messageWindows.id,
      convId: messageWindows.convId,
      vector: messageWindows.vector,
    })
    .from(messageWindows)
    .where(sql`${messageWindows.vector} is not null`)
    .all();

  cache = {
    stamp,
    rows: rows
      .filter((r): r is typeof r & { vector: Buffer } => r.vector != null)
      .map((r) => ({ id: r.id, convId: r.convId, vector: blobToVector(r.vector) })),
  };
  return cache.rows;
}

/**
 * 语义检索。
 *
 * **可见性在打分之前就切掉** —— 不是算完再筛。
 */
export async function semanticSearch(
  user: CurrentUser | null,
  query: string,
  limit = 10,
): Promise<SemanticResult> {
  const empty: SemanticResult = { hits: [], noAccess: false, pending: 0, error: null };

  const visible = visibleGroupIds(user);
  if (visible.length === 0) return { ...empty, noAccess: true };
  if (!query.trim()) return empty;

  const pending =
    db
      .select({ n: sql<number>`count(*)` })
      .from(messageWindows)
      .where(isNull(messageWindows.embeddedAt))
      .get()?.n ?? 0;

  let queryVector: Float32Array;
  try {
    const result = await embed([query.trim()], { timeoutMs: 20_000 });
    queryVector = result.vectors[0];
  } catch (error) {
    /*
     * 嵌入不可用时**如实说**，不要退回成关键词搜索假装正常 ——
     * 那会让人以为「语义搜索就这水平」，而真正的问题是它根本没跑。
     */
    return {
      ...empty,
      pending,
      error:
        error instanceof LlmNotConfigured
          ? "语义检索还没配好嵌入模型"
          : `嵌入模型现在调不通：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const visibleSet = new Set(visible);
  const scored: { id: string; score: number }[] = [];

  for (const row of loadVectors()) {
    // 先按可见的群切掉，再算分
    if (!visibleSet.has(row.convId)) continue;
    if (row.vector.length !== queryVector.length) continue;
    const score = cosine(queryVector, row.vector);
    if (score >= MIN_SCORE) scored.push({ id: row.id, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  if (top.length === 0) return { ...empty, pending };

  const windows = db
    .select()
    .from(messageWindows)
    .where(
      inArray(
        messageWindows.id,
        top.map((t) => t.id),
      ),
    )
    .all();

  const groupNames = new Map(
    db
      .select({ convId: groups.convId, name: groups.name })
      .from(groups)
      .all()
      .map((g) => [g.convId, g.name]),
  );

  const byId = new Map(windows.map((w) => [w.id, w]));
  const hits: SemanticHit[] = [];

  for (const { id, score } of top) {
    const w = byId.get(id);
    if (!w) continue;

    const ids = JSON.parse(w.messageIds) as string[];
    const rows = db
      .select({
        id: messages.id,
        content: messages.content,
        ts: messages.ts,
        senderWxId: messages.senderWxId,
      })
      .from(messages)
      .where(inArray(messages.id, ids))
      .orderBy(asc(messages.ts))
      .all();

    hits.push({
      windowId: w.id,
      convId: w.convId,
      groupName: groupNames.get(w.convId) ?? w.convId,
      startTs: w.startTs,
      endTs: w.endTs,
      score,
      messages: rows.map((m) => {
        const p = m.senderWxId
          ? db.select().from(people).where(eq(people.wxId, m.senderWxId)).get()
          : null;
        return {
          id: m.id,
          senderName: p
            ? resolveDisplayName([p.displayName], { wxId: m.senderWxId, fallback: "某人" })
            : "某人",
          content: m.content ?? "",
          ts: m.ts,
        };
      }),
    });
  }

  return { hits, noAccess: false, pending, error: null };
}

/** 语义索引现在建到什么程度 —— 后台要显示 */
export function semanticProgress(): { total: number; embedded: number; pending: number } {
  const row = db
    .select({
      total: sql<number>`count(*)`,
      embedded: sql<number>`sum(case when ${messageWindows.embeddedAt} is not null then 1 else 0 end)`,
    })
    .from(messageWindows)
    .get();
  const total = row?.total ?? 0;
  const embedded = row?.embedded ?? 0;
  return { total, embedded, pending: total - embedded };
}

/** 用于测试与切段脚本 */
export type { MessageWindow };
