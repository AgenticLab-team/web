/**
 * 每周精选。
 *
 *   npm run digest                生成上一周的精选草稿
 *   npm run digest -- --week=2026-08-03
 *   npm run digest -- --force     覆盖已经生成过的那一周
 *
 * **它只生成草稿，不发送。** 发不发在 /admin/broadcast 里由人按 ——
 * 一个每周自动向一千六百人广播的机器人，被风控只是时间问题，
 * 而且没有人会为一条没人看过的自动消息负责。
 */
import { buildWeeklyDigest } from "@/lib/digest/build";

const args = process.argv.slice(2);
const week = args.find((a) => a.startsWith("--week="))?.slice("--week=".length);

const result = buildWeeklyDigest({ weekStart: week, force: args.includes("--force") });

console.log(`${result.weekStart} · ${result.ok ? "✓" : "—"} ${result.reason}`);

if (result.rejected.length > 0) {
  console.log(`\n被挡下的 ${result.rejected.length} 条：`);
  for (const row of result.rejected.slice(0, 10)) {
    console.log(`  ${row.id}  ${row.reason}`);
  }
}

if (result.ok) {
  console.log("\n草稿已备好，去 /admin/broadcast 复核后发送。");
  console.log("复核之后再改内容的话，内容哈希对不上，发送会被拒。");
}
