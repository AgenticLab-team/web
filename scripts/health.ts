/** 跑一轮健康探测、落库、判定并投递告警。 npm run health */
import { checkAndDispatch } from "@/lib/alerts/dispatch";
import { runHealthChecks, takeStorageSnapshot } from "@/lib/health";

async function main() {
  const reports = await runHealthChecks();
  for (const r of reports) {
    const icon = r.status === "ok" ? "✓" : r.status === "degraded" ? "!" : "✗";
    console.log(`  ${icon} ${r.component.padEnd(13)} ${r.status.padEnd(9)} ${r.detail ?? ""}`);
  }

  const s = takeStorageSnapshot();
  console.log(
    `\n库 ${(s.dbBytes / 1048576).toFixed(1)}MB（FTS ${(s.ftsBytes / 1048576).toFixed(1)}MB）· 磁盘 ${s.diskPct}%`,
  );
  for (const t of s.byTable.slice(0, 6)) {
    console.log(`    ${t.name.padEnd(22)} ${(t.bytes / 1048576).toFixed(2)} MB`);
  }

  /*
   * 用刚探到的结果判定告警，而不是回头查最新状态表 ——
   * 隧道断了之后 upstream_api 那一行会永远停在最后一次「正常」上。
   */
  const alerted = await checkAndDispatch(reports);
  if (alerted.fired || alerted.renotified || alerted.resolved) {
    console.log(
      `\n告警 新报 ${alerted.fired} · 重提醒 ${alerted.renotified} · 已恢复 ${alerted.resolved} · 送达 ${alerted.delivered} · 发送失败 ${alerted.failed}`,
    );
    if (alerted.failed > 0) {
      // 发不出去比没告警更需要被看到
      console.log("  ⚠ 有告警没能送达 —— 详见 /admin/health 的「投递失败」");
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
