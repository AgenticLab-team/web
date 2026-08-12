import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db, sqlite } from "@/lib/db";
import { segmentForIndex } from "@/lib/db/fts";
import { dailyStats, groups, messages, syncCursors } from "@/lib/db/schema";
import { nekobot } from "@/lib/nekobot/client";
import type { UpstreamMessage } from "@/lib/nekobot/types";
import { ingestMessages, type IngestMessage } from "@/lib/links/ingest";
import {
  insertMentions,
  loadRoster,
  notifyMentionedUsers,
  parseInteractions,
  type MentionNotifyInput,
} from "@/lib/messages/interactions";
import { isQualityMessage } from "@/lib/quality";
import { scanMessages } from "@/lib/radar/engine";
import { isModuleEnabled } from "@/lib/modules/state";
import { getSettingInt } from "@/lib/settings/store";
import { dateKey } from "@/lib/time";
import { creditedWxId } from "@/lib/stats/authorship";
import { resolveBotWxId } from "@/lib/stats/bot-identity";
import { onBehalfAuthors } from "@/lib/stats/on-behalf";

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
    /*
     * 模块关掉时**明确报出来**，而不是安静地返回 0 条。
     * 「同步了 0 条」和「同步没在跑」在日志里长得一模一样，
     * 而后者意味着整站的数据从此刻起就停在这里了。
     */
    if (!isModuleEnabled("sync")) {
      throw new Error("消息同步模块已关闭 —— 在 /admin/modules 打开");
    }

    /*
     * 机器人自己是谁。整轮同步问一次上游 ——
     * 统计要在事务里跑，那里不能打外网。
     *
     * 取不到就是 null，那时候什么都不排除：宁可榜上多一个机器人，
     * 也不能因为猜错把一个真人抹掉。
     */
    const botWxId = await resolveBotWxId();

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
    /*
     * 这一轮碰过哪些「人 × 天」。
     *
     * **已经存在的消息也要记进来** —— 那正是漏计数的来源：
     * 消息写进去之后、统计落库之前那一轮失败了，重跑时它因为
     * 主键冲突被跳过，于是永远不会被计入。
     *
     * 记的是键不是计数：落库那一步会拿这些键从消息表重算，
     * 所以「碰过」就够了，多记几天只是多算一次，不会算错。
     */
    const touched = new Set<string>();

    /*
     * 这一轮里哪些消息是代发的：msg_svr_id → 那个成员的 wx_id。
     *
     * 整轮查一次而不是逐条查 —— 代发是很少的（一天几十条封顶），
     * 而消息是几千条，逐条查等于给每条消息加一次 join。
     */
    const onBehalf = onBehalfAuthors(convId);

    /*
     * 名册整轮同步取一次。@昵称 必须在**落库这一刻**解析成 wx_id ——
     * 昵称随时会变，等展示时再解析，同一句话过三个月就指向别人了。
     * 名册比消息旧几分钟没关系：刚改的昵称对不上时如实标 unknown，
     * 下一轮回填能纠正；反过来逐条查名册会把同步拖慢一个数量级。
     */
    const roster = loadRoster(convId);

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
      const mentionNotifies: MentionNotifyInput[] = [];

      db.transaction((tx) => {
        for (const msg of page) {
          const quality = isQualityMessage(msg, qualityMin);
          const interactions = parseInteractions(
            msg.content,
            msg.type,
            roster,
            msg.create_time,
          );
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
              replyToId: interactions.replyToId,
            })
            .onConflictDoNothing()
            .run();

          /*
           * 不管是不是新写的，都记下它那一天要重算。
           *
           * 放在 `changes === 0` 判断**之前** —— 放后面的话，
           * 一条上一轮写进去、没来得及统计的消息，
           * 这一轮会被跳过，那个缺口就永远补不上了。
           */
          /*
           * 记的是**算谁头上**，不是谁发的。
           *
           * 代发消息的 sender 是机器人，而它该算给那个被授权的成员 ——
           * 按 sender 记的话，那个成员的桶永远不会被重算，
           * 于是他替群里发的三十条通知一条都不算在他头上。
           *
           * 机器人自己说的话返回 null，直接不记 —— 它不是成员。
           */
          const credited = creditedWxId({
            senderWxId: msg.sender_wx_id,
            onBehalfOfWxId: onBehalf.get(msg.msg_svr_id) ?? null,
            botWxId,
          });
          if (!msg.is_send && credited) {
            touched.add(bucketKey(credited, dateKey(msg.create_time)));
          }
          if (msg.create_time > maxTs) maxTs = msg.create_time;

          if (result.changes === 0) continue;
          written++;

          /*
           * 提及行必须和消息本体同一个事务：消息靠主键冲突去重，
           * 一旦「消息写进去了、提及没写」，下一轮同步会把这条消息
           * 当成已存在直接跳过 —— 漏掉的提及从此没有机会补上
           * （除非手动重跑回填）。
           */
          if (interactions.mentions.length > 0) {
            insertMentions(
              tx,
              { id: msg.msg_svr_id, convId: msg.conv_id, ts: msg.create_time },
              interactions.mentions,
            );
            if (!msg.is_send) {
              mentionNotifies.push({
                messageId: msg.msg_svr_id,
                convId: msg.conv_id,
                convName: msg.conv_name,
                messageTs: msg.create_time,
                senderWxId: msg.sender_wx_id,
                senderName: msg.sender_name,
                content: msg.content,
                mentions: interactions.mentions,
              });
            }
          }

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

        // 关键词雷达同理：附属功能不该有能力弄坏主链路
        try {
          scanMessages(freshlyWritten);
        } catch (error) {
          console.error("关键词雷达扫描失败（不影响消息同步）：", error);
        }
      }

      // @提及 通知同理放在事务外：提及行是数据（已随消息落库），通知只是提醒
      if (mentionNotifies.length > 0) {
        try {
          notifyMentionedUsers(mentionNotifies);
        } catch (error) {
          console.error("@提及通知失败（不影响消息同步）：", error);
        }
      }
    }

    flushDailyStats(convId, touched, botWxId);

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
/**
 * 把这一轮碰过的那些「人 × 天」重新算一遍。
 *
 * ─────────────────────────────────────────
 * 从累加改成重算
 * ─────────────────────────────────────────
 *
 * 原来是「这一轮新写了 N 条 → 在原数字上 +N」。累加有一个
 * **注定会发生**的漏洞：消息写进去之后、统计落库之前那一轮失败了，
 * 重跑时消息因为主键冲突被跳过（`changes === 0` → `continue`），
 * 于是那几条**永远不会被计入**。
 *
 * 这不是假想：线上对照下来，`daily_stats` 比 `messages` 少 26 条，
 * 14 个人的数字对不上 —— 而榜单是按这张表排的。
 *
 * 而这些数字**完全可以从 messages 推导**（存储裁剪只清正文、不删行）。
 * 所以改成：记下这一轮碰过哪些天，然后拿那几天重算。
 *
 * 重算是**幂等**的 —— 同一轮跑两遍、失败之后重跑，结果都一样。
 * 累加做不到这一点，而做不到的代价是一个没人看得出来的慢性偏差。
 */
