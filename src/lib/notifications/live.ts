import "server-only";

import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { createPushDispatcher, type PushDispatcher } from "@/lib/notifications/push-dispatch";

/**
 * 站内即时通知的服务端：轮询数据库、扇出给在线的 SSE 连接、喂给推送投递。
 *
 * ─────────────────────────────────────────
 * 为什么是「服务端轮询数据库」而不是写入时发事件
 * ─────────────────────────────────────────
 *
 * 直觉的做法是在 notify() 写库时同时 emit 一个进程内事件。放弃它，
 * 因为通知**不只有 Web 进程在写**：关键词雷达跑在 5 分钟一轮的
 * cron 进程里（scripts/ 下，systemd 拉起），它写的行进程内事件永远看不见。
 * 「@ 能即时、雷达要刷新才看到」这种一半灵一半不灵的即时通知，
 * 比统一慢三秒更难被信任。轮询数据库对所有写入方一视同仁，
 * 也让 notify() 完全不用知道推送这回事。
 *
 * 代价是延迟上限 = 轮询间隔（3 秒），以及每 3 秒一次的索引查询。
 * 后者在 notifications_updated_idx 上是 O(新增行数)，SQLite 在同进程内
 * 走内存页缓存，1800 用户的量级下可以忽略。
 *
 * ─────────────────────────────────────────
 * 为什么是 SSE 而不是 WebSocket / 客户端轮询
 * ─────────────────────────────────────────
 *
 * · WebSocket：Next.js 的路由层不承载 WS，得另起自定义服务器；
 *   而这里根本没有客户端→服务端的实时消息，双向能力纯属浪费。
 * · 客户端轮询：每次轮询都要过一遍会话解析 + 路由，几百人在线时
 *   等于每 5 秒一波小洪峰打在单台小服务器上；SSE 每人只解析一次会话。
 * · SSE：一条普通 HTTP 长连接，微信内置浏览器也支持；EventSource
 *   自带断线重连和 Last-Event-ID，「补漏」有协议级的挂点（见 route.ts）。
 *
 * ─────────────────────────────────────────
 * 水位线与去重
 * ─────────────────────────────────────────
 *
 * 用 `updatedAt >= 水位线` 而不是 `>`：毫秒同刻写入的第二行如果用严格
 * 大于会永远漏掉，而漏一条 @ 比重复看到一条糟得多。重复由 lastKeys
 * 兜住 —— 键里带 count，同一毫秒内聚合计数变了也能被识别成新动静。
 */

export interface LiveNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  count: number;
  updatedAt: number;
  /** 当前未读总数 —— 客户端拿绝对值刷角标，事件重复到达也不会数错 */
  unread: number;
}

type Subscriber = (event: LiveNotification) => void;

interface Registered {
  fn: Subscriber;
  /** 被更新的连接挤掉时通知路由端收尾 */
  onEvict: () => void;
}

interface WatcherState {
  subscribers: Map<string, Set<Registered>>;
  /** 只往前推的时间水位线；进程启动时从「现在」开始，不回放历史 */
  watermark: number;
  /** 上一轮已派发的 `${id}:${updatedAt}:${count}`，配合 >= 查询去重 */
  lastKeys: Set<string>;
  timer: ReturnType<typeof setInterval> | null;
  dispatcher: PushDispatcher;
}

/** 同一个人最多同时挂几条 SSE —— 开了一堆微信浮窗的人不该占满连接数 */
const MAX_STREAMS_PER_USER = 4;

const POLL_INTERVAL_MS = 3_000;

/*
 * 状态挂在 globalThis：开发模式热重载会换掉模块实例，
 * 不挂的话每次改代码都多出一个幽灵定时器，各自持有旧的订阅表。
 */
const g = globalThis as unknown as { __alLiveWatcher?: WatcherState };

function state(): WatcherState {
  if (!g.__alLiveWatcher) {
    g.__alLiveWatcher = {
      subscribers: new Map(),
      watermark: Date.now(),
      lastKeys: new Set(),
      timer: null,
      dispatcher: createPushDispatcher(),
    };
  }
  return g.__alLiveWatcher;
}

export function unreadCountOf(userId: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .get()?.n ?? 0
  );
}

/**
 * 断线补漏的查询：某人从 since 起（含）**还没读过**的动静，旧的在前。
 *
 * 含端点（>=）是有意的：客户端的游标就是最后一条的 updatedAt，
 * 同一毫秒可能还有它没见过的第二条。漏发没有任何机制能补救，
 * 所以宁可在边界上重发。
 *
 * ─────────────────────────────────────────
 * 为什么这里必须看 readAt
 * ─────────────────────────────────────────
 *
 * 「边界重发一条由客户端按 id 幂等消化」这句话曾经是假的：客户端那份
 * 幂等记忆（seen 集合）只活在 effect 的闭包里，**整页重新加载就没了**。
 * 而游标恰好就等于最后一条的 updatedAt，>= 又必然把它带回来 ——
 * 于是「弹过的通知，每刷新一次原样再弹一次」，刷几次弹几次。
 *
 * 真正的修法不是把 >= 改成 >（那会丢同毫秒的第二条），
 * 而是认清**「这条我已经知道了」的真值只有一份，就是 readAt**。
 * localStorage 里的游标只回答「从哪个时刻开始补」，它回答不了
 * 「哪几条已经消化过」—— 让它兼任第二份「读到哪了」，两份必然分叉，
 * 分叉的表现就是重复弹窗。
 *
 * 已读的一律不补，无论用户是在通知中心点掉的、在另一台设备上点掉的、
 * 还是点着吐司进帖子的：他已经知道这件事了。
 */
