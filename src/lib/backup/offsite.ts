import "server-only";

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { and, desc, eq } from "drizzle-orm";

import {
  expiredRemotely,
  missingConfigKeys,
  missingRemotely,
  needsDrill,
  offsiteStatus,
  readConfig,
  statusDetail,
  type LocalFile,
  type OffsiteConfig,
  type OffsiteState,
} from "@/lib/backup/rules";
import { S3Client, md5Hex } from "@/lib/backup/s3";
import { db } from "@/lib/db";
import { backupRuns } from "@/lib/db/schema";
import { archiveDir } from "@/lib/storage/prune";

/**
 * 异地备份。
 *
 * ─────────────────────────────────────────
 * 三个「不能假装」
 * ─────────────────────────────────────────
 *
 *   ① 没配置就不是「成功 0 个」——
 *      那是「异地备份根本没有在做」，必须显示成故障而不是正常
 *   ② 上传返回 200 不等于对面有那个文件 ——
 *      传完要**读回来对哈希**
 *   ③ 有文件不等于恢复得了 ——
 *      恢复演练真的下载、解压、打开、数行
 *
 * 归档文件（冷层正文）也一起传。它是那些正文的**唯一**副本 ——
 * 比数据库备份更不能只放在一块磁盘上。
 */

export function backupDir(): string {
  return resolve(process.env.BACKUP_DIR ?? "./data/backups");
}

export function loadOffsiteConfig(): OffsiteConfig | null {
  return readConfig(process.env);
}

export interface OffsiteResult {
  ok: boolean;
  status: string;
  uploaded: number;
  verified: number;
  deleted: number;
  bytes: number;
  error?: string;
  note: string;
}

function localFiles(): { file: LocalFile; path: string; remoteKey: string }[] {
  const out: { file: LocalFile; path: string; remoteKey: string }[] = [];

  for (const [dir, sub] of [
    [backupDir(), "backups/"],
    [archiveDir(), "archive/"],
  ] as const) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".gz")) continue;
      const path = join(dir, name);
      out.push({
        file: { name: `${sub}${name}`, size: statSync(path).size },
        path,
        remoteKey: `${sub}${name}`,
      });
    }
  }
  return out;
}

/**
 * 传一轮：把本地有、远端没有（或大小对不上）的文件传上去，传完读回来对哈希。
 */
export async function syncOffsite(now = Date.now()): Promise<OffsiteResult> {
  const config = loadOffsiteConfig();

  if (!config) {
    const missing = missingConfigKeys(process.env);
    const note = `异地备份没有配置（缺 ${missing.join("、")}）—— 备份和归档都只在服务器这一块磁盘上`;
    record({ kind: "upload", status: "skipped", error: note, startedAt: now });
    return { ok: false, status: "unconfigured", uploaded: 0, verified: 0, deleted: 0, bytes: 0, note };
  }

  const startedAt = now;
  const client = new S3Client(config);

  try {
    const locals = localFiles();
    const remote = await client.list(config.prefix);
    const missing = missingRemotely(
      locals.map((l) => l.file),
      remote,
      config.prefix,
    );

    let uploaded = 0;
    let verified = 0;
    let bytes = 0;

    for (const target of missing) {
      const local = locals.find((l) => l.file.name === target.name);
      if (!local) continue;

      const body = readFileSync(local.path);
      const key = `${config.prefix}${local.remoteKey}`;
      await client.put(key, body);
      uploaded++;
      bytes += body.length;

      /*
       * 立刻读回来对哈希。
       *
       * 「PUT 返回 200」只证明请求没报错 —— 对象被截断、写进了别的桶、
       * 或者服务端静默丢弃，这些都不会让上传这一步失败。
       * 而备份的意义完全取决于对面那份字节是不是真的一样。
       */
      const back = await client.get(key);
      if (!back || md5Hex(back) !== md5Hex(body)) {
        throw new Error(
          `${local.remoteKey} 传上去了但读回来对不上（本地 ${body.length} 字节，读回 ${back?.length ?? 0} 字节）`,
        );
      }
      verified++;
    }

    // 远端保留策略比本地多留一份 —— 少留一份的代价是某天想要的刚好昨天被清了
    const doomed = expiredRemotely(remote, { daily: 7, weekly: 4 }, `${config.prefix}backups/`);
    for (const obj of doomed) await client.delete(obj.key);

    const note =
      uploaded === 0
        ? `远端已经有全部 ${locals.length} 个文件，没有新的要传`
        : `传了 ${uploaded} 个文件（${(bytes / 1048576).toFixed(1)} MB），全部读回校验通过`;

    record({
      kind: uploaded > 0 ? "upload" : "verify",
      status: "success",
      files: uploaded,
      bytes,
      startedAt,
      detail: { remoteTotal: remote.length, deleted: doomed.length },
    });

    return { ok: true, status: "ok", uploaded, verified, deleted: doomed.length, bytes, note };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record({ kind: "upload", status: "failed", error: message, startedAt });
    return {
      ok: false,
      status: "failing",
      uploaded: 0,
      verified: 0,
      deleted: 0,
      bytes: 0,
      error: message,
      note: `异地备份失败：${message}`,
    };
  }
}

