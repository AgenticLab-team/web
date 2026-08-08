import "server-only";

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { env } from "@/lib/env";

import * as schema from "./schema";

function createConnection() {
  const path = resolve(env.db.path);
  mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path);

  // WAL 让读写并发，写入串行化，天然规避活动抢名额时的竞态
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  // 并发写入时不要直接抛 SQLITE_BUSY
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("temp_store = MEMORY");

  ensureFtsTable(sqlite);

  return sqlite;
}

/**
 * FTS5 是虚拟表，Drizzle 管不了，用裸 SQL 建。
 * 用独立表而非 external content：messages 主键是上游的 msg_svr_id（文本），
 * 对不上 FTS 的整数 rowid；而且分层保留需要我们自己决定索引哪些消息。
 */
function ensureFtsTable(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      msg_id UNINDEXED,
      conv_id UNINDEXED,
      sender_wx_id UNINDEXED,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
}

// Next.js 开发模式会热重载模块，缓存连接避免每次新开一个文件句柄
const globalForDb = globalThis as unknown as {
  __agenticlabSqlite?: Database.Database;
};

const sqlite = globalForDb.__agenticlabSqlite ?? createConnection();
if (!env.isProd) globalForDb.__agenticlabSqlite = sqlite;

export const db = drizzle(sqlite, { schema });
export { sqlite, schema };
