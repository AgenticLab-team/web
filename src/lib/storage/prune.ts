import "server-only";

import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import { sqlite } from "@/lib/db";
import { getSettingBool, getSettingInt } from "@/lib/settings/store";
import { nekobot } from "@/lib/nekobot/client";
import { pruneApiUsage } from "@/lib/upstream/usage";
import {
  DEFAULT_TIER_CONFIG,
  EMPTY_PREVIEW,
  estimateFtsBytes,
  isIndexable,
  tierBoundaries,
  validateTierConfig,
  type PrunePreview,
  type TierConfig,
} from "@/lib/storage/tiers";

/**
 * 存储分层裁剪。
 *
 * ─────────────────────────────────────────
 * 顺序就是安全性
 * ─────────────────────────────────────────
 *
 *   ① 改层 —— 只写 tier 列，随时可以再算一遍
 *   ② 退索引 —— 正文还在本地，重建索引就能复原
 *   ③ 丢正文 —— 不可逆，必须先归档成文件才允许发生
 *
 * 每一步都独立提交。中途失败时前面做完的那些**是有效的**，
 * 而不是回滚成「什么都没发生」—— 裁剪是幂等的，再跑一次会接着做完，
 * 但归档文件已经写下去的字节不能假装没写。
 *
 * ─────────────────────────────────────────
 * 为什么不信「需要时回源」
 * ─────────────────────────────────────────
 *
 * 上游自己也只有约两个月的历史（机器人才跑了两个月）。
 * 在能证明它保留一年之前，「删了还能拉回来」是**猜测**，
 * 而基于猜测删掉的聊天记录没有第二次机会。
 * verifyUpstreamRetention() 就是把这个猜测变成一次真实的抽样检验。
 */

export function loadTierConfig(): TierConfig {
  return {
    hotDays: getSettingInt("storage.hot_days", DEFAULT_TIER_CONFIG.hotDays),
    warmDays: getSettingInt("storage.warm_days", DEFAULT_TIER_CONFIG.warmDays),
    coldKeepQualityOnly: getSettingBool(
      "storage.cold_keep_quality_only",
      DEFAULT_TIER_CONFIG.coldKeepQualityOnly,
    ),
    archiveBeforeDrop: getSettingBool("storage.archive_before_drop", true),
  };
}

// ── 预览 ────────────────────────────────────────────────────

/**
 * 执行前的影响预估。
 *
 * 数字必须是**真的会发生的那些**：已经退过索引的不再计入 unindex，
 * 已经丢过正文的不再计入 drop。否则预览会一轮比一轮大，
 * 而管理员会以为裁剪根本没生效。
 */
export function previewPrune(config: TierConfig, now = Date.now()): PrunePreview {
  const { warmBefore, coldBefore } = tierBoundaries(now, config);

  const retier =
    (
      sqlite
        .prepare(
          `SELECT count(*) n FROM messages
           WHERE (ts < ? AND ts >= ? AND tier != 'warm')
              OR (ts < ? AND tier != 'cold')
              OR (ts >= ? AND tier != 'hot')`,
        )
        .get(warmBefore, coldBefore, coldBefore, warmBefore) as { n: number }
    ).n;

  /*
   * 会从搜索里消失的：过了热层、不是高质量、但索引还在。
   * 高质量消息在任何层都保留索引 —— 它们是这个社群真正沉淀下来的东西。
   */
  const unindexRow = sqlite
    .prepare(
      `SELECT count(*) n, COALESCE(SUM(length(content)), 0) bytes
       FROM messages
       WHERE ts < ? AND is_quality = 0 AND indexed = 1`,
    )
    .get(warmBefore) as { n: number; bytes: number };

  const dropRow = config.coldKeepQualityOnly
    ? (sqlite
        .prepare(
          `SELECT count(*) n, COALESCE(SUM(length(content)), 0) bytes
           FROM messages
           WHERE ts < ? AND is_quality = 0 AND content != ''`,
        )
        .get(coldBefore) as { n: number; bytes: number })
    : { n: 0, bytes: 0 };

  const span = sqlite
    .prepare(
      `SELECT MIN(ts) oldest, MAX(ts) newest FROM messages
       WHERE ts < ? AND is_quality = 0`,
    )
    .get(warmBefore) as { oldest: number | null; newest: number | null };

  return {
    retier,
    unindex: unindexRow.n,
    drop: dropRow.n,
    dropBytes: dropRow.bytes,
    unindexBytes: estimateFtsBytes(unindexRow.bytes),
    oldestTs: span.oldest,
    newestTs: unindexRow.n + dropRow.n > 0 ? span.newest : null,
  };
}