export interface DrillResult {
  ok: boolean;
  key?: string;
  counts?: Record<string, number>;
  note: string;
}

/**
 * 恢复演练：从远端下载最新的一份备份，解压、打开、数行。
 *
 * **没演练过的备份只是一堆字节。** 真要用的时候才发现打不开，
 * 那时候原库已经没了 —— 这是唯一能提前发现这件事的办法。
 *
 * 演练用的是远端那份，不是本地那份：本地那份能打开
 * 完全不能说明传上去的那份能打开。
 */
export async function restoreDrill(now = Date.now()): Promise<DrillResult> {
  const config = loadOffsiteConfig();
  if (!config) return { ok: false, note: "异地备份没有配置，无从演练" };

  const startedAt = now;
  const client = new S3Client(config);
  const tmpPath = join(
    process.env.TMPDIR ?? "/tmp",
    `agenticlab-drill-${startedAt}.db`,
  );

  try {
    const objects = await client.list(`${config.prefix}backups/`);
    const latest = objects
      .filter((o) => o.key.endsWith(".db.gz"))
      .sort((a, b) => b.key.localeCompare(a.key))[0];
    if (!latest) throw new Error("远端一个备份文件都没有");

    const gz = await client.get(latest.key);
    if (!gz) throw new Error(`${latest.key} 列出来了但下载不到`);

    const raw = gunzipSync(gz);
    const { writeFileSync, unlinkSync } = await import("node:fs");
    writeFileSync(tmpPath, raw);

    try {
      const restored = new Database(tmpPath, { readonly: true });
      const integrity = restored.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new Error(`完整性检查没过：${integrity}`);

      const counts: Record<string, number> = {};
      for (const table of ["messages", "users", "points_ledger", "forum_posts"]) {
        counts[table] = (
          restored.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }
        ).n;
      }
      restored.close();

      // 一份能打开但空的库同样是灾难，而它会通过完整性检查
      if (counts.messages === 0 && counts.users === 0) {
        throw new Error("备份打得开，但消息和账号都是空的 —— 这不是一份有用的备份");
      }

      record({
        kind: "drill",
        status: "success",
        files: 1,
        bytes: gz.length,
        startedAt,
        detail: { key: latest.key, counts },
      });

      return {
        ok: true,
        key: latest.key,
        counts,
        note: `${latest.key.split("/").pop()} 下载解压打开成功 · 消息 ${counts.messages} · 账号 ${counts.users}`,
      };
    } finally {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record({ kind: "drill", status: "failed", error: message, startedAt });
    return { ok: false, note: `恢复演练失败：${message}` };
  }
}

function record(input: {
  kind: "upload" | "verify" | "drill";
  status: "success" | "failed" | "skipped";
  files?: number;
  bytes?: number;
  detail?: unknown;
  error?: string;
  startedAt: number;
}) {
  db.insert(backupRuns)
    .values({
      kind: input.kind,
      status: input.status,
      files: input.files ?? 0,
      bytes: input.bytes ?? 0,
      detail: input.detail ?? null,
      error: input.error,
      startedAt: input.startedAt,
      finishedAt: Date.now(),
    })
    .run();
}

// ── 状态 ────────────────────────────────────────────────────

function lastSuccessAt(kind: "upload" | "verify" | "drill"): number | null {
  const row = db
    .select({ at: backupRuns.finishedAt })
    .from(backupRuns)
    .where(and(eq(backupRuns.kind, kind), eq(backupRuns.status, "success")))
    .orderBy(desc(backupRuns.createdAt))
    .get();
  return row?.at ?? null;
}

export function offsiteState(): OffsiteState {
  const configured = loadOffsiteConfig() !== null;

  const lastRun = db
    .select()
    .from(backupRuns)
    .orderBy(desc(backupRuns.createdAt))
    .get();

  const upload = lastSuccessAt("upload");
  const verify = lastSuccessAt("verify");

  return {
    configured,
    /*
     * 「最近一次成功上传」要把 verify 也算进去 ——
     * 没有新文件时这一轮记的是 verify，但那同样证明远端是最新的。
     */
    lastUploadAt: maxOrNull(upload, verify),
    lastVerifiedAt: maxOrNull(upload, verify),
    lastDrillAt: lastSuccessAt("drill"),
    lastError: lastRun?.status === "failed" ? (lastRun.error ?? "未知错误") : null,
  };
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

export interface OffsiteSummary {
  state: OffsiteState;
  status: ReturnType<typeof offsiteStatus>;
  detail: string;
  drillDue: boolean;
  missingKeys: string[];
  recent: (typeof backupRuns.$inferSelect)[];
  localFiles: { name: string; bytes: number; modifiedAt: number }[];
}

export function offsiteSummary(now = Date.now()): OffsiteSummary {
  const state = offsiteState();
  return {
    state,
    status: offsiteStatus(state, now),
    detail: statusDetail(state, now),
    drillDue: needsDrill(state, now),
    missingKeys: missingConfigKeys(process.env),
    recent: db.select().from(backupRuns).orderBy(desc(backupRuns.createdAt)).limit(10).all(),
    localFiles: localFiles().map((l) => ({
      name: l.file.name,
      bytes: l.file.size,
      modifiedAt: statSync(l.path).mtimeMs,
    })),
  };
}
