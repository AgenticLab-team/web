import "server-only";

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";

import { count, desc, eq, inArray, sql } from "drizzle-orm";

import { listGroupsForAdmin } from "@/lib/admin/groups";
import { passkeyLockoutRisk } from "@/lib/auth/passkey-enforcement";
import { describeRisk } from "@/lib/auth/passkey-policy";
import { db, sqlite } from "@/lib/db";
import { githubConnections, storageSnapshots, systemHealth } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { githubEnabled } from "@/lib/github/secret";
import { NekoBotError, nekobot } from "@/lib/nekobot/client";
import { pushSubscriptionSummary } from "@/lib/notifications/push-store";
import { configProblem, webPushConfigured } from "@/lib/notifications/webpush";
import { offsiteSummary } from "@/lib/backup/offsite";
import { getSettingInt } from "@/lib/settings/store";
import { classifyCollection } from "@/lib/sync/collection-health";

/**
 * 健康探测。
 *
 * frp 隧道是**单点** —— 家里那台机器掉线，整个数据源就断了。
 * 光有重试不够，必须留下可查的记录，否则事后只能看到「同步失败」不知道断了多久。
 */

export type HealthStatus = "ok" | "degraded" | "down";

export interface HealthReport {
  component: string;
  status: HealthStatus;
  detail?: string;
  latencyMs?: number;
}

/**
 * 探一次上游，**同时给出 frp_tunnel 和 upstream_api 两个组件的状态**。
 *
 * ─────────────────────────────────────────
 * 原来这里只返回其中一个，于是 frp_tunnel 会永远卡在 down
 * ─────────────────────────────────────────
 *
 * 老写法是：失败且判定为上游不可达 → 写 `frp_tunnel: down`；
 * 成功 → 写 `upstream_api: ok`。
 *
 * 也就是说**没有任何一条路径会把 `frp_tunnel` 写回 ok**。
 * 隧道断过一次之后，那一行永远停在 down；而站点总状态取所有组件里
 * 最差的那个 —— 于是隧道恢复了、消息也照常同步了，
 * 首页和 `/api/health` 仍然一直说「down」。
 *
 * 这比一个没做的功能糟：它让健康状态**变成了一个学会撒谎的仪表盘**。
 * 看过两次「明明好了还说坏」之后，真出事那次也不会有人信。
 *
 * 所以每一轮都为两个组件各写一个明确的状态：
 *
 * · 通了 → 两个都 ok
 * · 隧道不通 → 两个都 down。**upstream_api 也要标 down** ——
 *   隧道断的时候我们对那头的 API 一无所知，而「不知道」在
 *   健康检查里只能算坏；标成 ok 是在替一个探不到的东西打包票
 * · 隧道通、但 API 报错 → frp_tunnel ok，upstream_api down。
 *   这一分就是这两个组件存在的全部意义：**它区分「家里那台机器
 *   没连上来」和「机器连上来了但 NekoBot 出错了」**，
 *   而这两件事要做的处理完全不同
 */
export async function probeUpstream(): Promise<HealthReport[]> {
  const started = Date.now();
  try {
    const who = await nekobot.whoami();
    const latency = Date.now() - started;
    return [
      { component: "frp_tunnel", status: "ok", detail: "隧道通", latencyMs: latency },
      {
        component: "upstream_api",
        // 隧道通但很慢，通常是家里那台机器负载高或网络抖动
        status: latency > 5000 ? "degraded" : "ok",
        detail: `key=${who.prefix} 累计调用 ${who.calls}`,
        latencyMs: latency,
      },
    ];
  } catch (err) {
    const latency = Date.now() - started;
    const tunnelDown = err instanceof NekoBotError && err.isUpstreamDown;
    const detail = err instanceof Error ? err.message.slice(0, 200) : String(err);

    return [
      {
        component: "frp_tunnel",
        status: tunnelDown ? "down" : "ok",
        detail: tunnelDown ? detail : "隧道通（上游自己报的错，见 upstream_api）",
        latencyMs: latency,
      },
      {
        component: "upstream_api",
        status: "down",
        detail: tunnelDown ? `隧道不通，探不到：${detail}` : detail,
        latencyMs: latency,
      },
    ];
  }
}

