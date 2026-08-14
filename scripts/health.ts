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
import { releaseExpiredBans } from "@/lib/moderation/expiry";
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
import { sweepExpiredDeviceCodes } from "@/lib/tui/device";
import { settleDueSeasons } from "@/lib/seasons/settle";
import { autoPruneIfNeeded } from "@/lib/storage/auto";
import { computePersonPhrases } from "@/lib/members/phrases";
import { settleMail } from "@/lib/mail/settle";
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
      /*
       * 清掉过期的设备登录码。
       *
       * 挂在这一轮里而不是自己起一个定时器 —— 和「定时发布」同一个理由：
       * 多一个定时器就多一处会悄悄停掉、而且没人看得出来的东西。
       *
       * 不清的话 `device_codes` 只增不减，而表一大，
       * 生成用户码时撞车的概率跟着涨 —— 那时候的症状是
       * **一个毫不相干的人偶尔登录失败**，几乎不可能被查到这儿。
       */
      name: "设备码清理",
      run: () => sweepExpiredDeviceCodes(),
      describe: (n: number) => (n > 0 ? `清掉 ${n} 条` : "无过期"),
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
       * 到期解封。没有这一步的话，「封 7 天」只是一句安慰话 ——
       * 被封的人到了第八天仍然进不来，而界面上写着已经到期。
       */
      name: "到期解封",
      run: () => releaseExpiredBans(),
      describe: (r: ReturnType<typeof releaseExpiredBans>) =>
        r.unbanned || r.skipped ? `解除 ${r.unbanned}${r.skipped ? ` · 跳过 ${r.skipped}` : ""}` : "无到期",
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
       * 邮箱：回收到期的一次性箱 + 域名到期告警。
       *
       * 告警那一半比回收那一半急得多。域名过期是这套东西里
       * **唯一无声的故障** —— 挂在它上面的所有邮箱会同时消失，
       * 而表现只是「邮件不再来了」：没有报错、没有 5xx，
       * 用户只会以为最近没人给他发信。
       */
      name: "邮箱结算",
      run: () => settleMail(),
      describe: (r: ReturnType<typeof settleMail>) =>
        r.reclaimed || r.notified
          ? `回收 ${r.reclaimed} 个一次性箱${r.notified ? ` · 域名到期告警 ${r.domains.join("、")}` : ""}`
          : "无变化",
    },
    {
      /*
       * 「常挂在嘴边」全站重算一轮。
       *
       * 放在定时任务里而不是打开主页时现算：实测一个说了四千条消息的人
       * 现算要 1.9 秒，加上基准（同群其他人的片段统计）还要 1.5 秒 ——
       * 那等于每看一次别人的主页就卡三秒。
       *
       * 而整轮全站只要几秒，因为绝大多数人消息数不到门槛，
       * 在统计之前就返回了。
       */
      name: "常挂在嘴边",
      run: () => computePersonPhrases(),
      describe: (r: ReturnType<typeof computePersonPhrases>) =>
        r.skipped
          ? "跳过（还没到重算的时候）"
          : `${r.groups} 个群 · ${r.people} 人够门槛 · 算出 ${r.written} 个（${r.ms}ms）`,
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
