/**
 * 建语义检索的索引。
 *
 *   npm run embed-messages              切段 + 嵌入还没嵌过的
 *   npm run embed-messages -- --windows-only   只切段，不调模型
 *   npm run embed-messages -- --limit=200
 *
 * 切段和嵌入分开跑是刻意的：切段是纯本地计算、不会失败；
 * 嵌入要打网络、会超时。混在一起的话一次网络抖动会让这批消息
 * **连段都没切**，下次还得从头来。
 */
import { embedPendingWindows, rebuildWindows, semanticProgress } from "@/lib/search/semantic";

const args = process.argv.slice(2);
const limit = Number(args.find((a) => a.startsWith("--limit="))?.slice(8)) || 2000;
const windowsOnly = args.includes("--windows-only");

async function main() {
  const started = Date.now();

  console.log("切段…");
  const built = rebuildWindows();
  console.log(`  扫了 ${built.scanned} 条文本消息，新建 ${built.created} 段（${Date.now() - started}ms）`);

  const before = semanticProgress();
  console.log(`  现在共 ${before.total} 段，已嵌 ${before.embedded}，待嵌 ${before.pending}\n`);

  if (windowsOnly) {
    console.log("（--windows-only，不调模型）");
    return;
  }
  if (before.pending === 0) {
    console.log("没有要嵌的了。");
    return;
  }

  console.log(`嵌入（一次最多 ${limit} 段）…`);
  const report = await embedPendingWindows(limit);
  console.log(`  ✓ 嵌了 ${report.embedded}`);
  if (report.failed > 0) console.log(`  ✗ 失败 ${report.failed}`);
  for (const n of report.notes.slice(0, 5)) console.log(`     ${n}`);

  const after = semanticProgress();
  console.log(`\n共 ${after.total} 段，已嵌 ${after.embedded}，待嵌 ${after.pending}`);
  console.log(`总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (report.failed > 0 && report.embedded === 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
