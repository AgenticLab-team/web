/**
 * 数据校验：本地镜像与上游对账。
 *
 * 最关键的一项是高质量消息数 —— 积分和排行榜都建立在它上面，
 * 如果本地判定与上游不一致，整个激励体系的数字就是错的。
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";

import { db, sqlite } from "@/lib/db";
import { buildMatchExpression, desegment } from "@/lib/db/fts";
import { dailyStats, groups, messages } from "@/lib/db/schema";
import { nekobot } from "@/lib/nekobot/client";

const CONV = process.argv[2] ?? "10000000002@chatroom";

async function main() {
  const group = db.select().from(groups).where(eq(groups.convId, CONV)).get();
  console.log(`群：${group?.name ?? CONV}\n`);

  const local = db
    .select({
      total: sql<number>`count(*)`,
      quality: sql<number>`sum(${messages.isQuality})`,
      indexed: sql<number>`sum(${messages.indexed})`,
      minTs: sql<number>`min(${messages.ts})`,
      maxTs: sql<number>`max(${messages.ts})`,
    })
    .from(messages)
    .where(eq(messages.convId, CONV))
    .get();

  console.log("── 本地镜像 ──");
  console.log(`  消息 ${local?.total}  高质量 ${local?.quality}  已索引 ${local?.indexed}`);
  console.log(
    `  时间跨度 ${new Date(local!.minTs).toISOString().slice(0, 10)} → ${new Date(local!.maxTs).toISOString().slice(0, 10)}`,
  );

  // ── 与上游榜单对账 ──────────────────────────────────────────
  console.log("\n── 与上游榜单对账（近 7 天）──");
  const upstream = await nekobot.leaderboard(CONV, { days: 7, limit: 10 });
  const since = Date.now() - 7 * 86_400_000;

  const localBoard = db
    .select({
      wxId: messages.senderWxId,
      name: sql<string>`max(${messages.senderName})`,
      messages: sql<number>`count(*)`,
      quality: sql<number>`sum(${messages.isQuality})`,
    })
    .from(messages)
    .where(and(eq(messages.convId, CONV), gte(messages.ts, since), eq(messages.isSend, false)))
    .groupBy(messages.senderWxId)
    .orderBy(desc(sql`count(*)`))
    .limit(10)
    .all();

  const localMap = new Map(localBoard.map((r) => [r.wxId, r]));
  let mismatches = 0;
  console.log("  上游消息/高质量  |  本地消息/高质量  |  昵称");
  for (const entry of upstream.leaderboard) {
    const mine = localMap.get(entry.wx_id);
    const ok =
      mine && mine.messages === entry.messages && Number(mine.quality) === entry.quality_messages;
    if (!ok) mismatches++;
    console.log(
      `  ${ok ? "✓" : "✗"} ${String(entry.messages).padStart(5)}/${String(entry.quality_messages).padStart(4)}` +
        `  |  ${String(mine?.messages ?? "-").padStart(5)}/${String(mine?.quality ?? "-").padStart(4)}` +
        `  |  ${entry.name}`,
    );
  }
  console.log(
    mismatches === 0
      ? "  ✅ 完全一致 —— 本地高质量判定与上游对齐，积分可以建立在它上面"
      : `  ⚠️  ${mismatches}/${upstream.leaderboard.length} 人不一致，需要排查判定规则`,
  );

  // ── FTS 中文检索 ────────────────────────────────────────────
  console.log("\n── 中文全文检索 ──");
  for (const q of ["鉴权", "部署", "Claude", "模型 部署"]) {
    const expr = buildMatchExpression(q);
    if (!expr) continue;
    const rows = sqlite
      .prepare(
        `SELECT msg_id, content FROM messages_fts WHERE messages_fts MATCH ? AND conv_id = ? LIMIT 2`,
      )
      .all(expr, CONV) as { msg_id: string; content: string }[];
    const count = (
      sqlite
        .prepare(
          `SELECT count(*) n FROM messages_fts WHERE messages_fts MATCH ? AND conv_id = ?`,
        )
        .get(expr, CONV) as { n: number }
    ).n;
    console.log(`  「${q}」→ ${count} 条`);
    for (const r of rows) console.log(`      ${desegment(r.content).slice(0, 50)}`);
  }

  // ── 每日统计 ────────────────────────────────────────────────
  console.log("\n── 每日统计（最近 5 天，按高质量消息排前 3）──");
  const recentDates = db
    .selectDistinct({ date: dailyStats.date })
    .from(dailyStats)
    .where(eq(dailyStats.convId, CONV))
    .orderBy(desc(dailyStats.date))
    .limit(5)
    .all();

  for (const { date } of recentDates) {
    const top = db
      .select()
      .from(dailyStats)
      .where(and(eq(dailyStats.convId, CONV), eq(dailyStats.date, date)))
      .orderBy(desc(dailyStats.qualityMessages))
      .limit(3)
      .all();
    const line = top
      .map((t) => `${t.wxId.slice(0, 10)}…(${t.qualityMessages}/${t.messages})`)
      .join("  ");
    console.log(`  ${date}  ${line}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
