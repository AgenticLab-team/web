/**
 * 域名到期告警的档位判定。纯函数。
 *
 * ═════════════════════════════════════════
 * 域名过期是这套东西里唯一**无声**的故障
 * ═════════════════════════════════════════
 *
 * 磁盘满了有告警，同步失败有告警，服务挂了有 502。
 * 而一个域名过期之后，挂在它上面的**所有邮箱同时消失**，
 * 表现只有一个：邮件不再来了。没有报错、没有 5xx、
 * 用户那边也不会立刻发现 —— 他只会以为最近没人给他发信。
 *
 * 100 个域名分散在不同的注册时间上，靠人记是记不住的。
 */

/**
 * 三个档位。
 *
 * 30 天是能从容处理的窗口（续费、转移、或者决定放弃）；
 * 14 天是「该动手了」；7 天是「今天就得办」。
 *
 * 只报一次就够的话，那一条很可能正好落在某个人休假的一周里。
 * 三档递进，而**每档只报一次** —— 每 5 分钟一条的话，
 * 一周之后没有人再看这个告警，那和没有告警是一样的。
 */
export const EXPIRY_STAGES = [30, 14, 7] as const;

export type ExpiryStage = (typeof EXPIRY_STAGES)[number];

/**
 * 这个剩余天数落在哪个档位。不该报就返回 null。
 *
 * **已经过期的（负数）落在最紧的那一档**，不是「不报了」——
 * 过期之后才是最需要看见它的时候：多数注册局有 30 天左右的赎回期，
 * 那期间还救得回来。
 */
export function expiryStage(days: number | null): ExpiryStage | null {
  if (days === null) return null;
  for (const stage of [...EXPIRY_STAGES].sort((a, b) => a - b)) {
    if (days <= stage) return stage;
  }
  return null;
}

/** 给人看的一句话 */
export function expiryLabel(days: number | null): string {
  if (days === null) return "没登记到期日";
  if (days < 0) return `已经过期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天到期";
  return `${days} 天后到期`;
}

/**
 * 严重到什么程度。
 *
 * 「没登记到期日」单独算一档 warning：它不会触发任何告警，
 * **也就是说它是所有域名里最危险的一类** —— 会在完全没有预警的
 * 情况下过期。界面上要能一眼看出来。
 */
export function expiryTone(days: number | null): "danger" | "warning" | "normal" {
  if (days === null) return "warning";
  if (days <= 7) return "danger";
  if (days <= 30) return "warning";
  return "normal";
}
