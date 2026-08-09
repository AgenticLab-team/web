/**
 * 用大模型整理资源库。
 *
 *   npm run enrich-links              整理还没整理过的（一次 50 条）
 *   npm run enrich-links -- --limit=20
 *   npm run enrich-links -- --force   连已经整理过的也重跑（换了模型时用）
 *
 * 重跑是安全的：整理过的默认跳过，「问过但模型说不知道」的也跳过 ——
 * 否则每次同步都会把同一批说不清的链接再问一遍。
 */
import { enrichLinks, enrichProgress } from "@/lib/links/enrich";

const args = process.argv.slice(2);
const limit = Number(args.find((a) => a.startsWith("--limit="))?.slice(8)) || 50;
const force = args.includes("--force");

async function main() {
  const before = enrichProgress();
  console.log(
    `资源库 ${before.total} 条：已整理 ${before.enriched} · 问过但说不清 ${before.checkedButUnknown} · 还没问 ${before.untouched}\n`,
  );

  const report = await enrichLinks({ limit, force });

  console.log(`扫了 ${report.scanned} 条`);
  console.log(`  ✓ 写入 ${report.written}`);
  console.log(`  − 模型说看不出是什么 ${report.unknown}`);
  console.log(`  ✗ 失败 ${report.failed}`);
  for (const note of report.notes.slice(0, 10)) console.log(`     ${note}`);

  const after = enrichProgress();
  console.log(`\n现在：已整理 ${after.enriched} / ${after.total}`);

  // 失败要让调用方看得见 —— 定时任务靠退出码判断
  if (report.failed > 0 && report.written === 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