// ── 回源验证 ────────────────────────────────────────────────

export interface RetentionCheck {
  ok: boolean;
  sampled: number;
  found: number;
  /** 上游能回溯到的最早时间；null = 问不出来 */
  upstreamOldestTs: number | null;
  reason: string;
}

/**
 * 抽样验证「删了还能从上游拉回来」。
 *
 * 随机抽几条**即将被丢正文的**消息，按它们的时间窗回查上游，
 * 看 id 还在不在。命中率不够就拒绝执行 —— 宁可占着磁盘，
 * 也不能拿一次猜测去换用户两年前的聊天记录。
 *
 * 上游不可达时返回 ok:false 且 reason 说明是「问不到」而不是「没有」——
 * 这两者的区别就是这个项目一直在防的那种伪装。
 */
export async function verifyUpstreamRetention(
  config: TierConfig,
  now = Date.now(),
  sampleSize = 8,
): Promise<RetentionCheck> {
  const { coldBefore } = tierBoundaries(now, config);

  const sample = sqlite
    .prepare(
      `SELECT id, conv_id, ts FROM messages
       WHERE ts < ? AND is_quality = 0 AND content != ''
       ORDER BY ts LIMIT ?`,
    )
    .all(coldBefore, sampleSize) as { id: string; conv_id: string; ts: number }[];

  if (sample.length === 0) {
    return {
      ok: true,
      sampled: 0,
      found: 0,
      upstreamOldestTs: null,
      reason: "没有会被丢正文的消息，不需要验证",
    };
  }

  let found = 0;
  let upstreamOldestTs: number | null = null;
  try {
    // 上游最早能回溯到什么时候 —— 这一条比命中率更能说明问题
    const earliest = await nekobot.messages({ order: "asc", limit: 1 });
    upstreamOldestTs = earliest.items[0]?.create_time ?? null;

    for (const msg of sample) {
      const page = await nekobot.messages({
        conv_id: msg.conv_id,
        start_ms: msg.ts - 1000,
        end_ms: msg.ts + 1000,
        limit: 50,
      });
      if (page.items.some((item) => item.msg_svr_id === msg.id)) found++;
    }
  } catch (error) {
    return {
      ok: false,
      sampled: sample.length,
      found,
      upstreamOldestTs,
      reason: `问不到上游（${error instanceof Error ? error.message : String(error)}）—— 「问不到」不等于「上游没有」，但也不能当成「上游有」`,
    };
  }

  const rate = found / sample.length;
  if (rate < 1) {
    return {
      ok: false,
      sampled: sample.length,
      found,
      upstreamOldestTs,
      reason: `抽查 ${sample.length} 条，上游只回得出 ${found} 条 —— 「需要时回源」这个前提不成立`,
    };
  }

  return {
    ok: true,
    sampled: sample.length,
    found,
    upstreamOldestTs,
    reason: `抽查 ${sample.length} 条全部能从上游回查到`,
  };
}

// ── 归档 ────────────────────────────────────────────────────

export function archiveDir(): string {
  return resolve(process.env.ARCHIVE_DIR ?? "./data/archive");
}

export interface ArchiveResult {
  file: string;
  rows: number;
  bytes: number;
}

/**
 * 把即将被丢正文的消息按月写成 gzip 的 NDJSON。
 *
 * 用 NDJSON 而不是 SQL dump：一行一条，`zcat | grep` 就能查，
 * 不需要把整个文件读进内存，也不依赖任何一个特定版本的 schema。
 * 出事的时候能用最土的工具打开，比格式漂亮重要。
 */
export async function archiveMonth(
  monthKey: string,
  rows: { id: string; conv_id: string; sender_wx_id: string; sender_name: string | null; type: string; content: string; ts: number }[],
): Promise<ArchiveResult> {
  const dir = archiveDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `messages-${monthKey}.ndjson.gz`);

  /*
   * 同一个月可能分几次裁剪 —— 追加而不是覆盖。
   * 覆盖会让第二次裁剪把第一次归档的内容抹掉，
   * 而文件还在、大小还在，看不出少了东西。
   */
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
  await pipeline(
    Readable.from([body]),
    createGzip(),
    createWriteStream(file, { flags: "a" }),
  );

  return { file, rows: rows.length, bytes: existsSync(file) ? statSync(file).size : 0 };
}

function monthKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ── 执行 ────────────────────────────────────────────────────

export interface PruneResult {
  retiered: number;
  unindexed: number;
  dropped: number;
  archived: ArchiveResult[];
  bytesBefore: number;
  bytesAfter: number;
  /** 被拒绝执行的部分与原因 —— 空字符串表示全做完了 */
  skipped: string;
  /**
   * 清掉的上游调用流水行数。
   *
   * 和消息分层是两件事，混在 `dropped` 里会让「丢了多少条正文」
   * 这个最要紧的数字变得不可信 —— 那个数字是不可逆操作的计数，
   * 不能掺进任何别的东西。
   */
  usageRows: number;
}

export interface PruneOptions {
  config?: TierConfig;
  now?: number;
  /** 跳过不可逆的那一步，只做改层与退索引 */
  reversibleOnly?: boolean;
  /** 已经验证过回源就传进来，避免重复打上游 */
  retention?: RetentionCheck;
}

export async function runPrune(options: PruneOptions = {}): Promise<PruneResult> {
  const config = options.config ?? loadTierConfig();
  const now = options.now ?? Date.now();

  const problems = validateTierConfig(config);
  if (problems.length > 0) {
    throw new Error(`分层配置讲不通，拒绝执行：${problems.join("；")}`);
  }

  const { warmBefore, coldBefore } = tierBoundaries(now, config);
  const bytesBefore = dbBytes();

  // ① 改层 —— 只写标记，零风险
  const retiered =
    sqlite
      .prepare(`UPDATE messages SET tier = 'hot' WHERE ts >= ? AND tier != 'hot'`)
      .run(warmBefore).changes +
    sqlite
      .prepare(`UPDATE messages SET tier = 'warm' WHERE ts < ? AND ts >= ? AND tier != 'warm'`)
      .run(warmBefore, coldBefore).changes +
    sqlite
      .prepare(`UPDATE messages SET tier = 'cold' WHERE ts < ? AND tier != 'cold'`)
      .run(coldBefore).changes;

  // ② 退索引 —— 正文还在，重建就能复原
  const unindexTargets = sqlite
    .prepare(`SELECT id FROM messages WHERE ts < ? AND is_quality = 0 AND indexed = 1`)
    .all(warmBefore) as { id: string }[];

  const deleteFts = sqlite.prepare(`DELETE FROM messages_fts WHERE msg_id = ?`);
  const markUnindexed = sqlite.prepare(`UPDATE messages SET indexed = 0 WHERE id = ?`);
  const unindexAll = sqlite.transaction((ids: { id: string }[]) => {
    for (const row of ids) {
      deleteFts.run(row.id);
      markUnindexed.run(row.id);
    }
  });
  unindexAll(unindexTargets);

  const result: PruneResult = {
    retiered,
    unindexed: unindexTargets.length,
    dropped: 0,
    archived: [],
    bytesBefore,
    bytesAfter: bytesBefore,
    skipped: "",
    usageRows: 0,
  };

  // ③ 丢正文 —— 不可逆，最后做，且要过两道门
  if (!config.coldKeepQualityOnly) {
    result.skipped = "配置为冷层保留全部正文，没有丢弃步骤";
  } else if (options.reversibleOnly) {
    result.skipped = "本次只做可逆步骤（改层、退索引）";
  } else {
    const gate = await dropGate(config, now, options.retention);
    if (!gate.ok) {
      result.skipped = gate.reason;
    } else {
      const dropped = await dropColdContent(coldBefore);
      result.dropped = dropped.rows;
      result.archived = dropped.archived;
    }
  }

  /*
   * 顺手裁掉上游调用流水。
   *
   * 同步任务每几分钟跑一次，这张表长得比谁都快；而它的价值窗口很短 ——
   * 没有人会关心三个月前某一次调用的耗时。
   *
   * 放在这里而不是单开一个定时器：它和分层裁剪要回答的是同一个问题
   * （「库为什么这么大」），分开两处的结果是有一处永远没人记得跑。
   *
   * 这一步**无条件执行**，不受 reversibleOnly 影响 ——
   * 删一行运维流水不是不可逆操作，它没有任何东西可丢。
   */
  result.usageRows = pruneApiUsage(now);

  result.bytesAfter = dbBytes();
  return result;
}

