/**
 * 异地备份。
 *
 *   npm run offsite            传一轮（传完读回来对哈希）
 *   npm run offsite -- --drill 做一次恢复演练：下载、解压、打开、数行
 *   npm run offsite -- --status 只看状态，什么都不做
 *
 * 需要在 .env.local 里配：
 *   OFFSITE_S3_ENDPOINT / OFFSITE_S3_BUCKET
 *   OFFSITE_S3_ACCESS_KEY_ID / OFFSITE_S3_SECRET_ACCESS_KEY
 *   OFFSITE_S3_REGION（可选，默认 auto）/ OFFSITE_S3_PREFIX（可选）
 *
 * 兼容任何 S3 协议的对象存储：Cloudflare R2、Backblaze B2、MinIO。
 */
import { STATUS_LABELS } from "@/lib/backup/rules";
import { offsiteSummary, restoreDrill, syncOffsite } from "@/lib/backup/offsite";

const args = new Set(process.argv.slice(2));

async function main() {
  const before = offsiteSummary();
  console.log(`当前  ${STATUS_LABELS[before.status]} · ${before.detail}`);
  if (before.missingKeys.length > 0) {
    console.log(`      缺配置：${before.missingKeys.join("、")}`);
  }
  console.log(
    `本地  ${before.localFiles.length} 个文件（${(before.localFiles.reduce((n, f) => n + f.bytes, 0) / 1048576).toFixed(1)} MB）`,
  );

  if (args.has("--status")) return;

  if (args.has("--drill")) {
    const drill = await restoreDrill();
    console.log(`\n${drill.ok ? "✓" : "✗"} 恢复演练  ${drill.note}`);
    if (!drill.ok) process.exit(1);
    return;
  }

  const result = await syncOffsite();
  console.log(`\n${result.ok ? "✓" : "✗"} ${result.note}`);
  if (result.deleted > 0) console.log(`  远端清理 ${result.deleted} 个过期备份`);

  const after = offsiteSummary(Date.now());
  if (after.drillDue) {
    console.log("\n! 该做一次恢复演练了：npm run offsite -- --drill");
    console.log("  没演练过的备份只是一堆字节 —— 真要用的时候才发现打不开就晚了");
  }

  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
