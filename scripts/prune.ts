/**
 * 存储分层裁剪。
 *
 *   npm run prune              只算不改，打印预览
 *   npm run prune -- --run     执行可逆步骤（改层 + 退索引）
 *   npm run prune -- --run --drop   连不可逆的丢正文一起做
 *
 * **默认不执行，`--run` 也不丢正文。**
 * 定时任务只走可逆的那两步 —— 永久删掉聊天记录这件事应该有个人按下确认，
 * 而不是某天凌晨三点由一个 cron 悄悄完成。
 */
import { loadTierConfig, previewPrune, runPrune, verifyUpstreamRetention } from "@/lib/storage/prune";
import { configWarnings, formatBytes, validateTierConfig } from "@/lib/storage/tiers";

const args = new Set(process.argv.slice(2));
const execute = args.has("--run");
const allowDrop = args.has("--drop");

async function main() {
  const config = loadTierConfig();

  const problems = validateTierConfig(config);
  if (problems.length > 0) {
    console.error(`分层配置讲不通：${problems.join("；")}`);
    process.exit(1);
  }
  for (const w of configWarnings(config)) console.log(`  ! ${w}`);

  const preview = previewPrune(config);
  console.log(
    `预览  改层 ${preview.retier} · 退索引 ${preview.unindex}（约省 ${formatBytes(preview.unindexBytes)}）· ` +
      `丢正文 ${preview.drop}（约省 ${formatBytes(preview.dropBytes)}）`,
  );
  if (preview.oldestTs && preview.newestTs) {
    console.log(
      `      影响 ${new Date(preview.oldestTs).toLocaleDateString("zh-CN")} 至 ${new Date(preview.newestTs).toLocaleDateString("zh-CN")}`,
    );
  }

  if (!execute) {
    console.log("\n只算不改。要执行加 --run（仍不丢正文），连丢正文一起做再加 --drop");
    return;
  }

  // 没开归档且真要丢正文时，先把「回源」这个前提验一遍
  const retention =
    allowDrop && !config.archiveBeforeDrop ? await verifyUpstreamRetention(config) : undefined;
  if (retention) console.log(`回源验证：${retention.reason}`);

  const result = await runPrune({ config, reversibleOnly: !allowDrop, retention });
  console.log(
    `\n✓ 改层 ${result.retiered} · 退索引 ${result.unindexed} · 丢正文 ${result.dropped}` +
      ` · 库 ${formatBytes(result.bytesBefore)} → ${formatBytes(result.bytesAfter)}`,
  );
  for (const a of result.archived) {
    console.log(`  归档 ${a.file.split("/").pop()}  ${a.rows} 条  ${formatBytes(a.bytes)}`);
  }
  if (result.skipped) console.log(`  ! ${result.skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