/**
 * 「算谁头上」在 SQL 这一侧的实现。
 *
 * ═════════════════════════════════════════
 * 它必须和 `creditedWxId()` 说同一句话
 * ═════════════════════════════════════════
 *
 * 采集那一步用 TS 那个纯函数决定「重算哪些人 × 天」，
 * 这里用 SQL 决定「重算时哪些消息算数」。两边一旦分叉，
 * 表现是**榜单数字对不上而没有任何地方报错** ——
 * 这个仓库已经因为 daily_stats 和 messages 对不上吃过一次亏。
 *
 * 所以两处的口径写在一起，并且有测试拿同一批输入对照两边的结论。
 *
 * `ok = 1`：只有真的发出去了才算。失败的代发在 api_sends 里也留了痕
 * （限流要数它），但群里根本没出现过那条消息。
 */
const CREDITED_JOIN = sql`
  LEFT JOIN api_sends s ON s.msg_svr_id = m.id AND s.ok = 1
  LEFT JOIN users u ON u.id = s.user_id`;

/**
 * 这条消息算在 `wxId` 头上吗。
 *
 * `COALESCE(u.wx_id, m.sender_wx_id)` 就是纯函数里那句「代发优先」。
 * 机器人那一条排除写在外面而不是塞进 COALESCE ——
 * 塞进去的话，代发消息会先被机器人这一条判掉，
 * 而那正是要救回来的那些（顺序在纯函数里也是同一个理由）。
 */
