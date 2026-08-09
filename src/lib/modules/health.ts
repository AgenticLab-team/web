import "server-only";

import { desc, eq, sql } from "drizzle-orm";

import { db, sqlite } from "@/lib/db";
import {
  backupRuns,
  broadcasts,
  links,
  orders,
  syncJobs,
  userSkills,
} from "@/lib/db/schema";
import { offsiteSummary } from "@/lib/backup/offsite";
import { moduleStates } from "@/lib/modules/state";
import { MODULES, type ModuleState } from "@/lib/modules/registry";

/**
 * 每个模块的健康度。
 *
 * 一行数字就够，但那行数字必须是**从明细里现算的**，不是模块自己报的
 * 「我很好」。「运行中」这三个字本身不说明任何事情 ——
 * 一个开着但两天没干活的模块和一个正常的模块，在开关上长得一模一样。
 *
 * 所以每个模块都给出**最近一次真的做了事的时间**。
 */

export interface ModuleHealth extends ModuleState {
  name: string;
  summary: string;
  whenOff: string;
  /** 一行事实，比如「198 条链接 · 117 个域名」 */
  fact: string;
  /** 最近一次真的干活的时间；null = 从来没有过 */
  lastActiveAt: number | null;
  /** 有事要说的时候（长时间没动静、堆积等） */
  warning: string | null;
}

function scalar(query: string, ...args: unknown[]): number {
  return ((sqlite.prepare(query).get(...(args as never[])) as { n: number } | undefined)?.n ?? 0);
}

export function moduleHealth(now = Date.now()): ModuleHealth[] {
  const states = new Map(moduleStates().map((s) => [s.key, s]));

  return MODULES.map((spec) => {
    const state = states.get(spec.key)!;
    const probe = PROBES[spec.key]?.(now) ?? { fact: "—", lastActiveAt: null, warning: null };
    return {
      ...state,
      name: spec.name,
      summary: spec.summary,
      whenOff: spec.whenOff,
      ...probe,
    };
  });
}

type Probe = (now: number) => { fact: string; lastActiveAt: number | null; warning: string | null };

const HOUR = 3600_000;