export function listSince(userId: string, since: number, limit = 100): LiveNotification[] {
  const rows = db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        gte(notifications.updatedAt, since),
        /*
         * 已读过滤必须落在 SQL 里，不能取回来再 filter：
         * 后者 limit 先被一堆已读旧闻占满，真正要补的未读反而被截掉 ——
         * 表现是断线期间被 @ 了却什么都没补上，比重复弹窗糟得多。
         * 走 notifications_user_idx(user_id, read_at, updated_at)，不额外加索引。
         */
        isNull(notifications.readAt),
      ),
    )
    .orderBy(asc(notifications.updatedAt))
    .limit(limit)
    .all();

  const unread = unreadCountOf(userId);
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    link: row.link,
    count: row.count,
    updatedAt: row.updatedAt,
    unread,
  }));
}

/** 订阅某人的实时通知；返回退订函数。超出连接上限时挤掉最旧的那条。 */
export function subscribeLive(userId: string, fn: Subscriber, onEvict: () => void = () => {}): () => void {
  const s = state();
  startWatcher();

  let set = s.subscribers.get(userId);
  if (!set) {
    set = new Set();
    s.subscribers.set(userId, set);
  }
  while (set.size >= MAX_STREAMS_PER_USER) {
    const oldest = set.values().next().value as Registered;
    set.delete(oldest);
    oldest.onEvict();
  }

  const entry: Registered = { fn, onEvict };
  set.add(entry);

  return () => {
    const current = s.subscribers.get(userId);
    if (!current) return;
    current.delete(entry);
    if (current.size === 0) s.subscribers.delete(userId);
  };
}

/** 幂等启动。instrumentation.ts 在进程起来时调一次，保证没人在线也能投递推送 */
export function startWatcher(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => {
    try {
      pollOnce();
    } catch {
      /*
       * 轮询抛异常只能吞掉：这里没有请求上下文，抛出去等于杀掉定时器，
       * 之后所有人的实时通知与推送都停 —— 而下一轮很可能就恢复了。
       */
    }
  }, POLL_INTERVAL_MS);
  // 不拦着进程退出 —— 测试和脚本引入这个模块不该因此挂住
  s.timer.unref?.();
}

export function stopWatcher(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}

/** 拉一轮增量并派发。导出是为了测试能不依赖真实时钟驱动它。 */
export function pollOnce(): void {
  const s = state();

  // 没人在线且推送也没法投的时候，一次查询都不必发
  if (s.subscribers.size === 0 && !s.dispatcher.enabled()) {
    s.dispatcher.flushDue();
    return;
  }

  const rows = db
    .select()
    .from(notifications)
    .where(gte(notifications.updatedAt, s.watermark))
    .orderBy(asc(notifications.updatedAt))
    .limit(500)
    .all();

  const keys = new Set<string>();
  const fresh: typeof rows = [];
  for (const row of rows) {
    const key = `${row.id}:${row.updatedAt}:${row.count}`;
    keys.add(key);
    if (!s.lastKeys.has(key)) fresh.push(row);
  }
  s.lastKeys = keys;
  if (rows.length > 0) {
    s.watermark = Math.max(s.watermark, rows[rows.length - 1].updatedAt);
  }

  if (fresh.length > 0) {
    // 未读数每人每轮只算一次 —— 它是事件里最贵的部分
    const unreadByUser = new Map<string, number>();
    for (const row of fresh) {
      const set = s.subscribers.get(row.userId);
      if (!set || set.size === 0) continue;
      let unread = unreadByUser.get(row.userId);
      if (unread === undefined) {
        unread = unreadCountOf(row.userId);
        unreadByUser.set(row.userId, unread);
      }
      const event: LiveNotification = {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        link: row.link,
        count: row.count,
        updatedAt: row.updatedAt,
        unread,
      };
      for (const sub of set) {
        try {
          sub.fn(event);
        } catch {
          // 单条连接写失败不影响其他人；连接自身的收尾由路由的 abort 处理
        }
      }
    }

    s.dispatcher.offer(
      fresh.map((row) => ({
        userId: row.userId,
        type: row.type,
        title: row.title,
        body: row.body,
        link: row.link,
      })),
    );
  }

  // 冷却期攒下的推送到点要发，哪怕这一轮没有新通知
  s.dispatcher.flushDue();
}

/** 测试用：把水位线拨回去/清空状态，模拟进程重启 */
export function resetWatcherForTest(watermark = Date.now()): void {
  stopWatcher();
  g.__alLiveWatcher = undefined;
  state().watermark = watermark;
}
