/**
 * 数据库备份。
 *
 * 用 SQLite 的在线备份 API，不是 cp —— WAL 模式下直接复制文件会拿到
 * 不一致的快照（主库文件与 -wal 未合并），恢复时可能缺最近的写入。
 *
 * 保留策略：7 份每日 + 4 份每周。压缩后一份约几 MB，占不了多少地方。
 *
 *   npm run backup
 *   npm run backup -- --verify   备份后校验能否打开并读出关键表
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";

const DB_PATH = resolve(process.env.DB_PATH ?? "./data/agenticlab.db");
const BACKUP_DIR = resolve(process.env.BACKUP_DIR ?? "./data/backups");
const DAILY_KEEP = 7;
const WEEKLY_KEEP = 4;

function stamp(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`数据库不存在：${DB_PATH}`);
    process.exit(1);
  }
  mkdirSync(BACKUP_DIR, { recursive: true });

  const now = new Date();
  // 周日的备份额外标记为 weekly，走不同的保留期
  const kind = now.getDay() === 0 ? "weekly" : "daily";
  const target = join(BACKUP_DIR, `agenticlab-${kind}-${stamp(now)}.db`);

  const source = new Database(DB_PATH, { readonly: true });
  await source.backup(target);
  source.close();

  // 校验：备份文件必须能打开且完整性检查通过，否则等于没备份
  const check = new Database(target, { readonly: true });
  const integrity = check.pragma("integrity_check", { simple: true });
  const counts = {
    messages: (check.prepare("SELECT count(*) n FROM messages").get() as { n: number }).n,
    people: (check.prepare("SELECT count(*) n FROM people").get() as { n: number }).n,
    users: (check.prepare("SELECT count(*) n FROM users").get() as { n: number }).n,
  };
  check.close();

  // 只读打开也会生成 -shm/-wal，不清掉会跟备份文件一起堆在目录里
  for (const suffix of ["-shm", "-wal"]) {
    const stray = `${target}${suffix}`;
    if (existsSync(stray)) unlinkSync(stray);
  }

  if (integrity !== "ok") {
    console.error(`备份完整性检查失败：${integrity}`);
    unlinkSync(target);
    process.exit(1);
  }

  execFileSync("gzip", ["-f", target]);
  const gz = `${target}.gz`;
  const size = statSync(gz).size;

  console.log(
    `✓ ${gz.split("/").pop()}  ${(size / 1048576).toFixed(1)} MB  ` +
      `消息 ${counts.messages} · 成员 ${counts.people} · 账号 ${counts.users}`,
  );

  prune("daily", DAILY_KEEP);
  prune("weekly", WEEKLY_KEEP);
}

function prune(kind: string, keep: number) {
  const files = readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith(`agenticlab-${kind}-`) && f.endsWith(".gz"))
    .sort()
    .reverse();
  for (const file of files.slice(keep)) {
    unlinkSync(join(BACKUP_DIR, file));
    console.log(`  清理旧备份 ${file}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