const PROBES: Record<string, Probe> = {
  sync: (now) => {
    const last = db
      .select()
      .from(syncJobs)
      .where(eq(syncJobs.status, "success"))
      .orderBy(desc(syncJobs.createdAt))
      .get();
    const messages = scalar(`SELECT count(*) n FROM messages`);
    const stale = last?.finishedAt ? now - last.finishedAt > 6 * HOUR : true;
    return {
      fact: `${messages.toLocaleString()} 条消息`,
      lastActiveAt: last?.finishedAt ?? null,
      // 同步停了整站的数据就停了 —— 这是唯一一个「停了会连累所有人」的模块
      warning: stale ? "超过 6 小时没有成功同步过 —— 整站的数据都停在那一刻" : null,
    };
  },

  links: () => {
    const total = scalar(`SELECT count(*) n FROM links`);
    const domains = scalar(`SELECT COUNT(DISTINCT domain) n FROM links`);
    const last = db.select().from(links).orderBy(desc(links.lastSharedAt)).get();
    return {
      fact: `${total} 条链接 · ${domains} 个域名`,
      lastActiveAt: last?.lastSharedAt ?? null,
      warning: null,
    };
  },

  radar: () => {
    const subs = scalar(`SELECT count(*) n FROM keyword_subs WHERE enabled = 1`);
    const hits = scalar(`SELECT count(*) n FROM keyword_hits`);
    const last = db
      .select({ at: sql<number>`MAX(hit_at)` })
      .from(sql`keyword_hits`)
      .get() as { at: number | null } | undefined;
    const people = scalar(`SELECT COUNT(DISTINCT user_id) n FROM keyword_subs`);
    return {
      fact: `${people} 人订阅了 ${subs} 个词 · 累计命中 ${hits}`,
      lastActiveAt: last?.at ?? null,
      warning:
        subs === 0 ? "还没有人订阅任何词 —— 模块开着，但目前不产生任何效果" : null,
    };
  },

  directory: () => {
    const tagged = scalar(`SELECT COUNT(DISTINCT user_id) n FROM user_skills`);
    const tags = scalar(`SELECT COUNT(DISTINCT slug) n FROM user_skills`);
    const last = db.select().from(userSkills).orderBy(desc(userSkills.createdAt)).get();
    return {
      fact: `${tagged} 人填了标签 · ${tags} 个不同的技能`,
      lastActiveAt: last?.createdAt ?? null,
      warning: tagged < 2 ? "填标签的人还太少，按技能找人这件事暂时不成立" : null,
    };
  },

  shop: (now) => {
    const items = scalar(`SELECT count(*) n FROM shop_items WHERE enabled = 1`);
    const pending = scalar(`SELECT count(*) n FROM orders WHERE status = 'pending_ship'`);
    const last = db.select().from(orders).orderBy(desc(orders.createdAt)).get();
    return {
      fact: items === 0 ? "还没有上架任何商品" : `${items} 个在售商品`,
      lastActiveAt: last?.createdAt ?? null,
      warning:
        items === 0
          ? "一个商品都没上架 —— 积分现在只进不出"
          : pending > 0 && last && now - last.createdAt > 3 * 86_400_000
            ? `${pending} 笔实物订单待发货`
            : null,
    };
  },

  broadcast: () => {
    const sent = scalar(`SELECT count(*) n FROM broadcasts WHERE status = 'sent'`);
    const queued = scalar(`SELECT count(*) n FROM broadcasts WHERE status = 'queued'`);
    const last = db.select().from(broadcasts).orderBy(desc(broadcasts.createdAt)).get();
    return {
      fact: `已发 ${sent} 条${queued > 0 ? ` · 排队 ${queued} 条` : ""}`,
      lastActiveAt: last?.createdAt ?? null,
      warning: null,
    };
  },

  offsite: () => {
    const summary = offsiteSummary();
    const last = db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.status, "success"))
      .orderBy(desc(backupRuns.createdAt))
      .get();
    return {
      fact: summary.detail,
      lastActiveAt: last?.finishedAt ?? null,
      warning: summary.status === "ok" ? null : summary.detail,
    };
  },

  prune: () => {
    const auto = sqlite
      .prepare(
        `SELECT created_at n FROM admin_tasks WHERE kind = 'storage.prune.auto'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { n: number } | undefined;
    const cold = scalar(`SELECT count(*) n FROM messages WHERE content = ''`);
    return {
      fact: cold === 0 ? "还没有裁剪过任何正文" : `${cold} 条正文已归档`,
      lastActiveAt: auto?.n ?? null,
      warning: null,
    };
  },

  alerts: () => {
    const firing = scalar(`SELECT count(*) n FROM alerts WHERE state = 'firing'`);
    const undelivered = scalar(
      `SELECT count(*) n FROM alerts WHERE state = 'firing' AND notify_error IS NOT NULL`,
    );
    const last = scalar(`SELECT COALESCE(MAX(notified_at), 0) n FROM alerts`);
    return {
      fact: firing === 0 ? "当前没有告警" : `${firing} 条告警中`,
      lastActiveAt: last > 0 ? last : null,
      warning:
        undelivered > 0 ? `${undelivered} 条告警没能送达 —— 没人收到不代表没出事` : null,
    };
  },

  audit: () => {
    const total = scalar(`SELECT count(*) n FROM audit_logs`);
    const last = scalar(`SELECT COALESCE(MAX(created_at), 0) n FROM audit_logs`);
    return {
      fact: `${total.toLocaleString()} 条记录`,
      lastActiveAt: last > 0 ? last : null,
      warning: null,
    };
  },
};
