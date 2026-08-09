import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";

import {
  alertComponentFor,
  canDeliverViaWechat,
  componentLabel,
  decideAlert,
  formatAlert,
  probeComponentsFor,
  worstStatus,
  type Severity,
} from "@/lib/alerts/rules";
import { db } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules/state";
import { alerts, roles, userRoles, users } from "@/lib/db/schema";
import { runHealthChecks, unhealthySince, type HealthReport } from "@/lib/health";
import { nekobot } from "@/lib/nekobot/client";

/**
 * 告警的检查与投递。健康探测任务每轮跑完调一次。
 *
 * ─────────────────────────────────────────
 * 为什么用**这一轮的探测结果**而不是查最新状态表
 * ─────────────────────────────────────────
 *
 * 上游探测会按失败原因写到 `upstream_api` 或 `frp_tunnel` 两个不同的
 * 组件名下。隧道一断，之后所有失败都记在 `frp_tunnel`，
 * 而 `upstream_api` 那一行**永远停在最后一次「正常」上** ——
 * 查最新状态表会看到一个一直健康的上游接口。
 *
 * 没有新数据不等于没有问题。所以这里只认这一轮真的探到的东西，
 * 并且把两个名字合成一个告警组件（见 alertComponentFor）。
 *
 * ─────────────────────────────────────────
 * 先落库，再发送
 * ─────────────────────────────────────────
 *
 * 微信通道本身走上游 —— 上游断了的时候，「上游断了」这条告警也发不出去。
 * 这不是可以绕过的设计缺陷，是结构性的：报信的人和出事的人是同一个。
 *
 * 所以告警**无论如何先写进数据库**，发送失败把原因记在 notifyError 上，
 * 让「没收到告警」和「告警发失败了」分得开：
 * 前者是没出事，后者是出事了但你不知道。
 *
 * 真正不依赖上游的通道是 /api/health 的 503 —— 留给外部监控去打。
 */

export interface DispatchResult {
  fired: number;
  renotified: number;
  resolved: number;
  delivered: number;
  failed: number;
}

export async function checkAndDispatch(
  reports?: HealthReport[],
  now = Date.now(),
): Promise<DispatchResult> {
  const fresh = reports ?? (await runHealthChecks());
  const result: DispatchResult = {
    fired: 0,
    renotified: 0,
    resolved: 0,
    delivered: 0,
    failed: 0,
  };

  // 合并到告警组件：frp_tunnel + upstream_api → upstream，取最坏的状态
  const grouped = new Map<string, HealthReport[]>();
  for (const report of fresh) {
    const key = alertComponentFor(report.component);
    const list = grouped.get(key);
    if (list) list.push(report);
    else grouped.set(key, [report]);
  }

  for (const [component, group] of grouped) {
    const status = worstStatus(group.map((r) => r.status));
    // detail 取最坏的那条 —— 「磁盘 91%」比「磁盘正常」有用
    const detail =
      group.find((r) => r.status === status)?.detail ?? group[0]?.detail ?? null;

    const existing = db
      .select()
      .from(alerts)
      .where(and(eq(alerts.component, component), eq(alerts.state, "firing")))
      .get();

    const since = unhealthySince(probeComponentsFor(component));

    /*
     * 只要还在报警中且组件仍然不正常，就先把「最后一次看到」推进。
     *
     * 这一步**不能挂在告警动作后面** —— 大多数轮次的判定都是「不重复打扰」，
     * 挂在后面的话 lastSeenAt 会永远停在首次告警的时刻，
     * 后台上看到的就是一条「两小时前出的事」，
     * 分不清是还在坏着还是已经过去了。
     */
    if (existing && status !== "ok") {
      db.update(alerts).set({ lastSeenAt: now }).where(eq(alerts.id, existing.id)).run();
    }

    const verdict = decideAlert({
      component,
      status,
      downForMs: status === "ok" || since === null ? null : now - since,
      state: {
        firing: existing !== undefined,
        notifiedAt: existing?.notifiedAt ?? null,
        attemptedAt: existing?.notifyAttemptedAt ?? null,
      },
      now,
    });

    if (verdict.action === "none") continue;

    /*
     * 重试对这个通道毫无意义就不要重试。
     *
     * 上游挂了的时候微信发不出去，这是确定的（不是「可能失败」）。
     * 每五分钟重试一次只会把行改来改去、日志刷满，
     * 而**告警本身已经在库里，notifyError 也已经写清楚了**。
     * 该看到的东西一条都不少，只是不再假装还在努力。
     */
    if (
      verdict.action === "renotify" &&
      !canDeliverViaWechat(component) &&
      existing?.notifyError
    ) {
      continue;
    }

    if (verdict.action === "resolve") {
      const downFor = existing ? now - existing.firstSeenAt : null;
      db.update(alerts)
        .set({ state: "resolved", resolvedAt: now })
        .where(eq(alerts.id, existing!.id))
        .run();
      result.resolved++;

      const message = formatAlert({
        component,
        status: "ok",
        detail: detail ? `${detail}（中断持续了 ${formatSpan(downFor)}）` : null,
        downForMs: downFor,
        resolved: true,
      });
      const sent = await deliver(component, message, "info");
      if (sent.ok) result.delivered++;
      else result.failed++;
      continue;
    }

    const message = formatAlert({
      component,
      status,
      detail,
      downForMs: since === null ? null : now - since,
    });

    // 先落库。发不出去至少查得到 —— 这是上游挂掉时唯一还起作用的部分
    let alertId: string;
    if (verdict.action === "fire") {
      alertId = db
        .insert(alerts)
        .values({
          component,
          severity: verdict.severity,
          title: message.title,
          body: message.body,
          state: "firing",
          firstSeenAt: since ?? now,
          lastSeenAt: now,
        })
        .returning({ id: alerts.id })
        .get().id;
      result.fired++;
    } else {
      alertId = existing!.id;
      db.update(alerts)
        .set({ severity: verdict.severity, body: message.body })
        .where(eq(alerts.id, alertId))
        .run();
      result.renotified++;
    }

    const sent = await deliver(component, message, verdict.severity);
    db.update(alerts)
      .set({
        // 发失败就**不要**更新 notifiedAt —— 否则重提醒的计时会从一次
        // 根本没送到的通知开始算，故障期间反而更安静
        notifiedAt: sent.ok ? now : (existing?.notifiedAt ?? null),
        notifyAttemptedAt: now,
        notifyError: sent.ok ? null : sent.error,
      })
      .where(eq(alerts.id, alertId))
      .run();

    if (sent.ok) result.delivered++;
    else result.failed++;
  }

  return result;
}

