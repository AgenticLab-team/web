import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db, sqlite } from "@/lib/db";
import { segmentForIndex } from "@/lib/db/fts";
import { dailyStats, groups, messages, syncCursors } from "@/lib/db/schema";
import { nekobot } from "@/lib/nekobot/client";
import type { UpstreamMessage } from "@/lib/nekobot/types";
import { ingestMessages, type IngestMessage } from "@/lib/links/ingest";
import { isQualityMessage } from "@/lib/quality";
import { getSettingInt } from "@/lib/settings/store";
import { dateKey, hourOf } from "@/lib/time";

import { runSyncJob, type SyncOptions, type SyncResult } from "./job";


const MEDIA_TYPES = new Set(["image", "video", "file", "voice", "sticker", "so_gou_emoji"]);

const insertFts = sqlite.prepare(
  `INSERT INTO messages_fts (msg_id, conv_id, sender_wx_id, content) VALUES (?, ?, ?, ?)`,
);
const deleteFts = sqlite.prepare(`DELETE FROM messages_fts WHERE msg_id = ?`);
const existsFts = sqlite.prepare(`SELECT 1 FROM messages_fts WHERE msg_id = ? LIMIT 1`);

/** 只索引有文字内容的消息；图片表情进索引没有意义，白占体积 */
function shouldIndex(msg: UpstreamMessage): boolean {
  return (msg.type === "text" || msg.type === "quote") && msg.content.trim().length > 0;
}

/**
 * 日统计桶的键分隔符。
 *
 * 用 NUL 而不是空格 —— wx_id 和日期都不可能含 NUL，不会误拆。
 * 但**必须写成 \u0000 转义**：直接把裸 NUL 字节放进源码后它完全不可见，
 * Read 显示成空格、编辑器匹配不上、grep 也搜不到，排查时会浪费大量时间。
 */
export const BUCKET_KEY_SEP = "\u0000";

export function bucketKey(wxId: string, date: string): string {
  return `${wxId}${BUCKET_KEY_SEP}${date}`;
}

export interface DayBucket {
  messages: number;
  qualityMessages: number;
  charsTotal: number;
  firstMsgAt: number;
  lastMsgAt: number;
  hours: number[];
}

/**
 * 增量同步一个群的消息。
 *
 * 游标基于上游 create_time。为了容忍上游写入延迟（消息可能晚于其时间戳落库），
 * 每次从游标往回退一个重叠窗口重拉，靠主键幂等去重。
 */
export async function syncGroupMessages(
  convId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  return runSyncJob("messages", { ...options, scope: convId }, async () => {
    const qualityMin = getSettingInt("sync.quality_min", 15);
    const OVERLAP_MS = 5 * 60 * 1000;

    const cursor = db
      .select()
      .from(syncCursors)
      .where(and(eq(syncCursors.kind, "messages"), eq(syncCursors.scope, convId)))
      .get();

    const startMs = cursor ? Math.max(0, cursor.lastTs - OVERLAP_MS) : undefined;

    let fetched = 0;
    let written = 0;
    let maxTs = cursor?.lastTs ?? 0;
    const buckets = new Map<string, DayBucket>();

    for await (const page of nekobot.iterateMessages({
      conv_id: convId,
      start_ms: startMs,
      order: "asc",
      include_self: false,
    })) {
      fetched += page.length;

      /*
       * 这一批里真正**新写入**的消息，交给资源库去抽链接。
       * 只收新写入的：重叠窗口每次都会重拉一段已经存在的消息，
       * 全都塞进去的话每轮同步都会做一遍无用功。
       */
      const freshlyWritten: IngestMessage[] = [];

      db.transaction((tx) => {
        for (const msg of page) {
          const quality = isQualityMessage(msg, qualityMin);
          const result = tx
            .insert(messages)
            .values({
              id: msg.msg_svr_id,
              convId: msg.conv_id,
              senderWxId: msg.sender_wx_id,
              senderName: msg.sender_name,
              isSend: msg.is_send,
              type: msg.type,
              content: msg.content,
              length: msg.length,
              isQuality: quality,
              hasMedia: MEDIA_TYPES.has(msg.type),
              ts: msg.create_time,
              tier: "hot",
              indexed: shouldIndex(msg),
            })
            .onConflictDoNothing()
            .run();

          if (result.changes === 0) continue;
          written++;
          freshlyWritten.push({
            id: msg.msg_svr_id,
            convId: msg.conv_id,
            content: msg.content,
            ts: msg.create_time,
            senderWxId: msg.sender_wx_id,
            senderName: msg.sender_name,
            type: msg.type,
          });

          if (shouldIndex(msg) && !existsFts.get(msg.msg_svr_id)) {
            insertFts.run(
              msg.msg_svr_id,
              msg.conv_id,
              msg.sender_wx_id,
              segmentForIndex(msg.content),
            );
          }

          if (msg.create_time > maxTs) maxTs = msg.create_time;

          // 只统计真人发言，机器人自己的消息不进榜也不计分
          if (msg.is_send) continue;
          const key = bucketKey(msg.sender_wx_id, dateKey(msg.create_time));
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = {
              messages: 0,
              qualityMessages: 0,
              charsTotal: 0,
              firstMsgAt: msg.create_time,
              lastMsgAt: msg.create_time,
              hours: new Array(24).fill(0),
            };
            buckets.set(key, bucket);
          }
          bucket.messages++;
          if (quality) bucket.qualityMessages++;
          bucket.charsTotal += msg.length;
          bucket.firstMsgAt = Math.min(bucket.firstMsgAt, msg.create_time);
          bucket.lastMsgAt = Math.max(bucket.lastMsgAt, msg.create_time);
          bucket.hours[hourOf(msg.create_time)]++;
        }
      });

      /*
       * 抽链接放在写消息的事务**外面**。
       *
       * 放里面的话，资源库这边任何一个意外都会把整批消息的写入一起回滚 ——
       * 而链接收录是锦上添花，消息入库是这个站的立身之本。
       * 附属功能不该有能力弄坏主链路。
       */
      if (freshlyWritten.length > 0) {
        try {
          ingestMessages(freshlyWritten);
        } catch (error) {
          console.error("资源库收录失败（不影响消息同步）：", error);
        }
      }
    }

    flushDailyStats(convId, buckets);

    db.insert(syncCursors)
      .values({ kind: "messages", scope: convId, lastTs: maxTs })
      .onConflictDoUpdate({
        target: [syncCursors.kind, syncCursors.scope],
        set: { lastTs: maxTs, updatedAt: Date.now() },
      })
      .run();

    return { fetched, written };
  });
}