/**
 * 丢正文之前的两道门。
 *
 * 归档成文件 **或** 抽样证明上游回得来 —— 有一个就行，两个都没有就不动。
 * 「都没有」的时候返回的是拒绝的理由，不是一个安静的 0。
 */
async function dropGate(
  config: TierConfig,
  now: number,
  retention?: RetentionCheck,
): Promise<{ ok: boolean; reason: string }> {
  if (config.archiveBeforeDrop) return { ok: true, reason: "归档已开启" };

  const check = retention ?? (await verifyUpstreamRetention(config, now));
  if (check.ok) return { ok: true, reason: check.reason };

  return {
    ok: false,
    reason: `没有归档，且${check.reason}。正文一条都没动 —— 磁盘占着总比记录没了强`,
  };
}

async function dropColdContent(
  coldBefore: number,
): Promise<{ rows: number; archived: ArchiveResult[] }> {
  const targets = sqlite
    .prepare(
      `SELECT id, conv_id, sender_wx_id, sender_name, type, content, ts
       FROM messages
       WHERE ts < ? AND is_quality = 0 AND content != ''
       ORDER BY ts`,
    )
    .all(coldBefore) as {
    id: string;
    conv_id: string;
    sender_wx_id: string;
    sender_name: string | null;
    type: string;
    content: string;
    ts: number;
  }[];

  if (targets.length === 0) return { rows: 0, archived: [] };

  // 按月分文件：一个月一个包，恢复时不用解开全部历史
  const byMonth = new Map<string, typeof targets>();
  for (const row of targets) {
    const key = monthKeyOf(row.ts);
    const list = byMonth.get(key);
    if (list) list.push(row);
    else byMonth.set(key, [row]);
  }

  const archived: ArchiveResult[] = [];
  for (const [month, rows] of byMonth) {
    /*
     * 先归档，成功了再删。
     * 反过来的话，归档写失败时正文已经没了 —— 而这一步是不可逆的。
     */
    archived.push(await archiveMonth(month, rows));
  }

  const clear = sqlite.prepare(`UPDATE messages SET content = '' WHERE id = ?`);
  const clearAll = sqlite.transaction((ids: string[]) => {
    for (const id of ids) clear.run(id);
  });
  clearAll(targets.map((t) => t.id));

  return { rows: targets.length, archived };
}

function dbBytes(): number {
  return (
    (sqlite.prepare(`SELECT COALESCE(SUM(pgsize), 0) n FROM dbstat`).get() as { n: number }).n ?? 0
  );
}

// ── 重建索引（退索引的反向操作）─────────────────────────────

/**
 * 把某段时间的消息重新放回 FTS 索引。
 *
 * 存在这个函数，退索引才算「可逆」—— 不然「正文还在，重建就行」
 * 只是一句话，没人验证过它真的能做到。
 */
export function reindexRange(fromTs: number, toTs: number): number {
  const rows = sqlite
    .prepare(
      `SELECT id, conv_id, sender_wx_id, type, content FROM messages
       WHERE ts >= ? AND ts < ? AND indexed = 0 AND content != ''`,
    )
    .all(fromTs, toTs) as {
    id: string;
    conv_id: string;
    sender_wx_id: string;
    type: string;
    content: string;
  }[];

  const insert = sqlite.prepare(
    `INSERT INTO messages_fts (msg_id, conv_id, sender_wx_id, content) VALUES (?, ?, ?, ?)`,
  );
  const mark = sqlite.prepare(`UPDATE messages SET indexed = 1 WHERE id = ?`);

  let done = 0;
  const run = sqlite.transaction(() => {
    for (const row of rows) {
      if (!isIndexable(row.type, row.content)) continue;
      insert.run(row.id, row.conv_id, row.sender_wx_id, row.content);
      mark.run(row.id);
      done++;
    }
  });
  run();
  return done;
}

export { EMPTY_PREVIEW };

/**
 * 正文完整可信的时间下界：晚于这个时刻的正文一条都没少。
 *
 * 返回 null 表示从没丢过东西 —— 没有下界就是全都在。
 *
 * 需要重建某一天完整聊天记录的地方（群聊沉淀、补签核对）必须看这个值：
 * 裁剪过的日子拿到的是**残缺的一天**，而残缺的一天和冷清的一天
 * 在结果里长得一模一样。
 */
export function fullContentSince(): number | null {
  const dropped = sqlite
    .prepare(`SELECT MAX(ts) n FROM messages WHERE content = ''`)
    .get() as { n: number | null };
  return dropped.n;
}