function creditedIs(wxId: string, botWxId: string | null) {
  const credited = sql`COALESCE(u.wx_id, m.sender_wx_id)`;
  if (!botWxId) return sql`${credited} = ${wxId}`;
  return sql`${credited} = ${wxId} AND NOT (s.id IS NULL AND m.sender_wx_id = ${botWxId})`;
}

export function flushDailyStats(convId: string, touched: Set<string>, botWxId: string | null = null) {
  if (touched.size === 0) return;

  db.transaction((tx) => {
    for (const key of touched) {
      const [wxId, date] = key.split(BUCKET_KEY_SEP);

      /*
       * 直接从消息表算。
       *
       * `is_send = 0` —— 机器人自己的消息不进榜也不计分，
       * 这条口径必须和采集那一侧一致，否则重算会把它们算进来。
       */
      const row = tx
        .all<{
          messages: number;
          quality: number;
          chars: number;
          firstAt: number;
          lastAt: number;
        }>(
          sql`SELECT count(*) AS messages,
                     sum(m.is_quality) AS quality,
                     sum(m.length) AS chars,
                     min(m.ts) AS firstAt,
                     max(m.ts) AS lastAt
              FROM messages m
              ${CREDITED_JOIN}
              WHERE m.conv_id = ${convId}
                AND ${creditedIs(wxId, botWxId)}
                AND m.is_send = 0
                AND date(m.ts / 1000, 'unixepoch', '+8 hours') = ${date}`,
        )[0];

      if (!row || !row.messages) continue;

      /*
       * 小时分布同样重算。
       *
       * 东八区：日期边界和 `dateKey` 一直是按东八区切的，
       * 这里少加 8 小时的话，凌晨那几条会落到前一天，
       * 而那种错要等到有人盯着热力图才看得出来。
       */
      const hourRows = tx.all<{ h: number; n: number }>(
        sql`SELECT CAST(strftime('%H', m.ts / 1000, 'unixepoch', '+8 hours') AS INTEGER) AS h,
                   count(*) AS n
            FROM messages m
            ${CREDITED_JOIN}
            WHERE m.conv_id = ${convId}
              AND ${creditedIs(wxId, botWxId)}
              AND m.is_send = 0
              AND date(m.ts / 1000, 'unixepoch', '+8 hours') = ${date}
            GROUP BY h`,
      );
      const hours = new Array(24).fill(0);
      for (const h of hourRows) hours[h.h] = Number(h.n);

      tx.insert(dailyStats)
        .values({
          wxId,
          convId,
          date,
          messages: Number(row.messages),
          qualityMessages: Number(row.quality ?? 0),
          charsTotal: Number(row.chars ?? 0),
          firstMsgAt: Number(row.firstAt),
          lastMsgAt: Number(row.lastAt),
          hourHistogram: hours,
        })
        .onConflictDoUpdate({
          target: [dailyStats.wxId, dailyStats.convId, dailyStats.date],
          // 重算 = 覆盖，不是累加
          set: {
            messages: Number(row.messages),
            qualityMessages: Number(row.quality ?? 0),
            charsTotal: Number(row.chars ?? 0),
            firstMsgAt: Number(row.firstAt),
            lastMsgAt: Number(row.lastAt),
            hourHistogram: hours,
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
