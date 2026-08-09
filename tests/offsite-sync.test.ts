import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import Database from "better-sqlite3";

/**
 * 异地备份的完整链路。
 *
 * 用一个假的对象存储（挂在 fetch 上）跑真的请求 ——
 * 连签名、XML 解析、分页一起测。只测纯函数的话，
 * 「签名算错」和「XML 里字段名拼错」这两类问题一个都发现不了，
 * 而它们恰好是这条链路上最容易出的。
 *
 * 重点在三条：
 *   · 没配置 → 报「根本没在做」，不是「成功 0 个」
 *   · 传完读回来对哈希 → 对面被截断/被丢弃时必须失败
 *   · 恢复演练 → 真的下载、解压、打开、数行
 */

const tmp = mkdtempSync(join(tmpdir(), "al-offsite-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.BACKUP_DIR = join(tmp, "backups");
process.env.ARCHIVE_DIR = join(tmp, "archive");
process.env.NEKOBOT_API_KEY = "nk_test";

const S3_ENV = {
  OFFSITE_S3_ENDPOINT: "https://fake.r2.example.com",
  OFFSITE_S3_BUCKET: "agenticlab",
  OFFSITE_S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
  OFFSITE_S3_SECRET_ACCESS_KEY: "secret",
  OFFSITE_S3_PREFIX: "site/",
};

type DbModule = typeof import("@/lib/db");
type Offsite = typeof import("@/lib/backup/offsite");

let dbm: DbModule;
let offsite: Offsite;
let schema: typeof import("@/lib/db/schema");

/** 假对象存储 */
let store = new Map<string, Buffer>();
/** 让 PUT 静默截断 —— 模拟「返回 200 但对面的字节不对」 */
let truncateOnPut = false;
/** 让所有请求失败 */
let s3Down = false;
/** 收到的请求，用来断言真的签了名 */
let seen: { method: string; url: string; auth: string | null }[] = [];

function fakeS3(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input.toString());
  const method = (init?.method ?? "GET").toUpperCase();
  seen.push({
    method,
    url: url.pathname + url.search,
    auth: new Headers(init?.headers).get("Authorization"),
  });

  if (s3Down) return Promise.resolve(new Response("boom", { status: 500 }));

  // 路径形如 /bucket/key...
  const key = decodeURIComponent(url.pathname.replace(/^\/agenticlab\/?/, ""));

  if (method === "GET" && url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") ?? "";
    const token = url.searchParams.get("continuation-token");
    const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();

    // 一页只给两个，逼着调用方走完分页
    const start = token ? Number(token) : 0;
    const page = all.slice(start, start + 2);
    const truncated = start + 2 < all.length;

    const xml =
      `<?xml version="1.0"?><ListBucketResult>` +
      page
        .map(
          (k) =>
            `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><Size>${store.get(k)!.length}</Size><ETag>&quot;x&quot;</ETag></Contents>`,
        )
        .join("") +
      `<IsTruncated>${truncated}</IsTruncated>` +
      (truncated ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : "") +
      `</ListBucketResult>`;
    return Promise.resolve(new Response(xml, { status: 200 }));
  }

  if (method === "PUT") {
    const body = Buffer.from(init?.body as Uint8Array);
    store.set(key, truncateOnPut ? body.subarray(0, Math.floor(body.length / 2)) : body);
    return Promise.resolve(new Response("", { status: 200 }));
  }

  if (method === "GET") {
    const body = store.get(key);
    if (!body) return Promise.resolve(new Response("", { status: 404 }));
    return Promise.resolve(new Response(new Uint8Array(body), { status: 200 }));
  }

  if (method === "HEAD") {
    const body = store.get(key);
    if (!body) return Promise.resolve(new Response("", { status: 404 }));
    return Promise.resolve(
      new Response("", { status: 200, headers: { "content-length": String(body.length) } }),
    );
  }

  if (method === "DELETE") {
    store.delete(key);
    return Promise.resolve(new Response("", { status: 204 }));
  }

  return Promise.resolve(new Response("", { status: 405 }));
}

/** 造一份能通过完整性检查、里面真的有行的 sqlite 备份 */
function makeBackupGz(messages = 3, users = 2): Buffer {
  const path = join(tmp, `src-${Math.random().toString(36).slice(2)}.db`);
  const d = new Database(path);
  d.exec(`
    CREATE TABLE messages (id TEXT PRIMARY KEY);
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE points_ledger (id TEXT PRIMARY KEY);
    CREATE TABLE forum_posts (id TEXT PRIMARY KEY);
  `);
  for (let i = 0; i < messages; i++) d.prepare(`INSERT INTO messages VALUES (?)`).run(`m${i}`);
  for (let i = 0; i < users; i++) d.prepare(`INSERT INTO users VALUES (?)`).run(`u${i}`);
  d.close();
  const gz = gzipSync(readFileSync(path));
  unlinkSync(path);
  return gz;
}

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });

  mock.method(globalThis, "fetch", fakeS3);
  offsite = await import("@/lib/backup/offsite");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.backupRuns).run();
  rmSync(join(tmp, "backups"), { recursive: true, force: true });
  rmSync(join(tmp, "archive"), { recursive: true, force: true });
  mkdirSync(join(tmp, "backups"), { recursive: true });
  mkdirSync(join(tmp, "archive"), { recursive: true });
  store = new Map();
  truncateOnPut = false;
  s3Down = false;
  seen = [];
  Object.assign(process.env, S3_ENV);
});

