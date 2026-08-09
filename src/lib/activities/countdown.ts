/**
 * 倒计时的文案。纯函数，不碰数据库、也不碰 React。
 *
 * 单独成文件是为了能被测试直接引用 —— 放在客户端组件里的话，
 * 测试跑在 react-server 条件下，一 import 就炸。
 */

/**
 * 只说到有意义的那一位。
 *
 * 「还剩 2 天 3 小时 17 分 4 秒」里，后两位对一个三天的截止毫无用处，
 * 只是让人多读两眼。所以按量级砍：天级只说天和小时，
 * 小时级说小时和分，最后一小时才出现秒。
 */
export function formatLeft(ms: number): string {
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

/**
 * 多久刷新一次。
 *
 * 一个一直在跳秒的数字会把眼睛钉在上面 —— 而距离结束还有三天的时候，
 * 那种紧迫感是假的，纯粹在消耗人的注意力。
 * 剩下不到一小时才是真的要抓紧，那时候秒才有意义。
 */
export function tickInterval(remainingMs: number): number {
  return remainingMs > 3600_000 ? 60_000 : 1000;
}

/** 不到一天就变色 —— 「还有几天」和「今天就截止」是两件事 */
export function isUrgent(remainingMs: number): boolean {
  return remainingMs < 24 * 3600_000;
}
