import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import Database from "better-sqlite3";

import { stripComments as strip } from "./_source";

/**
 * 恢复演练。
 *
 * ─────────────────────────────────────────
 * 从来没有人把它恢复回来过
 * ─────────────────────────────────────────
 *
 * 备份每天都在跑，`integrity_check` 也过。而**「能打开」和
 * 「恢复得回来」是两件事**：
 *
 *   · 一份只备到一半的库，完整性检查照样过
 *   · 一份只有十条消息的库，非空、完整、毫无用处
 *
 * 站里本来就有恢复演练，但它**只对异地备份跑** —— 而异地还没配。
 * 也就是说线上每天生成的那几份备份，到今天为止
 * 没有一份被证明过是能用的。
 *
 * 一个从没恢复过的备份不是备份，是一种心理安慰。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("真库", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "al-drill-"));
  process.env.DB_PATH = join(tmp, "live.db");
  process.env.NEKOBOT_API_KEY = "nk_test";

  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { localRestoreDrill } = await import("@/lib/backup/drill");

  after(() => rmSync(tmp, { recursive: true, force: true }));

  /** 现库里放 10 个账号，当作「真实规模」 */
  for (let i = 0; i < 10; i++) {
    dbm.db.insert(schema.users).values({ id: `u${i}`, wxId: `wx${i}`, status: "active" }).run();
  }

  const backupDir = mkdtempSync(join(tmpdir(), "al-drill-backups-"));
  after(() => rmSync(backupDir, { recursive: true, force: true }));

  /** 造一份备份：一个真的 SQLite 库，压成 .db.gz */
  function makeBackup(name: string, userCount: number, corrupt = false) {
    const path = join(backupDir, `${name}.db`);
    const b = new Database(path);
    b.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    b.exec("CREATE TABLE messages (id TEXT PRIMARY KEY)");
    b.exec("CREATE TABLE forum_posts (id TEXT PRIMARY KEY)");
    b.exec("CREATE TABLE points_ledger (id TEXT PRIMARY KEY)");
    for (let i = 0; i < userCount; i++) b.prepare("INSERT INTO users VALUES (?)").run(`u${i}`);
    b.close();
    const raw = corrupt ? Buffer.from("这不是一个 SQLite 文件") : readFileSync(path);
    writeFileSync(join(backupDir, `${name}.db.gz`), gzipSync(raw));
    rmSync(path);
  }

  /** 每个用例从一个空的备份目录开始 —— 上一个用例造的文件会影响「最新那份是谁」 */
  const clear = () => {
    rmSync(backupDir, { recursive: true, force: true });
    mkdirSync(backupDir, { recursive: true });
  };

  it("**一个备份都没有时如实说**", () => {
    clear();
    const r = localRestoreDrill(backupDir);
    assert.equal(r.ok, false);
    assert.match(r.note, /一个 \.db\.gz 都没有/);
  });

  it("规模相当的备份 —— 通过", () => {
    clear();
    makeBackup("good", 10);
    const r = localRestoreDrill(backupDir);
    assert.equal(r.ok, true, r.note);
    assert.equal(r.counts.find((c) => c.table === "users")?.backup, 10);
  });

  it("**全空的备份不算通过** —— 它会顺利通过完整性检查", () => {
    clear();
    makeBackup("empty", 0);
    const r = localRestoreDrill(backupDir);
    assert.equal(r.ok, false);
    assert.match(r.note, /关键表全是空的/);
  });

  it("**备到一半的不算通过** —— 磁盘写满时最容易发生", () => {
    /*
     * 只判非空的话，一份因为磁盘写满而截断的备份照样能过 ——
     * 而那正是最需要备份的时候最容易发生的事。
     */
    clear();
    makeBackup("thin", 2); // 现库 10 个，只备到 2 个
    const r = localRestoreDrill(backupDir);
    assert.equal(r.ok, false);
    assert.match(r.note, /备到一半/);
  });

  it("差一点点不报警 —— 一天之内本来就会有增量", () => {
    clear();
    makeBackup("slightly-behind", 8);
    assert.equal(localRestoreDrill(backupDir).ok, true);
  });

  it("**压根不是数据库的文件要报失败，不能抛出去**", () => {
    // 抛出去的话整个备份任务会红，而本机那份其实已经写好了
    clear();
    makeBackup("garbage", 0, true);
    const r = localRestoreDrill(backupDir);
    assert.equal(r.ok, false);
    assert.ok(r.note.length > 0);
  });

  it("**演练用的临时文件要删掉** —— 那是一份完整的库拷贝", () => {
    clear();
    makeBackup("good", 10);
    const leftovers = () =>
      readdirSync(process.env.TMPDIR ?? "/tmp").filter((f) => f.startsWith("agenticlab-drill-"))
        .length;
    const before = leftovers();
    localRestoreDrill(backupDir);
    assert.equal(leftovers(), before, "演练完在 /tmp 里留下了一份没人管的数据库拷贝");
  });

  it("演练的是**最新**那一份", () => {
    clear();
    makeBackup("old", 10);
    makeBackup("new", 10);
    const r = localRestoreDrill(backupDir);
    // mtime 更新的那个是 new
    assert.equal(r.file, "new.db.gz");
  });
});

describe("接线", () => {
  const script = strip(readFileSync(new URL("../scripts/backup.ts", import.meta.url), "utf8"));

  it("挂在备份任务里", () => {
    assert.match(script, /localRestoreDrill\(BACKUP_DIR/);
  });

  it("**每次都演，不是隔几天演一次**", () => {
    /*
     * 它只要几秒（解压 + 打开 + 四次 count），
     * 而「上一次证明它能用是什么时候」这个问题的答案越新越好。
     */
    const step = script.slice(script.indexOf('name: "本机演练"'));
    assert.equal(/drillDue/.test(step.slice(0, 400)), false, "本机演练也被加了到期判断");
  });

  it("**不是致命步骤** —— 演练失败不该把已经写好的备份判成失败", () => {
    const step = script.slice(script.indexOf('name: "本机演练"'));
    assert.match(step.slice(0, 200), /critical: false/);
  });

  it("结果记进 backup_runs，后台才看得到", () => {
    assert.match(script, /recordDrill\(outcome, startedAt\)/);
    assert.match(strip(src("lib/backup/record.ts")), /kind: "drill"/);
  });

  it("**本机和异地记在同一张表** —— 分开的话异地配好之前那一栏永远是空的", () => {
    const rec = strip(src("lib/backup/record.ts"));
    assert.match(rec, /scope: "local"/);
  });

  it("后台把「上一次证明它能用是什么时候」显示出来了", () => {
    const page = strip(src("app/(app)/admin/backup/page.tsx"));
    assert.match(page, /恢复演练/);
    assert.match(page, /scope\?: string/);
  });

  it("**失败时能看到上一次成功是什么时候**", () => {
    // 「一直没成功过」和「昨天还好好的」是两种处境
    assert.match(strip(src("app/(app)/admin/backup/page.tsx")), /lastLocalOk/);
  });
});
