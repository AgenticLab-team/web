/**
 * 校准「高质量消息」判定规则。
 *
 * 上游只给结果不给算法，所以反推：按消息类型拆开本地数据，
 * 找出哪一组类型的组合能让本地计数与上游榜单完全吻合。
 * 这个规则是积分体系的地基，差一点后面全是错的。
 */
import { and, eq, gte, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { nekobot } from "@/lib/nekobot/client";

const CONV = process.argv[2] ?? "20000000001@chatroom";
const MIN = 15;

async function main() {
  const upstream = await nekobot.leaderboard(CONV, { days: 7, limit: 10 });
  console.log(`上游 quality_min = ${upstream.quality_min}\n`);
  const since = Date.now() - 7 * 86_400_000;

  // 每个人 × 每种类型，长度达标的条数
  const rows = db
    .select({
      wxId: messages.senderWxId,
      type: messages.type,
      n: sql<number>`count(*)`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.convId, CONV),
        gte(messages.ts, since),
        eq(messages.isSend, false),
        gte(messages.length, MIN),
      ),
    )
    .groupBy(messages.senderWxId, messages.type)
    .all();

  const byUser = new Map<string, Map<string, number>>();
  const allTypes = new Set<string>();
  for (const r of rows) {
    allTypes.add(r.type);
    if (!byUser.has(r.wxId)) byUser.set(r.wxId, new Map());
    byUser.get(r.wxId)!.set(r.type, r.n);
  }

  console.log("出现过的类型（长度 ≥ 15）：", [...allTypes].join(", "), "\n");

  // 先看差额由哪些类型构成
  console.log("── 每人差额构成 ──");
  console.log("  上游  text  差额  |  各类型分布");
  for (const e of upstream.leaderboard.slice(0, 6)) {
    const m = byUser.get(e.wx_id) ?? new Map();
    const text = m.get("text") ?? 0;
    const dist = [...m.entries()]
      .filter(([t]) => t !== "text")
      .map(([t, n]) => `${t}:${n}`)
      .join(" ");
    console.log(
      `  ${String(e.quality_messages).padStart(4)}  ${String(text).padStart(4)}  ${String(e.quality_messages - text).padStart(4)}  |  ${dist}`,
    );
  }

  // 穷举类型组合，找完全吻合的那一组
  const types = [...allTypes].filter((t) => t !== "text");
  console.log(`\n── 穷举 text + ${types.length} 种其它类型的组合 ──`);

  let best: { combo: string[]; matched: number } | null = null;
  for (let mask = 0; mask < 1 << types.length; mask++) {
    const combo = ["text", ...types.filter((_, i) => mask & (1 << i))];
    const set = new Set(combo);
    let matched = 0;
    for (const e of upstream.leaderboard) {
      const m = byUser.get(e.wx_id) ?? new Map();
      let sum = 0;
      for (const [t, n] of m) if (set.has(t)) sum += n;
      if (sum === e.quality_messages) matched++;
    }
    if (!best || matched > best.matched) best = { combo, matched };
    if (matched === upstream.leaderboard.length) {
      console.log(`  ✅ 完全吻合：{${combo.join(", ")}}`);
      return;
    }
  }

  console.log(
    `  最佳组合 {${best!.combo.join(", ")}} 只对上 ${best!.matched}/${upstream.leaderboard.length} 人`,
  );
  console.log("  → 说明差异不在类型，可能是长度口径（字符 vs 字节）或去重规则不同");

  // 检验长度口径：上游 length 字段与我们存的是否一致
  const lenCheck = db
    .select({
      stored: messages.length,
      actual: sql<number>`length(${messages.content})`,
      n: sql<number>`count(*)`,
    })
    .from(messages)
    .where(and(eq(messages.convId, CONV), eq(messages.type, "text")))
    .groupBy(sql`${messages.length} = length(${messages.content})`)
    .all();
  console.log("\n── length 字段与 content 实际长度是否一致 ──");
  for (const r of lenCheck) {
    console.log(`  stored=${r.stored} actual=${r.actual} → ${r.n} 条`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
