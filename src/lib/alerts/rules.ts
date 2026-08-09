/**
 * 告警判定。纯函数。
 *
 * ─────────────────────────────────────────
 * 告警最大的敌人是告警本身
 * ─────────────────────────────────────────
 *
 * 一个抖动的组件发出五十条消息之后，所有人都会把这个通道静音 ——
 * 而那之后真出事也没人看。**被忽略的告警比没有告警更糟**，
 * 因为它制造了「有人在盯着」的错觉。
 *
 * 所以这里的规则几乎全是在**抑制**告警：
 *   ① 连续挂够久才报（单次探测失败不算）
 *   ② 一次故障只报一次（除非拖太久才重提醒）
 *   ③ 恢复了要发「已恢复」—— 没有收尾的告警会让人一直手动去查
 *
 * ─────────────────────────────────────────
 * 一个诚实的局限
 * ─────────────────────────────────────────
 *
 * 微信通道**本身就走上游**。上游断了的时候，
 * 「上游断了」这条告警也发不出去。这不是可以绕过的设计缺陷，
 * 是结构性的：报信的人和出事的人是同一个。
 *
 * 所以 /api/health 在关键组件挂掉时返回 503 ——
 * 那是唯一不依赖上游的通道，留给外部监控去打。
 */

export type Severity = "info" | "warning" | "critical";

export interface AlertRule {
  /** 连续处于故障状态多久才报 */
  fireAfterMs: number;
  /** 同一次故障多久之后重提醒一次 */
  renotifyAfterMs: number;
  /**
   * 一次都没通知成功过时，隔多久重试一次投递。
   *
   * 这条和 renotify 是两件事：renotify 是「报过了但没人处理」，
   * 重试是「**根本没送到**」。用 renotify 的节奏去等重试，
   * 意味着一次投递失败就换来一小时的沉默 —— 而那一小时里
   * 系统是坏的，且没有任何人知道。
   */
  retryAfterMs: number;
}

/**
 * 探测出来的组件名 → 告警用的组件名。
 *
 * `upstream_api` 和 `frp_tunnel` 是**同一次探测**的两种失败归因：
 * 隧道不通就记 frp_tunnel，通了但接口报错就记 upstream_api。
 * 对告警来说它们是一件事（「拿不到数据了」），必须合成一个 ——
 * 否则隧道断掉的时候，`upstream_api` 那一行会永远停在最后一次
 * 「正常」上，看起来一切都好。**没有新数据不等于没有问题。**
 */
export const ALERT_COMPONENT_ALIASES: Record<string, string> = {
  upstream_api: "upstream",
  frp_tunnel: "upstream",
};

export function alertComponentFor(component: string): string {
  return ALERT_COMPONENT_ALIASES[component] ?? component;
}

/** 一个告警组件对应哪些探测组件 —— 算「挂了多久」时要一起看 */
export function probeComponentsFor(alertComponent: string): string[] {
  const aliased = Object.keys(ALERT_COMPONENT_ALIASES).filter(
    (k) => ALERT_COMPONENT_ALIASES[k] === alertComponent,
  );
  return aliased.length > 0 ? aliased : [alertComponent];
}

const STATUS_RANK: Record<string, number> = { ok: 0, degraded: 1, down: 2 };

/** 合并同一告警组件下多个探测结果 —— 取最坏的那个 */
export function worstStatus(statuses: string[]): "ok" | "degraded" | "down" {
  let worst = "ok";
  for (const s of statuses) {
    if ((STATUS_RANK[s] ?? 0) > (STATUS_RANK[worst] ?? 0)) worst = s;
  }
  return worst as "ok" | "degraded" | "down";
}

export const DEFAULT_RULES: Record<string, AlertRule> = {
  // 上游是数据的唯一来源，断了要快报；但也别为一次网络抖动就吵醒人
  upstream: { fireAfterMs: 5 * 60_000, renotifyAfterMs: 6 * 3600_000, retryAfterMs: 5 * 60_000 },
  // 数据库挂了整站都挂了，用户会先发现，不用抢那几分钟
  db: { fireAfterMs: 2 * 60_000, renotifyAfterMs: 3600_000, retryAfterMs: 5 * 60_000 },
  /*
   * 管理员被强制策略挡在门外。
   *
   * 这个不等 —— 它 down 的含义是「某个有管理权限的人现在进不来」，
   * 而不是「有个指标不好看」。等 10 分钟没有任何意义：
   * 那 10 分钟里他只会以为是自己记错了密码。
   *
   * 但也不重复吵：这不是会自愈的故障，重复提醒改变不了任何事，
   * 要么给他绑一把 Passkey，要么把开关关掉。
   */
  auth: { fireAfterMs: 0, renotifyAfterMs: 24 * 3600_000, retryAfterMs: 10 * 60_000 },
  // 磁盘是慢性问题，报太急只会让人麻木
  disk: { fireAfterMs: 30 * 60_000, renotifyAfterMs: 24 * 3600_000, retryAfterMs: 15 * 60_000 },
  /*
   * 异地备份是「一直缺着」型的问题 —— 没配置的那段时间里它每一轮都不正常。
   * 按分钟级的线去报，等于每天提醒你同一件你已经知道的事，
   * 而那正是让人把整个通道静音的原因。一个月提醒一次刚好。
   */
  offsite: {
    fireAfterMs: 24 * 3600_000,
    renotifyAfterMs: 30 * 86_400_000,
    retryAfterMs: 6 * 3600_000,
  },
  /*
   * 定时任务本身。一轮偶发失败（数据库刚好被锁了）不值得报，
   * 但连着挂半小时说明是真的坏了 —— 而定时任务坏了之后，
   * 同步、结算、告警全都停在那一刻。
   */
  cron: { fireAfterMs: 30 * 60_000, renotifyAfterMs: 12 * 3600_000, retryAfterMs: 10 * 60_000 },
};

