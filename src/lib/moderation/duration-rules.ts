/**
 * 封禁 / 暂停的期限。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * `duration_seconds` 和 `expires_at` 都是零引用
 * ─────────────────────────────────────────
 *
 * `moderation_actions` 上这两列在 schema 之外没有任何地方读或写。
 * 也就是说**每一次封禁都是永久的** —— 「封 7 天」这件事做不到，
 * 想解封只能有人记得手动回来解。
 *
 * 而后果落在被封的人身上：他打开「处罚与申诉」看到的是一句
 * 没有期限的「已封禁」。一个不知道什么时候结束的处罚，
 * 和永久封禁在心理上是一回事 —— 于是他不会等，他会走。
 *
 * ─────────────────────────────────────────
 * 到期要自己解开，不能靠人记得
 * ─────────────────────────────────────────
 *
 * 只写一个 `expires_at` 而没有人去扫它，等于把「7 天」写成了
 * 一句安慰话。所以这一批同时要有一个结算步骤，
 * 挂在已经在跑的那一轮定时任务上。
 */

/** 预设的几档。手填任意秒数没有意义 —— 处罚的长度是个态度，不是精确量 */
export const PRESETS = [
  { label: "1 小时", seconds: 3600 },
  { label: "1 天", seconds: 86_400 },
  { label: "3 天", seconds: 3 * 86_400 },
  { label: "7 天", seconds: 7 * 86_400 },
  { label: "30 天", seconds: 30 * 86_400 },
  { label: "永久", seconds: null },
] as const;

export const MAX_DURATION_SECONDS = 365 * 86_400;

export type DurationVerdict =
  | { ok: true; durationSeconds: number | null; expiresAt: number | null }
  | { ok: false; error: string };

export function checkDuration(seconds: number | null, now: number): DurationVerdict {
  if (seconds === null) return { ok: true, durationSeconds: null, expiresAt: null };

  if (!Number.isInteger(seconds) || seconds <= 0) {
    return { ok: false, error: "期限要是正整数秒，永久就留空" };
  }
  if (seconds > MAX_DURATION_SECONDS) {
    /*
     * 超过一年的定期封禁没有意义 —— 那就是永久，
     * 而写成「364 天」只是让人以为还有指望。
     */
    return { ok: false, error: "超过一年的话直接选永久 —— 写个大数字只是让人以为还有指望" };
  }

  return { ok: true, durationSeconds: seconds, expiresAt: now + seconds * 1000 };
}

/**
 * 一条处罚现在还生效吗。
 *
 * `expiresAt` 为 null = 永久。**已经撤销的一律不生效** ——
 * 撤销优先于期限，否则一条被申诉撤掉的封禁会在到期前一直算数。
 */
export function isActive(
  record: { expiresAt: number | null; revertedAt: number | null },
  now: number,
): boolean {
  if (record.revertedAt !== null) return false;
  if (record.expiresAt === null) return true;
  return record.expiresAt > now;
}

/**
 * 给被处罚的人看的那句话。
 *
 * ─────────────────────────────────────────
 * 「还有多久」比「什么时候」有用
 * ─────────────────────────────────────────
 *
 * 一个具体的时间戳要人自己去算还剩几天，而他这一刻多半没心情算。
 * 快到的时候（不到一天）说小时，剩得多说天。
 */
export function describeRemaining(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return "永久";
  const left = expiresAt - now;
  if (left <= 0) return "已经到期";

  const days = Math.floor(left / 86_400_000);
  if (days >= 1) return `还有 ${days} 天`;

  const hours = Math.floor(left / 3_600_000);
  if (hours >= 1) return `还有 ${hours} 小时`;

  return `还有不到 1 小时`;
}

/**
 * 到期之后恢复成什么状态。
 *
 * ─────────────────────────────────────────
 * 一律回 active，不回「原来那个」
 * ─────────────────────────────────────────
 *
 * 记录「封之前是什么状态」再恢复回去听起来更周到，实际是个坑：
 * 一个 pending（还没激活）的账号被封 7 天，到期恢复成 pending 之后
 * 仍然进不来，而处罚在所有界面上都显示成已经结束了 ——
 * 那时候没有任何人说得清他为什么还是进不去。
 *
 * 而 left / deleted 这两种状态**不该被自动恢复**：
 * 那不是处罚，是这个人自己走了或者账号被清理了。
 */
export function statusAfterExpiry(current: string): "active" | null {
  if (current === "banned" || current === "suspended") return "active";
  // 别的状态一概不动
  return null;
}
