import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db, sqlite } from "@/lib/db";
import {
  groupMemberEvents,
  groupMembers,
  messageMentions,
  messages,
  users,
} from "@/lib/db/schema";
import { notify } from "@/lib/forum/notify";
import { messageLink } from "@/lib/messages/archive-rules";
import {
  resolveMentions,
  type MentionRecord,
  type RosterEntry,
} from "@/lib/messages/mentions";
import { extractReplyTarget } from "@/lib/messages/reply";
import { dateKey } from "@/lib/time";

/**
 * @提及 与回复关系的落库层。
 *
 * 解析规则全在 src/lib/messages/mentions.ts / reply.ts（纯函数，密集测试），
 * 这里只负责：取名册、写行、发通知、供前台查询。
 */

/** 只有这两类消息有文字正文，其余类型里出现的 @ 是描述文本不是提及 */
export const MENTIONABLE_TYPES = new Set(["text", "quote"]);

/**
 * 取一个群的解析名册。
 *
 * 包含已退群的人：老消息 @ 的可能正是后来退群的人，只认在群成员
 * 会把这些历史提及全标成 unknown。同名冲突时的取舍靠 joinedAt/leftAt。
 *
 * 曾用名从改名事件里挖：昵称随时会变，回填老消息时现名对不上，
 * 「他当时叫这个名」是唯一能把老 @ 接回人身上的证据。
 */
export function loadRoster(convId: string): RosterEntry[] {
  const members = db
    .select({
      wxId: groupMembers.wxId,
      displayName: groupMembers.displayName,
      wxName: groupMembers.wxName,
      joinedAt: groupMembers.joinedAt,
      leftAt: groupMembers.leftAt,
    })
    .from(groupMembers)
    .where(eq(groupMembers.convId, convId))
    .all();

  const renames = db
    .select({ wxId: groupMemberEvents.wxId, detail: groupMemberEvents.detail })
    .from(groupMemberEvents)
    .where(
      and(eq(groupMemberEvents.convId, convId), eq(groupMemberEvents.event, "rename")),
    )
    .all();

  const aliasMap = new Map<string, string[]>();
  for (const row of renames) {
    const from = (row.detail as { from?: unknown } | null)?.from;
    if (typeof from !== "string" || !from.trim()) continue;
    const list = aliasMap.get(row.wxId) ?? [];
    if (!list.includes(from)) list.push(from);
    aliasMap.set(row.wxId, list);
  }

  return members.map((m) => ({ ...m, aliases: aliasMap.get(m.wxId) ?? [] }));
}

export interface ParsedInteractions {
  replyToId: string | null;
  mentions: MentionRecord[];
}