export function probeDatabase(): HealthReport {
  const started = Date.now();
  try {
    const integrity = sqlite.pragma("quick_check", { simple: true });
    return {
      component: "db",
      status: integrity === "ok" ? "ok" : "degraded",
      detail: String(integrity),
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      component: "db",
      status: "down",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function probeDisk(): HealthReport {
  const snapshot = takeStorageSnapshot();
  const warn = getSettingInt("storage.disk_warn_pct", 70);
  const prune = getSettingInt("storage.disk_prune_pct", 85);

  return {
    component: "disk",
    status: snapshot.diskPct >= prune ? "down" : snapshot.diskPct >= warn ? "degraded" : "ok",
    detail: `磁盘 ${snapshot.diskPct}% · 库 ${(snapshot.dbBytes / 1048576).toFixed(1)}MB`,
  };
}

export function takeStorageSnapshot() {
  const dbPath = resolve(env.db.path);
  const dbBytes = safeSize(dbPath) + safeSize(`${dbPath}-wal`);

  // FTS 索引占了库里多少：把 messages_fts 相关的表加起来
  const ftsBytes = Number(
    (
      sqlite
        .prepare(
          `SELECT COALESCE(SUM(pgsize), 0) AS n FROM dbstat WHERE name LIKE 'messages_fts%'`,
        )
        .get() as { n: number } | undefined
    )?.n ?? 0,
  );

  let diskTotal = 0;
  let diskUsed = 0;
  try {
    const out = execFileSync("df", ["-B1", "--output=size,used", dbPath], {
      encoding: "utf8",
    });
    const [size, used] = out.trim().split("\n")[1].trim().split(/\s+/).map(Number);
    diskTotal = size;
    diskUsed = used;
  } catch {
    /* df 不可用就留 0，不影响其它指标 */
  }

  const byTable = sqlite
    .prepare(
      `SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 12`,
    )
    .all() as { name: string; bytes: number }[];

  const snapshot = {
    dbBytes,
    ftsBytes,
    mediaCacheBytes: 0,
    thumbBytes: 0,
    diskTotal,
    diskUsed,
    diskPct: diskTotal ? Math.round((diskUsed / diskTotal) * 100) : 0,
    byTable,
  };

  db.insert(storageSnapshots).values(snapshot).run();
  return snapshot;
}

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * 异地备份。
 *
 * 「没配置」报的是 degraded 而不是 ok —— 备份和归档都只在这一块磁盘上，
 * 这是个真实存在的缺口，不该因为「本来就没开」就显示成正常。
 * 但也不报 down：站是活的，只是没有后路。
 */
export function probeOffsite(): HealthReport {
  const summary = offsiteSummary();
  if (summary.status === "ok") {
    return { component: "offsite", status: "ok", detail: summary.detail };
  }
  return {
    component: "offsite",
    // 失败了才算 down；没配置/过期/没验证过都是 degraded —— 有区别
    status: summary.status === "failing" ? "down" : "degraded",
    detail: summary.detail,
  };
}

/**
 * 管理员的第二重保护。
 *
 * 这一项探的不是「服务活没活着」，而是**一条安全规则现在是什么状态**。
 * 放进健康检查是因为它和别的缺口一样，需要一直看得见 ——
 * 而它比别的缺口更容易被忘掉：它平时什么都不做，
 * 只在某个管理员某天登不进来的那一刻才被人想起。
 *
 * 三档的分法：
 *   · 开着、没人被挡  → ok
 *   · **开着、有人被挡** → down：这不是「有个缺口」，是有人现在进不来
 *   · 没开             → degraded：管理员账号只有一道密码，是个真实的缺口
 */
export function probeAuthPolicy(): HealthReport {
  const risk = passkeyLockoutRisk();
  return {
    component: "auth",
    status: risk.active ? "down" : risk.enforced ? "ok" : "degraded",
    detail: describeRisk(risk),
  };
}

/**
 * Web Push 的配置状态。
 *
 * 与 probeOffsite 同一条原则：「没配置」报 degraded 而不是 ok ——
 * 推送没配时用户看到的订阅界面会如实说「暂未开通」，但运维侧
 * 也必须有一个一直亮着的黄灯，否则「忘了配」和「不打算配」没法区分。
 *
 * 比没配更危险的是**配错**（比如轮换时只换了公钥）：那种状态下每次
 * 投递都被推送服务拒掉，而站内一切正常，没有任何页面会变红 ——
 * 所以配了但校验不过要报 down，它是真故障，不是缺口。
 */
export function probeWebPush(): HealthReport {
  const problem = configProblem();
  if (problem === null) {
    const subs = pushSubscriptionSummary();
    return {
      component: "web_push",
      status: "ok",
      detail: `已配置 · ${subs.active} 个订阅在投${subs.disabled ? ` · ${subs.disabled} 个已停用` : ""}`,
    };
  }
  return {
    component: "web_push",
    status: webPushConfigured() ? "down" : "degraded",
    detail: problem,
  };
}

/**
 * GitHub 生态接没接上。
 *
 * ═════════════════════════════════════════
 * 「不配就整个消失」是对的，但它太安静了
 * ═════════════════════════════════════════
 *
 * 没配 OAuth 时绑定入口不渲染、路由 404 —— 这个设计本身没问题
 * （半套配置比没配置更糟：按钮照常出现、点下去走到一半才在
 * GitHub 那边失败，而用户会以为是自己的 GitHub 有问题）。
 *
 * 但它安静到**站长看不出这一整块是关着的**。线上实测：
 * 绑定 0 人、仓库缓存 0 条 —— 不是没人想用，是入口根本没出现过，
 * 而后台任何一处都没说这件事。
 *
 * 一个「做了但没人看得见」的功能和没做，唯一的区别就是
 * 有没有一个地方说得出它是关着的。
 *
 * ═════════════════════════════════════════
 * 没配不算故障
 * ═════════════════════════════════════════
 *
 * 状态是 `degraded` 不是 `down`：站长可能就是不想接 GitHub。
 * 报成 down 会让总状态一直红着，而一个一直红着的仪表盘
 * 会让真出事那次也没人看 —— 和 frp 那次是同一个道理。
 */
export function probeGithub(): HealthReport {
  if (!githubEnabled()) {
    return {
      component: "github",
      status: "degraded",
      detail:
        "没配 OAuth（GITHUB_CLIENT_ID / SECRET / TOKEN_KEY）—— " +
        "绑定入口不渲染、路由 404，主页项目展示和「要不要发帖分享」整块都不会出现",
    };
  }

  const linked = db.select({ n: count() }).from(githubConnections).get()?.n ?? 0;
  const shown =
    db
      .select({ n: count() })
      .from(githubConnections)
      .where(eq(githubConnections.showOnProfile, true))
      .get()?.n ?? 0;

  /*
   * 配了但一个人都没绑，仍然值得说一句 —— 那多半意味着入口埋得太深，
   * 而不是大家都不想绑。
   */
  if (linked === 0) {
    return {
      component: "github",
      status: "degraded",
      detail: "已配置，但还没有人绑定 —— 入口在「我的 → 账号安全」里",
    };
  }

  const token = env.github.apiToken ? "有只读 token（5000 次/小时）" : "没配只读 token（按服务器 IP 60 次/小时，容易撞限流）";
  return {
    component: "github",
    status: "ok",
    detail: `${linked} 人绑定 · ${shown} 人在主页展示项目 · ${token}`,
  };
}

/** 跑一轮完整探测并落库 */
/**
 * 采集有没有在收数据。
 *
 * ─────────────────────────────────────────
 * `upstream_api` 回答不了这个问题
 * ─────────────────────────────────────────
 *
 * 那一项问的是「接口通不通」。而线上丢掉的那 15 天里，
 * 接口大概率一直是通的 —— 只是**没有新数据**：
 * 返回 200、内容为空，探测一路绿灯，归档静静地缺了半个月。
 *
 * 逐群的新鲜度判定 `classifyFreshness` 早就有了，
 * 但它只渲染在群页上，从没进过 `system_health`，够不到告警。
 * 这一项就是把它接上去。
 */
export function probeCollection(now = Date.now()): HealthReport {
  const groups = listGroupsForAdmin(now).filter((g) => g.syncEnabled);
  const verdict = classifyCollection({
    groups: groups.map((g) => ({ level: g.freshness.level, dailyAverage: g.dailyAverage })),
  });
  return { component: "collection", status: verdict.status, detail: verdict.detail };
}

export async function runHealthChecks(): Promise<HealthReport[]> {
  const reports = [
    // 上游一次返回两条（隧道 + API），摊平进来
    ...(await probeUpstream()),
    probeDatabase(),
    probeDisk(),
    probeOffsite(),
    probeAuthPolicy(),
    probeWebPush(),
    probeCollection(),
    probeGithub(),
  ];
  for (const report of reports) {
    db.insert(systemHealth)
      .values({
        component: report.component as
          | "upstream_api"
          | "frp_tunnel"
          | "db"
          | "disk"
          | "offsite"
          | "auth"
          | "web_push"
          | "collection",
        status: report.status,
        detail: report.detail,
        latencyMs: report.latencyMs,
      })
      .run();
  }
  return reports;
}

/**
 * 记下这一轮定时任务本身的健康状态。
 *
 * 写完之后由**下一轮**的告警判定读到 —— 这一轮的告警投递
 * 排在所有步骤之前就结束了，它不可能知道自己这一轮的结果。
 *
 * 定时器 5 分钟一轮、cron 的报警线是 30 分钟，
 * 所以真的坏了会在半小时内报出来；偶发一次不会。
 */
export function recordTickHealth(status: HealthStatus, detail: string): void {
  db.insert(systemHealth).values({ component: "cron", status, detail }).run();
}

/** 上一轮定时任务的状态，喂给这一轮的告警判定 */
export function lastTickHealth(): HealthReport | null {
  const row = db
    .select()
    .from(systemHealth)
    .where(sql`${systemHealth.component} = 'cron'`)
    .orderBy(desc(systemHealth.checkedAt))
    .limit(1)
    .get();
  if (!row) return null;
  return { component: "cron", status: row.status, detail: row.detail ?? undefined };
}

/** 各组件的最新状态，供后台首屏与 /api/health 使用 */
export function latestHealth() {
  return db
    .all<{ component: string; status: string; detail: string; checked_at: number }>(sql`
      SELECT component, status, detail, checked_at FROM (
        SELECT component, status, detail, checked_at,
               ROW_NUMBER() OVER (PARTITION BY component ORDER BY checked_at DESC) AS rn
        FROM system_health
      ) WHERE rn = 1
    `);
}

/**
 * 从什么时候开始不正常的 —— 用来判断该不该告警。
 *
 * 算的是 `ok` 以外的**连续**记录（degraded 也算），
 * 因为「一直半死不活」和「彻底断了」都需要有人去看；
 * 只盯 down 的话，一个持续降级的上游会永远不报警。
 *
 * 传多个组件时当成一个整体看 —— frp_tunnel 和 upstream_api
 * 是同一次探测的两种归因，分开算会两边都够不到报警线。
 */
export function unhealthySince(components: string[]): number | null {
  if (components.length === 0) return null;
  const rows = db
    .select()
    .from(systemHealth)
    .where(
      inArray(
        systemHealth.component,
        components as ("upstream_api" | "frp_tunnel" | "db" | "disk" | "offsite" | "collection")[],
      ),
    )
    .orderBy(desc(systemHealth.checkedAt))
    .limit(200)
    .all();

  let since: number | null = null;
  for (const row of rows) {
    if (row.status === "ok") break;
    since = row.checkedAt;
  }
  return since;
}

