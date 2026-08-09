import "server-only";

import { isEnabled, type PrefsMap } from "@/lib/notifications/prefs";
import { getPrefs } from "@/lib/notifications/store";
import {
  listActivePushSubscriptions,
  recordPushFailure,
  recordPushSuccess,
} from "@/lib/notifications/push-store";
import {
  getWebPushConfig,
  sendWebPush,
  type PushSendResult,
  type PushTarget,
  type WebPushConfig,
} from "@/lib/notifications/webpush";

/**
 * 推送投递：把轮询发现的新通知变成锁屏推送。
 *
 * ─────────────────────────────────────────
 * 为什么要冷却与合并
 * ─────────────────────────────────────────
 *
 * 站内的聚合（「3 人回复了你的帖子」）挡不住这里的洪水：聚合行每次
 * count+1 都是一次 updatedAt 变更，也就是一次新动静。热帖下每条回复
 * 都往锁屏上打一条的话，用户当晚就会在**系统层**关掉整个站的通知权限，
 * 那之后连 @ 也到不了 —— 而我们没有任何办法知道、更没有办法开回来。
 *
 * 所以：第一条立即发（「即时」的意义所在），此后 30 秒冷却；
 * 冷却期内的动静**攒着不丢**，到点合并成一条「还有 N 条新动静」。
 * 直接丢的话，用户看到推送点进来发现远不止一条，下一次他就不信推送了。
 *
 * ─────────────────────────────────────────
 * 没配置时
 * ─────────────────────────────────────────
 *
 * enabled() 为 false，offer() 是空操作 —— 不缓存、不报错、不假装。
 * 「没配置」这件事由 health.ts 的 probeWebPush 负责让人看见，
 * 这里安静地不工作就是它该有的样子。
 */

export interface OfferedNotification {
  userId: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
}

export interface PushDispatcherDeps {
  getConfig: () => WebPushConfig | null;
  getPrefs: (userId: string) => PrefsMap;
  listSubs: (userId: string) => (PushTarget & { id: string })[];
  send: (target: PushTarget, payload: unknown, config: WebPushConfig) => Promise<PushSendResult>;
  onResult: (subId: string, result: PushSendResult) => void;
  now: () => number;
}

export interface PushDispatcher {
  enabled: () => boolean;
  offer: (rows: OfferedNotification[]) => void;
  flushDue: () => void;
}

export const PUSH_COOLDOWN_MS = 30_000;

interface UserState {
  lastSentAt: number;
  /** 冷却期内攒下的条数与最新一条 —— 只留摘要，内存不随洪水线性涨 */
  pendingCount: number;
  latest: OfferedNotification | null;
}

const defaultDeps: PushDispatcherDeps = {
  getConfig: getWebPushConfig,
  getPrefs,
  listSubs: (userId) => listActivePushSubscriptions(userId),
  send: sendWebPush,
  onResult: (subId, result) => {
    if (result.ok) recordPushSuccess(subId);
    else recordPushFailure(subId, result.error ?? `status=${result.status}`, result.gone);
  },
  now: Date.now,
};

export function createPushDispatcher(overrides: Partial<PushDispatcherDeps> = {}): PushDispatcher {
  const deps: PushDispatcherDeps = { ...defaultDeps, ...overrides };
  const users = new Map<string, UserState>();

  // 密钥是启动期常量，没必要每 3 秒做一次 ECDH 校验
  let cachedConfig: WebPushConfig | null | undefined;
  const config = () => {
    if (cachedConfig === undefined) cachedConfig = deps.getConfig();
    return cachedConfig;
  };

  function flushUser(userId: string, s: UserState): void {
    const c = config();
    if (!c || s.pendingCount === 0 || !s.latest) return;

    const subs = deps.listSubs(userId);
    const latest = s.latest;
    const n = s.pendingCount;
    s.pendingCount = 0;
    s.latest = null;
    s.lastSentAt = deps.now();
    // 没有订阅设备就把攒的丢掉 —— 留着只会在用户订阅的那一刻收到一堆旧闻
    if (subs.length === 0) return;

    const payload = {
      title: latest.title,
      body: n > 1 ? `还有 ${n - 1} 条新动静` : (latest.body ?? ""),
      link: latest.link ?? "/notifications",
      count: n,
    };

    for (const sub of subs) {
      /*
       * 发送不 await：这里跑在 3 秒一轮的轮询循环里，一个响应慢的
       * 推送服务不能拖住所有人的站内实时通知。结果异步落库。
       */
      void deps
        .send({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload, c)
        .then((result) => deps.onResult(sub.id, result))
        .catch(() => {
          /* send 自身已把异常折叠成 result；这里兜底防 onResult 抛出 */
        });
    }
  }

  return {
    enabled: () => config() !== null,

    offer(rows) {
      if (!config()) return;
      for (const row of rows) {
        // 推送通道的偏好在这里判 —— 站内已收（site 开）但不想上锁屏（push 关）是常见组合
        if (!isEnabled(deps.getPrefs(row.userId), row.type, "push")) continue;
        let s = users.get(row.userId);
        if (!s) {
          s = { lastSentAt: 0, pendingCount: 0, latest: null };
          users.set(row.userId, s);
        }
        s.pendingCount += 1;
        s.latest = row;
      }
      this.flushDue();
    },

    flushDue() {
      if (!config()) return;
      const now = deps.now();
      for (const [userId, s] of users) {
        if (s.pendingCount === 0) continue;
        if (now - s.lastSentAt < PUSH_COOLDOWN_MS) continue;
        flushUser(userId, s);
      }
    },
  };
}