export function parseInteractions(
  content: string,
  type: string,
  roster: RosterEntry[],
  ts: number,
): ParsedInteractions {
  if (!MENTIONABLE_TYPES.has(type) || content === "") {
    return { replyToId: null, mentions: [] };
  }
  return {
    replyToId: extractReplyTarget(content),
    mentions: resolveMentions(content, roster, ts),
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 写入一条消息的提及行。调用方决定事务边界 ——
 * 同步链路里必须和消息本体同一个事务：消息主键冲突即跳过，
 * 提及行漏写就永远漏了（下一轮同步看到消息已存在，不会再补）。
 */
export function insertMentions(
  tx: Tx | typeof db,
  msg: { id: string; convId: string; ts: number },
  mentions: MentionRecord[],
): void {
  for (const m of mentions) {
    tx.insert(messageMentions)
      .values({
        messageId: msg.id,
        convId: msg.convId,
        ts: msg.ts,
        name: m.name,
        status: m.status,
        wxId: m.wxId,
        candidates: m.candidates.length > 0 ? m.candidates : null,
        position: m.position,
      })
      // 同步与回填并发时靠 (message_id, position) 唯一索引去重
      .onConflictDoNothing()
      .run();
  }
}

export interface MentionNotifyInput {
  /** 被 @ 的那条消息的 id —— 通知要能直达它，而不只是「那一天」 */
  messageId: string;
  convId: string;
  convName: string;
  messageTs: number;
  senderWxId: string;
  senderName: string | null;
  content: string;
  mentions: MentionRecord[];
}

/**
 * 给被 @ 且绑定了账号的人发站内通知。
 *
 * 只在增量同步的新消息上调用，**回填脚本绝不能走这里** ——
 * 回填 4 万条历史会把每个人的通知箱灌满一整年前的 @。
 */
export function notifyMentionedUsers(batch: MentionNotifyInput[]): void {
  const wxIds = new Set<string>();
  for (const item of batch) {
    for (const m of item.mentions) {
      // 自己 @ 自己（转述、接龙）不值得响一声
      if (m.status === "resolved" && m.wxId && m.wxId !== item.senderWxId) {
        wxIds.add(m.wxId);
      }
    }
  }
  if (wxIds.size === 0) return;

  const bound = db
    .select({ id: users.id, wxId: users.wxId })
    .from(users)
    .where(and(inArray(users.wxId, [...wxIds]), eq(users.status, "active")))
    .all();
  if (bound.length === 0) return;

  const userByWx = new Map(bound.map((u) => [u.wxId!, u.id]));

  for (const item of batch) {
    for (const m of item.mentions) {
      if (m.status !== "resolved" || !m.wxId || m.wxId === item.senderWxId) continue;
      const userId = userByWx.get(m.wxId);
      if (!userId) continue;
      notify({
        userId,
        type: "mention",
        // 同一个群里的连环 @ 合并成一条，聊得热闹时不该刷出一串红点
        groupKey: `mention:group:${item.convId}`,
        title: `${item.senderName ?? "有人"}在「${item.convName}」@ 了你`,
        body: item.content.slice(0, 120),
        /*
         * 直达那一条，不是「那一天」。
         *
         * 原来链的是 `?group=…&date=…` —— 落到那一天之后，
         * 人要在**几千条**（真实数据里一天最多 4553 条）里
         * 自己找那一条。带上 m 之后，服务端按 id 算出页码并高亮它。
         *
         * group/date 仍然留着当兜底：那条消息的正文被存储裁剪掉之后
         * 定位不到，至少还能落到当天。
         * 日期用社区时区算 —— 服务器时区的午夜前后会链到错的一天。
         */
        link: messageLink(item.messageId, {
          convId: item.convId,
          date: dateKey(item.messageTs),
        }),
        actorName: item.senderName ?? undefined,
        refType: "message",
        refId: item.messageId,
      });
    }
  }
}

// ── 前台查询 ────────────────────────────────────────────────

export interface MentionView {
  name: string;
  status: "resolved" | "ambiguous" | "unknown" | "all";
  wxId: string | null;
  position: number;
}

/** 一批消息的提及，按消息 id 分组 —— 渲染消息流时一次取齐，不逐条查 */
export function mentionsForMessages(messageIds: string[]): Map<string, MentionView[]> {
  const out = new Map<string, MentionView[]>();
  if (messageIds.length === 0) return out;

  const rows = db
    .select({
      messageId: messageMentions.messageId,
      name: messageMentions.name,
      status: messageMentions.status,
      wxId: messageMentions.wxId,
      position: messageMentions.position,
    })
    .from(messageMentions)
    .where(inArray(messageMentions.messageId, messageIds))
    .all();

  for (const row of rows) {
    const list = out.get(row.messageId) ?? [];
    list.push(row);
    out.set(row.messageId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.position - b.position);
  return out;
}

export interface ReplyTargetView {
  id: string;
  senderWxId: string;
  senderName: string | null;
  content: string;
  type: string;
}

/** 一批被回复消息的原文，供消息流渲染引用块 */
export function replyTargetsFor(targetIds: string[]): Map<string, ReplyTargetView> {
  const out = new Map<string, ReplyTargetView>();
  if (targetIds.length === 0) return out;

  const rows = db
    .select({
      id: messages.id,
      senderWxId: messages.senderWxId,
      senderName: messages.senderName,
      content: messages.content,
      type: messages.type,
    })
    .from(messages)
    .where(inArray(messages.id, targetIds))
    .all();

  for (const row of rows) out.set(row.id, row);
  return out;
}

/** 某人在某些群里被 @ 的次数。convIds 必须是查看者的可见范围 —— 收口在调用方 */
export function mentionCountFor(wxId: string, convIds: string[]): number {
  if (convIds.length === 0) return 0;
  const placeholders = convIds.map(() => "?").join(",");
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM message_mentions
       WHERE wx_id = ? AND conv_id IN (${placeholders})`,
    )
    .get(wxId, ...convIds) as { n: number };
  return row.n;
}

export interface RecentMention {
  messageId: string;
  convId: string;
  ts: number;
  senderWxId: string;
  senderName: string | null;
  content: string;
}

/** 某人最近被 @ 的消息（限查看者可见的群） */
export function recentMentionsFor(
  wxId: string,
  convIds: string[],
  limit = 10,
): RecentMention[] {
  if (convIds.length === 0) return [];

  const placeholders = convIds.map(() => "?").join(",");
  return sqlite
    .prepare(
      `SELECT mm.message_id AS messageId, mm.conv_id AS convId, mm.ts AS ts,
              m.sender_wx_id AS senderWxId, m.sender_name AS senderName, m.content AS content
       FROM message_mentions mm
       JOIN messages m ON m.id = mm.message_id
       WHERE mm.wx_id = ? AND mm.conv_id IN (${placeholders})
         AND m.content != ''
       ORDER BY mm.ts DESC
       LIMIT ?`,
    )
    .all(wxId, ...convIds, limit) as RecentMention[];
}

// ── 回填 ────────────────────────────────────────────────────

export interface BackfillStats {
  scanned: number;
  replies: number;
  mentionRows: number;
  resolved: number;
  ambiguous: number;
  unknown: number;
  all: number;
}

/**
 * 回填一个群的历史消息。可安全重跑：
 * 每条消息的提及行先删后插，reply_to_id 直接重算覆盖 ——
 * 结果只取决于当前的正文与名册，与跑几次无关。
 *
 * 不发通知（见 notifyMentionedUsers 的说明）。
 */
export function backfillConv(convId: string, batchSize = 2000): BackfillStats {
  const stats: BackfillStats = {
    scanned: 0,
    replies: 0,
    mentionRows: 0,
    resolved: 0,
    ambiguous: 0,
    unknown: 0,
    all: 0,
  };

  const roster = loadRoster(convId);

  const selectBatch = sqlite.prepare(
    `SELECT id, conv_id AS convId, content, type, ts, reply_to_id AS replyToId
     FROM messages
     WHERE conv_id = ? AND type IN ('text','quote') AND id > ?
     ORDER BY id
     LIMIT ?`,
  );

  let cursor = "";
  for (;;) {
    const batch = selectBatch.all(convId, cursor, batchSize) as {
      id: string;
      convId: string;
      content: string;
      type: string;
      ts: number;
      replyToId: string | null;
    }[];
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    db.transaction((tx) => {
      for (const msg of batch) {
        stats.scanned++;
        const parsed = parseInteractions(msg.content, msg.type, roster, msg.ts);

        if (parsed.replyToId !== msg.replyToId) {
          tx.update(messages)
            .set({ replyToId: parsed.replyToId })
            .where(eq(messages.id, msg.id))
            .run();
        }
        if (parsed.replyToId) stats.replies++;

        // 先删后插：昵称和名册会变，重跑必须以本次解析为准，而不是叠加
        tx.delete(messageMentions).where(eq(messageMentions.messageId, msg.id)).run();
        insertMentions(tx, msg, parsed.mentions);

        for (const m of parsed.mentions) {
          stats.mentionRows++;
          stats[m.status]++;
        }
      }
    });
  }

  return stats;
}

/** 有消息的全部群（不只 sync_enabled —— 关掉同步的群历史还在，也要回填） */
export function convsWithMessages(): string[] {
  return (
    sqlite.prepare(`SELECT DISTINCT conv_id AS convId FROM messages`).all() as {
      convId: string;
    }[]
  ).map((r) => r.convId);
}

/** 被回复次数（限可见群）。今天恒为 0 —— 上游一透传引用关系就有数了 */
export function replyReceivedCountFor(wxId: string, convIds: string[]): number {
  if (convIds.length === 0) return 0;
  const placeholders = convIds.map(() => "?").join(",");
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS n
       FROM messages replied
       JOIN messages source ON source.reply_to_id = replied.id
       WHERE replied.sender_wx_id = ? AND replied.conv_id IN (${placeholders})`,
    )
    .get(wxId, ...convIds) as { n: number };
  return row.n;
}
