/**
 * 资源库回填。
 *
 *   npm run links              回填全部历史消息里的链接
 *   npm run links -- --audit   只对账，不写入
 *   npm run links -- --retitle 按当前规则重算标题（改了抽取规则之后跑）
 *
 * 可以反复跑：唯一索引挡住重复的 mention，计数每次从明细现算。
 * 不幂等的话，跑六遍会让「被分享 64 次」这种数字凭空冒出来，
 * 而没有任何地方能看出它是假的。
 */
import { auditLinkCounts, backfillLinks, retitleAll } from "@/lib/links/ingest";
import { linkStats } from "@/lib/links/queries";

function main() {
  if (process.argv.includes("--audit")) {
    const drift = auditLinkCounts();
    console.log(drift.length === 0 ? "✓ 分享次数与明细对得上" : `✗ ${drift.length} 条对不上`);
    for (const row of drift.slice(0, 10)) {
      console.log(`  ${row.linkId}  记 ${row.stored}  实际 ${row.actual}`);
    }
    process.exit(drift.length === 0 ? 0 : 1);
  }

  if (process.argv.includes("--retitle")) {
    // 标题是存下来的：改了规则不重算，线上还是旧样子
    console.log(`✓ 重算标题：${retitleAll()} 条有变化`);
    return;
  }

  const result = backfillLinks();
  console.log(
    `扫描 ${result.scanned} 条带链接的消息 · 新增链接 ${result.created} · 新增分享记录 ${result.mentions} · 跳过 ${result.skipped}`,
  );

  const stats = linkStats();
  console.log(`资源库现有 ${stats.total} 条（隐藏 ${stats.hidden}）· ${stats.domains} 个域名`);

  const drift = auditLinkCounts();
  if (drift.length > 0) console.log(`⚠ ${drift.length} 条的分享次数与明细对不上`);
}

main();
