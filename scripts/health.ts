/**
 * 定时一轮：探活、存储、裁剪、各种结算、告警投递。 npm run health
 *
 * ─────────────────────────────────────────
 * 每一步都是隔开的
 * ─────────────────────────────────────────
 *
 * 原来是七个 await 排成一串，任何一步抛异常后面就全都不跑 ——
 * 而**告警投递排在最后**。也就是说，只要前面任何一步出问题，
 * 「告诉你出问题了」的那一步就不会执行：
 * 报信的人被它要报的那件事挡在了门外。
 *
 * 现在走 runSteps：一步失败不影响其它步，失败本身会在最后被汇总报出来。
 */
import { checkAndDispatch } from "@/lib/alerts/dispatch";
import { publishDueScheduled } from "@/lib/forum/schedule";
import { settleAutoRoles } from "@/lib/rbac/role-settle";
import { settleExpiredPins } from "@/lib/forum/pin-settle";
import {
  lastTickHealth,
  recordTickHealth,
  runHealthChecks,
  takeStorageSnapshot,
  type HealthReport,
} from "@/lib/health";
import { runSteps, summarize, tickFailureReport, tickHealth } from "@/lib/ops/tick";
import { settleDueSeasons } from "@/lib/seasons/settle";
import { autoPruneIfNeeded } from "@/lib/storage/auto";
import { settleAll } from "@/lib/titles/settle";

async function main() {
  /*
   * 探活单独先跑：告警判定要用**这一轮真的探到的结果**，
   * 而不是回头查最新状态表 —— 隧道断了之后 upstream_api 那一行
   * 会永远停在最后一次「正常」上。
   *
   * 它整体失败时也不能让这一轮停 —— 那正是最需要发告警的时刻。
   */
  let reports: HealthReport[] = [];
  let probeError: string | null = null;
  try {
    reports = await runHealthChecks();
    for (const r of reports) {
      const icon = r.status === "ok" ? "✓" : r.status === "degraded" ? "!" : "✗";
      console.log(`  ${icon} ${r.component.padEnd(13)} ${r.status.padEnd(9)} ${r.detail ?? ""}`);
    }
  } catch (error) {
    probeError = error instanceof Error ? error.message : String(error);
    console.error(`  ✗ 探活整体失败：${probeError}`);
  }

  let diskPct = 0;

  const report = await runSteps([
    {
      name: "存储快照",
      run: () => takeStorageSnapshot(),
      describe: (s: ReturnType<typeof takeStorageSnapshot>) => {
        diskPct = s.diskPct;
        return `库 ${(s.dbBytes / 1048576).toFixed(1)}MB · 磁盘 ${s.diskPct}%`;
      },
    },
    {
      name: "自动裁剪",
      run: () => autoPruneIfNeeded(diskPct),
      describe: (r: Awaited<ReturnType<typeof autoPruneIfNeeded>>) =>
        r.result ? `改层 ${r.result.retiered} · 退索引 ${r.result.unindexed}` : r.reason,
    },
    {
      name: "置顶到期",
      run: () => settleExpiredPins(),
      describe: (r: ReturnType<typeof settleExpiredPins>) =>
        r.cleared > 0 ? `清理 ${r.cleared} 条` : "无到期",
    },
    {
      /*
       * 定时发布挂在这一轮里，而不是自己起一个定时器 ——
       * 多一个定时器就多一处会悄悄停掉、而且没人看得出来的东西。
       * 挂进这里，它停了会和别的步骤一起被发现。
       */
      name: "定时发布",
      run: () => publishDueScheduled(),
      describe: (r: ReturnType<typeof publishDueScheduled>) =>
        r.published === 0 && r.failed.length === 0
          ? "无到点"
          : `发出 ${r.published} 篇${r.failed.length ? ` · 失败 ${r.failed.length}` : ""}`,
    },
    {
      name: "赛季结算",
      run: () => settleDueSeasons(),
      describe: (rows: ReturnType<typeof settleDueSeasons>) =>
        rows.length === 0 ? "无待结算" : rows.map((r) => `${r.seasonKey}:${r.reason}`).join("；"),
    },
    {
      /*
       * 自动身份组和定时发布挂在同一轮里 —— 理由一样：
       * 多一个定时器就多一处会悄悄停掉、而且没人看得出来的东西。
       */
      name: "身份组结算",
      run: () => settleAutoRoles(),
      describe: (r: ReturnType<typeof settleAutoRoles>) => {
        if (r.blocked.length > 0) return `拦下 ${r.blocked.join("、")}（带危险权限）`;
        return r.granted || r.revoked || r.waitlisted
          ? `授予 ${r.granted} · 回收 ${r.revoked}${r.waitlisted ? ` · 名额不够 ${r.waitlisted}` : ""}`
          : "无变化";
      },
    },
    {
      name: "称号结算",
      run: () => settleAll(),
      describe: (r: ReturnType<typeof settleAll>) =>
        r.granted || r.expired || r.renewed || r.reminded
          ? `授予 ${r.granted} · 到期 ${r.expired} · 续费 ${r.renewed}（失败 ${r.renewFailed}）· 提醒 ${r.reminded}`
          : "无变化",
    },
    {
      /*
       * 告警投递排在最后只是为了日志读起来顺 ——
       * 它的执行**不依赖前面任何一步**，runSteps 保证了这一点。
       */
      name: "告警投递",
      /*
       * 把**上一轮**定时任务自己的状态也一起判。
       *
       * 这一轮的结果它不可能知道 —— 告警投递就是这一轮的一步。
       * 延后一轮（5 分钟）没有关系：cron 的报警线是 30 分钟，
       * 偶发一次本来就不该报。
       */
      run: () => {
        const previous = lastTickHealth();
        const all = reports.length > 0 ? [...reports] : [];
        if (previous) all.push(previous);
        return checkAndDispatch(all.length > 0 ? all : undefined);
      },
      describe: (r: Awaited<ReturnType<typeof checkAndDispatch>>) =>
        r.fired || r.renotified || r.resolved
          ? `新报 ${r.fired} · 重提醒 ${r.renotified} · 已恢复 ${r.resolved} · 送达 ${r.delivered} · 发送失败 ${r.failed}`
          : "无告警",
    },
  ] as never);

  console.log();
  for (const step of report.steps) {
    console.log(`${step.ok ? " " : "✗"} ${step.name.padEnd(10)} ${step.ok ? step.note : step.error}`);
  }
  console.log(`\n${summarize(report)}`);

  /*
   * 有步骤失败时退非零，让 systemd 把这一轮标成失败 ——
   * 但那是在**所有步骤都跑完之后**：失败一步不该拖累其它步。
   */
  /*
   * 把这一轮的结果写成 cron 组件的健康状态。
   *
   * 退出码和 journald 没有人会主动去看 —— 只有接进告警那条链路，
   * 「有个定时任务挂了」才会真的传到人那里。
   */
  const health = tickHealth(report, probeError);
  recordTickHealth(health.status, health.detail);

  const failure = tickFailureReport(report);
  if (probeError || failure) {
    if (probeError) console.error(`\n⚠ 探活失败：${probeError}`);
    if (failure) console.error(`\n⚠ ${failure.title}：${failure.body}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
