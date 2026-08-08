/**
 * 清空并重建某个群的本地镜像。
 *
 * 判定规则（高质量阈值、索引范围、分层策略）改动后必须跑这个 ——
 * 本地库是缓存不是唯一副本，上游随时可以回源，重建代价很低。
 *
 *   npm run resync -- <关键词|all>
 */
import { eq, like } from "drizzle-orm";

import { db, sqlite } from "@/lib/db";
import { dailyStats, groups, messages, syncCursors } from "@/lib/db/schema";
import { syncGroupMessages } from "@/lib/sync/messages";

const keyword = process.argv[2];

if (!keyword) {
  console.error("用法：npm run resync -- <群名关键词|all>");
  process.exit(1);
}

function clearGroup(convId: string) {
  db.transaction((tx) => {
    tx.delete(messages).where(eq(messages.convId, convId)).run();
    tx.delete(dailyStats).where(eq(dailyStats.convId, convId)).run();
    tx.delete(syncCursors).where(eq(syncCursors.scope, convId)).run();
  });
  sqlite.prepare(`DELETE FROM messages_fts WHERE conv_id = ?`).run(convId);
}

async function main() {
  const targets =
    keyword === "all"
      ? db.select().from(groups).where(eq(groups.syncEnabled, true)).all()
      : db.select().from(groups).where(like(groups.name, `%${keyword}%`)).all();

  if (targets.length === 0) {
    console.log(`没有匹配「${keyword}」的群`);
    return;
  }

  for (const g of targets) {
    if (!g.syncEnabled) {
      console.log(`跳过（未开启同步）：${g.name}`);
      continue;
    }
    process.stdout.write(`${g.name}：清空…`);
    clearGroup(g.convId);
    const started = Date.now();
    const result = await syncGroupMessages(g.convId, { triggeredBy: "admin" });
    console.log(` 重建 ${result.written} 条（${((Date.now() - started) / 1000).toFixed(1)}s）`);
  }

  sqlite.exec("VACUUM");
  console.log("完成");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