function putLocal(dir: "backups" | "archive", name: string, body: Buffer) {
  writeFileSync(join(tmp, dir, name), body);
}

describe("没配置 —— 不能显示成「成功 0 个」", () => {
  it("缺配置时明确报「根本没在做」", async () => {
    delete process.env.OFFSITE_S3_BUCKET;
    const result = await offsite.syncOffsite();

    assert.equal(result.ok, false);
    assert.equal(result.status, "unconfigured");
    assert.match(result.note, /只在服务器这一块磁盘上/);
    assert.equal(seen.length, 0, "没配置就不该发出任何请求");
  });

  it("这一轮也要留痕 —— 「没跑」和「跑了但跳过」要分得开", async () => {
    delete process.env.OFFSITE_S3_ENDPOINT;
    await offsite.syncOffsite();
    const runs = dbm.db.select().from(schema.backupRuns).all();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "skipped");
  });

  it("状态汇总里说得出缺哪几项", async () => {
    delete process.env.OFFSITE_S3_ACCESS_KEY_ID;
    const summary = offsite.offsiteSummary();
    assert.equal(summary.status, "unconfigured");
    assert.deepEqual(summary.missingKeys, ["OFFSITE_S3_ACCESS_KEY_ID"]);
  });
});

describe("上传与读回校验", () => {
  it("传上去、读回来、对得上", async () => {
    putLocal("backups", "agenticlab-daily-20260809-0400.db.gz", makeBackupGz());
    const result = await offsite.syncOffsite();

    assert.equal(result.ok, true);
    assert.equal(result.uploaded, 1);
    assert.equal(result.verified, 1, "传完没读回来对哈希");
    assert.ok(store.has("site/backups/agenticlab-daily-20260809-0400.db.gz"));
  });

  it("**每个请求都带签名** —— 少签一个就是 403", async () => {
    putLocal("backups", "a.db.gz", makeBackupGz());
    await offsite.syncOffsite();
    assert.ok(seen.length > 0);
    for (const r of seen) {
      assert.match(r.auth ?? "", /^AWS4-HMAC-SHA256 Credential=/, `${r.method} ${r.url} 没签名`);
    }
  });

  it("对面静默截断时必须失败，而不是报成功", async () => {
    putLocal("backups", "a.db.gz", makeBackupGz());
    truncateOnPut = true;

    const result = await offsite.syncOffsite();
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /读回来对不上/);
  });

  it("归档文件也一起传 —— 那是冷层正文的唯一副本", async () => {
    putLocal("archive", "messages-2025-01.ndjson.gz", gzipSync(Buffer.from("{}\n")));
    const result = await offsite.syncOffsite();
    assert.equal(result.uploaded, 1);
    assert.ok(store.has("site/archive/messages-2025-01.ndjson.gz"));
  });

  it("已经传过的不重传", async () => {
    putLocal("backups", "a.db.gz", makeBackupGz());
    await offsite.syncOffsite();
    const second = await offsite.syncOffsite();
    assert.equal(second.uploaded, 0);
    assert.match(second.note, /没有新的要传/);
  });

  it("远端那份大小对不上就重传 —— 上次传了一半不算数", async () => {
    const body = makeBackupGz();
    putLocal("backups", "a.db.gz", body);
    store.set("site/backups/a.db.gz", body.subarray(0, 10));

    const result = await offsite.syncOffsite();
    assert.equal(result.uploaded, 1);
    assert.equal(store.get("site/backups/a.db.gz")!.length, body.length);
  });

  it("**列表分页要走完** —— 只取第一页会永远重传同一批", async () => {
    for (let i = 0; i < 5; i++) putLocal("backups", `f${i}.db.gz`, makeBackupGz());
    await offsite.syncOffsite();

    const second = await offsite.syncOffsite();
    assert.equal(second.uploaded, 0, "第二轮又传了一遍，说明列表没翻完页");
    assert.equal(store.size, 5);
  });

  it("对象存储挂了时如实失败并留痕", async () => {
    putLocal("backups", "a.db.gz", makeBackupGz());
    s3Down = true;

    const result = await offsite.syncOffsite();
    assert.equal(result.ok, false);
    assert.equal(offsite.offsiteState().lastError !== null, true);
    assert.equal(offsite.offsiteSummary().status, "failing");
  });
});