export function ruleFor(component: string): AlertRule {
  return (
    DEFAULT_RULES[component] ?? {
      fireAfterMs: 10 * 60_000,
      renotifyAfterMs: 12 * 3600_000,
      retryAfterMs: 10 * 60_000,
    }
  );
}

export interface AlertState {
  /** 已经在报警中 */
  firing: boolean;
  /** 上次通知**成功**的时间。null = 一次都没送到过 */
  notifiedAt: number | null;
  /** 上次**尝试**投递的时间（不管成没成）。用来给重试排节奏 */
  attemptedAt?: number | null;
}

export interface FireInput {
  component: string;
  status: "ok" | "degraded" | "down";
  /** 连续处于当前故障状态多久了。ok 时为 null */
  downForMs: number | null;
  state: AlertState;
  now: number;
}

export type AlertAction = "none" | "fire" | "renotify" | "resolve";

export interface FireVerdict {
  action: AlertAction;
  severity: Severity;
  reason: string;
}

export function decideAlert(input: FireInput): FireVerdict {
  const rule = ruleFor(input.component);

  if (input.status === "ok") {
    // 恢复了要发「已恢复」—— 没有收尾的告警会让人一直手动去查
    if (input.state.firing) {
      return { action: "resolve", severity: "info", reason: "组件已恢复" };
    }
    return { action: "none", severity: "info", reason: "正常" };
  }

  const severity: Severity = input.status === "down" ? "critical" : "warning";
  const downFor = input.downForMs ?? 0;

  /*
   * 单次探测失败不报。
   * 网络抖动、上游重启、一次超时 —— 这些每天都会发生几次，
   * 每次都报的话，这个通道一周内就会被静音。
   */
  if (downFor < rule.fireAfterMs) {
    return {
      action: "none",
      severity,
      reason: `才挂了 ${Math.round(downFor / 60_000)} 分钟，还没到 ${Math.round(rule.fireAfterMs / 60_000)} 分钟的报警线`,
    };
  }

  if (!input.state.firing) {
    return { action: "fire", severity, reason: "持续故障，首次告警" };
  }

  /*
   * 一次都没送到过 —— 要按重试节奏再试。
   *
   * 这里曾经写成「notifiedAt 非空才考虑重发」，结果是
   * **首次投递失败之后再也不会重试**：告警躺在库里，
   * 系统坏着，而没有任何人收到过任何东西。
   * 沉默看起来和「一切正常」一模一样，这是最糟的失败方式。
   */
  if (input.state.notifiedAt === null) {
    const attempted = input.state.attemptedAt ?? null;
    if (attempted === null || input.now - attempted >= rule.retryAfterMs) {
      return { action: "renotify", severity, reason: "之前没能送达，重试投递" };
    }
    return { action: "none", severity, reason: "刚试过投递，等下一轮再重试" };
  }

  // 同一次故障只报一次，除非拖得太久 —— 那说明没人在处理
  if (input.now - input.state.notifiedAt >= rule.renotifyAfterMs) {
    return { action: "renotify", severity, reason: "故障持续，重新提醒" };
  }

  return { action: "none", severity, reason: "已经报过了，不重复打扰" };
}

/**
 * 这条告警能不能靠微信发出去。
 *
 * **上游相关的告警发不出去** —— 微信通道本身就走上游，
 * 报信的人和出事的人是同一个。硬发只会失败，
 * 而失败的发送会让人以为「没告警 = 没事」。
 */
export function canDeliverViaWechat(component: string): boolean {
  return alertComponentFor(component) !== "upstream";
}

export function formatAlert(input: {
  component: string;
  status: string;
  detail: string | null;
  downForMs: number | null;
  resolved?: boolean;
}): { title: string; body: string } {
  const name = componentLabel(input.component);

  if (input.resolved) {
    return {
      title: `${name}已恢复`,
      body: input.detail ?? "组件恢复正常",
    };
  }

  const duration = input.downForMs !== null ? formatDuration(input.downForMs) : "";
  return {
    title: `${name}${input.status === "down" ? "中断" : "不稳定"}`,
    body: [
      duration && `已经持续 ${duration}`,
      input.detail,
      HINTS[input.component],
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/** 告警里带上「先查什么」—— 半夜被叫醒的人不该还要自己回忆 */
const HINTS: Record<string, string> = {
  upstream: "先查 frp 隧道：ssh 上去看 127.0.0.1:8090 通不通",
  db: "查磁盘是否写满、WAL 是否损坏",
  offsite: "看 /admin/backup：是没配置、传失败，还是该做恢复演练了",
  cron: "journalctl -u agenticlab-health -n 50 —— 详情里已经写了是哪一步",
  disk: "跑存储裁剪，或清理媒体缓存",
};

export const COMPONENT_LABELS: Record<string, string> = {
  upstream: "上游（frp 隧道 / 接口）",
  upstream_api: "上游接口",
  frp_tunnel: "frp 隧道",
  db: "数据库",
  disk: "磁盘",
  offsite: "异地备份",
  cron: "定时任务",
  auth: "管理员登录保护",
  sync: "同步任务",
};

export function componentLabel(component: string): string {
  return COMPONENT_LABELS[component] ?? component;
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return "不到一分钟";
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)} 分钟`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3600_000)} 小时`;
  return `${Math.floor(ms / 86_400_000)} 天`;
}

export const SEVERITY_LABELS: Record<Severity, string> = {
  info: "提示",
  warning: "警告",
  critical: "严重",
};