/**
 * 累加写入每日统计。
 *
 * 用累加而非覆盖：一天的消息会分多次同步进来，直接覆盖会把先前批次的计数抹掉。
 * 重叠窗口重拉的消息因为主键冲突已被跳过，不会重复计数。
 */
export function flushDailyStats(convId: string, buckets: Map<string, DayBucket>) {
  if (buckets.size === 0) return;

  db.transaction((tx) => {
    for (const [key, bucket] of buckets) {
      const [wxId, date] = key.split(BUCKET_KEY_SEP);

      const existing = tx
        .select()
        .from(dailyStats)
        .where(
          and(
            eq(dailyStats.wxId, wxId),
            eq(dailyStats.convId, convId),
            eq(dailyStats.date, date),
          ),
        )
        .get();

      // 列是 json 模式，Drizzle 自己负责序列化。早期版本在冲突分支里
      // 又手动 JSON.stringify 了一次，双重编码后读回来是字符串不是数组，
      // 于是增量同步一到已存在的行就炸。这里统一按数组读写。
      const raw = existing?.hourHistogram;
      const previousHours = Array.isArray(raw) ? (raw as number[]) : new Array(24).fill(0);
      const mergedHours = previousHours.map((v, i) => v + bucket.hours[i]);

      tx.insert(dailyStats)
        .values({
          wxId,
          convId,
          date,
          messages: bucket.messages,
          qualityMessages: bucket.qualityMessages,
          charsTotal: bucket.charsTotal,
          firstMsgAt: bucket.firstMsgAt,
          lastMsgAt: bucket.lastMsgAt,
          hourHistogram: mergedHours,
        })
        .onConflictDoUpdate({
          target: [dailyStats.wxId, dailyStats.convId, dailyStats.date],
          set: {
            messages: sql`${dailyStats.messages} + ${bucket.messages}`,
            qualityMessages: sql`${dailyStats.qualityMessages} + ${bucket.qualityMessages}`,
            charsTotal: sql`${dailyStats.charsTotal} + ${bucket.charsTotal}`,
            firstMsgAt: sql`MIN(${dailyStats.firstMsgAt}, ${bucket.firstMsgAt})`,
            lastMsgAt: sql`MAX(${dailyStats.lastMsgAt}, ${bucket.lastMsgAt})`,
            hourHistogram: mergedHours,
            updatedAt: Date.now(),
          },
        })
        .run();
    }
  });
}

/** 同步所有已开启的群 */
export async function syncAllGroups(options: SyncOptions = {}): Promise<SyncResult> {
  const enabled = db.select().from(groups).where(eq(groups.syncEnabled, true)).all();

  let fetched = 0;
  let written = 0;
  const failures: string[] = [];

  for (const group of enabled) {
    try {
      const result = await syncGroupMessages(group.convId, options);
      fetched += result.fetched;
      written += result.written;
    } catch (err) {
      // 单个群失败不能拖垮整轮同步
      failures.push(`${group.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    fetched,
    written,
    note: failures.length ? `${failures.length} 个群失败：${failures.join("; ")}` : undefined,
  };
}

export function removeFromIndex(msgId: string) {
  deleteFts.run(msgId);
}