describe("恢复演练 —— 没演练过的备份只是一堆字节", () => {
  it("下载、解压、打开、数行", async () => {
    putLocal("backups", "agenticlab-daily-20260809-0400.db.gz", makeBackupGz(7, 4));
    await offsite.syncOffsite();

    const drill = await offsite.restoreDrill();
    assert.equal(drill.ok, true);
    assert.equal(drill.counts?.messages, 7);
    assert.equal(drill.counts?.users, 4);
  });

  it("演练的是远端那份 —— 本地能打开不能说明传上去的能打开", async () => {
    putLocal("backups", "a.db.gz", makeBackupGz());
    await offsite.syncOffsite();
    // 把远端那份换成垃圾，本地那份完好
    store.set("site/backups/a.db.gz", gzipSync(Buffer.from("not a database")));

    const drill = await offsite.restoreDrill();
    assert.equal(drill.ok, false, "读的是本地那份，没有真的验证远端");
  });

  it("**能打开但是空的同样是灾难** —— 它会通过完整性检查", async () => {
    putLocal("backups", "a.db.gz", makeBackupGz(0, 0));
    await offsite.syncOffsite();

    const drill = await offsite.restoreDrill();
    assert.equal(drill.ok, false);
    assert.match(drill.note, /空的/);
  });

  it("远端一份都没有时说清楚，而不是报成功", async () => {
    const drill = await offsite.restoreDrill();
    assert.equal(drill.ok, false);
    assert.match(drill.note, /一个备份文件都没有/);
  });

  it("没配置时不假装演练过", async () => {
    delete process.env.OFFSITE_S3_BUCKET;
    const drill = await offsite.restoreDrill();
    assert.equal(drill.ok, false);
    assert.equal(offsite.offsiteState().lastDrillAt, null);
  });

  it("演练成功后不再催演练", async () => {
    putLocal("backups", "a.db.gz", makeBackupGz());
    await offsite.syncOffsite();
    assert.equal(offsite.offsiteSummary().drillDue, true, "传过但没演练过时该催");

    await offsite.restoreDrill();
    assert.equal(offsite.offsiteSummary().drillDue, false);
  });
});

describe("状态汇总", () => {
  it("传成功之后是 ok", async () => {
    putLocal("backups", "a.db.gz", makeBackupGz());
    await offsite.syncOffsite();
    assert.equal(offsite.offsiteSummary().status, "ok");
  });

  it("没有新文件的那一轮也算「远端是最新的」", async () => {
    putLocal("backups", "a.db.gz", makeBackupGz());
    await offsite.syncOffsite();
    dbm.db.delete(schema.backupRuns).run();

    await offsite.syncOffsite(); // 这轮 uploaded=0，记的是 verify
    const state = offsite.offsiteState();
    assert.notEqual(state.lastUploadAt, null, "没有新文件被当成了从没传过");
    assert.equal(offsite.offsiteSummary().status, "ok");
  });

  it("本地文件列表里备份和归档都在", async () => {
    putLocal("backups", "a.db.gz", makeBackupGz());
    putLocal("archive", "messages-2025-01.ndjson.gz", gzipSync(Buffer.from("{}")));
    const names = offsite.offsiteSummary().localFiles.map((f) => f.name).sort();
    assert.deepEqual(names, ["archive/messages-2025-01.ndjson.gz", "backups/a.db.gz"]);
  });
});
