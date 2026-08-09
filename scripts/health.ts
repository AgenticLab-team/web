/** 跑一轮健康探测、落库、判定并投递告警。 npm run health */
import { checkAndDispatch } from "@/lib/alerts/dispatch";
import { runHealthChecks, takeStorageSnapshot } from "@/lib/health";
import { autoPruneIfNeeded } from "@/lib/storage/auto";
import { settleAll } from "@/lib/titles/settle";

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
   * 水位到线就自动泄压 —— 但只做可逆的那两步。
   * 阈值不是用来看的，是用来触发的；而自动触发不该碰不可逆的操作。
   */
  const auto = await autoPruneIfNeeded(s.diskPct);
  console.log(`\n裁剪 ${auto.reason}`);
  if (auto.result) {
    console.log(
      `  改层 ${auto.result.retiered} · 退索引 ${auto.result.unindexed}`,
    );
  }

  /*
   * 用刚探到的结果判定告警，而不是回头查最新状态表 ——
   * 隧道断了之后 upstream_api 那一行会永远停在最后一次「正常」上。
   */
  /*
   * 称号结算。挂在这一轮里，不另开一个 timer ——
   * 又一个 timer 就是又一个可能悄悄挂掉的东西。
   */
  const titles = settleAll();
  if (titles.granted || titles.expired || titles.renewed || titles.reminded) {
    console.log(
      `\n称号 授予 ${titles.granted} · 到期 ${titles.expired} · 续费 ${titles.renewed}（失败 ${titles.renewFailed}）· 提醒 ${titles.reminded}`,
    );
    for (const line of titles.details.slice(0, 6)) console.log(`  ${line}`);
  }

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
