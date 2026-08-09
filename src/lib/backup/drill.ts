import "server-only";

import { gunzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { sqlite } from "@/lib/db";

/**
 * 恢复演练 —— 本地那一份。
 *
 * ─────────────────────────────────────────
 * 从来没有人把它恢复回来过
 * ─────────────────────────────────────────
 *
 * 备份每天都在跑，`integrity_check` 也过。而**「能打开」和
 * 「恢复得回来」是两件事**：
 *
 *   · 一份只备到一半的库，完整性检查照样过
 *   · 一份 schema 落后好几个版本的库，打得开，
 *     而今天的代码跑起来第一句查询就炸
 *   · 一份只有十条消息的库，非空、完整、毫无用处
 *
 * 站里本来就有一个恢复演练，但它**只对异地备份跑** ——
 * 而异地备份还没配。也就是说线上这几份每天生成的备份，
 * 到今天为止没有一份被证明过是能用的。
 *
 * 一个从没恢复过的备份不是备份，是一种心理安慰。
 */

export interface DrillOutcome {
  ok: boolean;
  /** 演练的是哪个文件 */
  file: string | null;
  /** 各关键表的行数：备份里 vs 现在库里 */
  counts: { table: string; backup: number; live: number }[];
  bytes: number;
  note: string;
}

/** 拿来对照的几张表 —— 它们是这个站真正的资产 */
const KEY_TABLES = ["messages", "users", "forum_posts", "points_ledger"] as const;

/**
 * 备份里的行数至少要有现库的多少。
 *
 * 演练的是**最新那一份**，最多一天前，所以两边应该接近。
 * 设 0.5 而不是 0.95：一天之内可能同步进来大批消息，
 * 卡太紧会天天报假警，而假警和没有告警是一回事。
 *
 * 真正要挡的是「备到一半」和「备了个空壳」那种数量级的差距。
 */
const MIN_RATIO = 0.5;

function newestBackup(dir: string): { path: string; name: string } | null {
  let best: { path: string; name: string; mtime: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".db.gz")) continue;
    const path = join(dir, name);
    const mtime = statSync(path).mtimeMs;
    if (!best || mtime > best.mtime) best = { path, name, mtime };
  }
  return best ? { path: best.path, name: best.name } : null;
}

/**
 * 现库里这张表有多少行。
 *
 * 走裸连接而不是 ORM：这里要拼表名，而表名来自上面那张写死的常量表，
 * ORM 那一层为此绕一圈只会让代码更难读。
 *
 * 查不到就当 0 —— 一张现库里都没有的表，
 * 不该让整场演练失败（比例检查会自动跳过 live 为 0 的表）。
 */
function liveCount(table: string): number {
  try {
    const row = sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * 把最新的一份本地备份真的恢复出来，检查它能不能用。
 *
 * 不改动任何现有数据：解压到临时文件，只读打开，用完删掉。
 */
export function localRestoreDrill(
  backupDir: string,
  now = Date.now(),
): DrillOutcome {
  const latest = newestBackup(backupDir);
  if (!latest) {
    return { ok: false, file: null, counts: [], bytes: 0, note: "备份目录里一个 .db.gz 都没有" };
  }

  const tmpPath = join(process.env.TMPDIR ?? "/tmp", `agenticlab-drill-${now}.db`);
  let bytes = 0;

  try {
    const gz = readFileSync(latest.path);
    bytes = gz.length;
    writeFileSync(tmpPath, gunzipSync(gz));

    const restored = new Database(tmpPath, { readonly: true });
    try {
      const integrity = restored.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") {
        return { ok: false, file: latest.name, counts: [], bytes, note: `完整性检查没过：${integrity}` };
      }

      const counts = KEY_TABLES.map((table) => {
        const row = restored.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number };
        return { table, backup: Number(row.n), live: liveCount(table) };
      });

      /*
       * 空的先挡 —— 一份能打开但空的库同样是灾难，
       * 而它会顺利通过完整性检查。
       */
      const allEmpty = counts.every((c) => c.backup === 0);
      if (allEmpty) {
        return { ok: false, file: latest.name, counts, bytes, note: "备份打得开，但关键表全是空的" };
      }

      /*
       * 再挡「备到一半」。
       *
       * 只判非空的话，一份因为磁盘写满而截断的备份照样能过 ——
       * 而那正是最需要备份的时候最容易发生的事。
       */
      const thin = counts.filter((c) => c.live > 0 && c.backup < c.live * MIN_RATIO);
      if (thin.length > 0) {
        const worst = thin.map((c) => `${c.table} ${c.backup}/${c.live}`).join("、");
        return {
          ok: false,
          file: latest.name,
          counts,
          bytes,
          note: `行数比现库少太多，像是备到一半：${worst}`,
        };
      }

      return {
        ok: true,
        file: latest.name,
        counts,
        bytes,
        note: `恢复成功，${counts.map((c) => `${c.table} ${c.backup}`).join(" · ")}`,
      };
    } finally {
      restored.close();
    }
  } catch (err) {
    return {
      ok: false,
      file: latest.name,
      counts: [],
      bytes,
      note: `恢复失败：${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    // 演练文件是一份完整的数据库拷贝，留在 /tmp 里既占地方也是一份没人管的副本
    try {
      unlinkSync(tmpPath);
    } catch {
      /* 已经不在就算了 */
    }
  }
}
