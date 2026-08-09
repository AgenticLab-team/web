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
 *   npm run backup -- --local    只做本机快照，不推异地
 *
 * 备完立刻推异地 —— **一份只存在本机的备份不算备份完了**。
 * 分成两个独立的定时任务的话，第二个挂掉之后第一个还在每天报成功，
 * 而那正是「备份一直在成功」的经典形态。
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

  if (process.argv.includes("--local")) return;

  /*
   * 推异地与恢复演练**不算致命**。
   *
   * 「本机备份没做成」和「异地还没配对象存储」不该是同一个信号：
   * 后者天天都会出现，如果它让备份这一轮整体标红，
   * 那第一次真的备份失败时，没有人会多看一眼。
   *
   * 到这里为止本机那份已经写好、校验过、压缩完了 ——
   * 后面这两步无论怎样都不该把它抹掉。
   */
  const { offsiteSummary, restoreDrill, syncOffsite } = await import("@/lib/backup/offsite");
  const { localRestoreDrill } = await import("@/lib/backup/drill");
  const { recordDrill } = await import("@/lib/backup/record");
  const { runSteps, summarize, tickFailureReport } = await import("@/lib/ops/tick");

  const report = await runSteps([
    {
      name: "推异地",
      critical: false,
      timeoutMs: 120_000,
      run: () => syncOffsite(),
      describe: (r: Awaited<ReturnType<typeof syncOffsite>>) => `${r.ok ? "" : "✗ "}${r.note}`,
    },
    {
      // 到期就顺手演练一次 —— 没演练过的备份只是一堆字节
      name: "异地演练",
      critical: false,
      timeoutMs: 120_000,
      run: async () => (offsiteSummary().drillDue ? restoreDrill() : null),
      describe: (r: Awaited<ReturnType<typeof restoreDrill>> | null) =>
        r ? `${r.ok ? "" : "✗ "}${r.note}` : "还不到演练时候",
    },
    {
      /*
       * 本机那一份也要演练，而且**每次都演**。
       *
       * 上面那条只对异地备份跑，而异地还没配 —— 也就是说
       * 线上每天生成的这几份备份，到今天为止没有一份被证明过是能用的。
       *
       * 「能打开」和「恢复得回来」是两件事：一份备到一半的库
       * 完整性检查照样过，一份只有十条消息的库非空、完整、毫无用处。
       *
       * 每次都演而不是隔几天演一次：它只要几秒（解压 20MB + 打开 + 四次
       * count），而「上一次证明它能用是什么时候」这个问题
       * 的答案越新越好。
       */
      name: "本机演练",
      critical: false,
      timeoutMs: 120_000,
      run: async () => {
        const startedAt = Date.now();
        const outcome = localRestoreDrill(BACKUP_DIR, startedAt);
        recordDrill(outcome, startedAt);
        return outcome;
      },
      describe: (r: { ok: boolean; note: string }) => `${r.ok ? "" : "✗ "}${r.note}`,
    },
  ] as never);

  for (const step of report.steps) {
    console.log(`${step.ok ? " " : "✗"} ${step.name.padEnd(8)} ${step.ok ? step.note : step.error}`);
  }
  console.log(`\n${summarize(report)}`);

  // 只有致命失败才退非零。异地没配好不该让备份这一轮标红
  const failure = tickFailureReport(report);
  if (failure) {
    console.error(`\n⚠ ${failure.title}：${failure.body}`);
    process.exit(1);
  }
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