/**
 * 投递告警。
 *
 * 上游相关的告警**不尝试发送** —— 硬发只会失败，
 * 而失败的发送会让人以为「没告警 = 没事」。如实记下「发不出去」更有用。
 */
async function deliver(
  component: string,
  message: { title: string; body: string },
  severity: Severity,
): Promise<{ ok: boolean; error?: string }> {
  /*
   * 模块关掉时**只停投递，不停落库**。
   * 告警照样记下来，只是不再发出去 —— 关掉投递的人应该知道
   * 自己换成了「主动去看后台」，而不是换成了「什么都不会发生」。
   */
  if (!isModuleEnabled("alerts")) {
    return { ok: false, error: "告警投递模块已关闭 —— 告警仍然落库，但没有人会被通知到" };
  }

  if (!canDeliverViaWechat(component)) {
    return {
      ok: false,
      error: "上游故障时微信通道也不可用（同一条链路）—— 只能靠外部监控打 /api/health",
    };
  }

  const targets = alertRecipients();
  if (targets.length === 0) {
    return { ok: false, error: "没有绑定了微信的管理员可以接收告警" };
  }

  const text = `【${severityLabel(severity)}】${message.title}\n${message.body}`;

  let sent = 0;
  let firstError = "";
  for (const wxId of targets) {
    try {
      await nekobot.sendText(wxId, text);
      sent++;
    } catch (error) {
      if (!firstError) firstError = error instanceof Error ? error.message : String(error);
    }
  }

  if (sent === 0) return { ok: false, error: firstError || "全部投递失败" };
  return { ok: true };
}

function severityLabel(severity: Severity): string {
  return severity === "critical" ? "严重" : severity === "warning" ? "警告" : "提示";
}

function formatSpan(ms: number | null): string {
  if (ms === null) return "未知时长";
  if (ms < 60_000) return "不到一分钟";
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)} 分钟`;
  return `${Math.floor(ms / 3600_000)} 小时`;
}

/** 接收告警的人：owner 角色里绑定了微信的 */
function alertRecipients(): string[] {
  const ownerRole = db.select().from(roles).where(eq(roles.key, "owner")).get();
  if (!ownerRole) return [];

  return db
    .select({ wxId: users.wxId })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.roleId, ownerRole.id), isNull(userRoles.revokedAt)))
    .all()
    .map((r) => r.wxId)
    .filter((id): id is string => Boolean(id));
}

export function listAlerts(limit = 50) {
  return db
    .select()
    .from(alerts)
    .orderBy(desc(alerts.firstSeenAt))
    .limit(limit)
    .all()
    .map((a) => ({ ...a, componentLabel: componentLabel(a.component) }));
}

export function firingAlerts() {
  return db
    .select()
    .from(alerts)
    .where(eq(alerts.state, "firing"))
    .orderBy(desc(alerts.firstSeenAt))
    .all()
    .map((a) => ({ ...a, componentLabel: componentLabel(a.component) }));
}

/** 发出去过但投递失败的告警 —— 后台要显眼地告诉人「你没收到不代表没事」 */
export function undeliveredAlerts() {
  return firingAlerts().filter((a) => a.notifyError !== null);
}
