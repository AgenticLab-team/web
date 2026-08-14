import "server-only";

import { getSetting, getSettingInt } from "@/lib/settings/store";

/**
 * 邮箱模块要用的那些数字，收在一处读。
 *
 * ─────────────────────────────────────────
 * 为什么不在各处直接 getSettingInt
 * ─────────────────────────────────────────
 *
 * 因为默认值会分叉。同一个 key 在三个文件里写着三个 fallback，
 * 而后台没配过那一项时，三处的行为不一样 —— 这种 bug
 * 只在「新环境 / 空库」时出现，也就是最难复现的时候。
 *
 * 收在这里之后，`defaults.ts` 里的值和代码里的 fallback 只有一处要对齐。
 */

export interface MailConfig {
  burnerTtlHours: number;
  burnerConcurrentLimit: number;
  burnerCustomMinLength: number;
  burnerPerHour: number;
  burnerPerDay: number;
  boxMaxBytes: number;
  messageMaxBytes: number;
  boxPerHourReceiveCap: number;
  domainPerHourReceiveCap: number;
  retentionDays: number;
  retentionDaysHighLevel: number;
  mxHost: string;
  dmarcRua: string;
}

export function mailConfig(): MailConfig {
  return {
    burnerTtlHours: getSettingInt("mail.burner.ttl_hours", 24),
    burnerConcurrentLimit: getSettingInt("mail.burner.concurrent_limit", 3),
    burnerCustomMinLength: getSettingInt("mail.burner.custom_min_length", 10),
    burnerPerHour: getSettingInt("mail.burner.per_hour", 50),
    burnerPerDay: getSettingInt("mail.burner.per_day", 200),
    boxMaxBytes: getSettingInt("mail.box.max_bytes", 5 * 1024 * 1024),
    messageMaxBytes: getSettingInt("mail.message.max_bytes", 2 * 1024 * 1024),
    boxPerHourReceiveCap: getSettingInt("mail.box.per_hour_receive_cap", 100),
    domainPerHourReceiveCap: getSettingInt("mail.domain.per_hour_receive_cap", 2000),
    retentionDays: getSettingInt("mail.retention_days", 30),
    retentionDaysHighLevel: getSettingInt("mail.retention_days_high_level", 60),
    mxHost: getSetting("mail.mx_host", "mx.agenticlab.sh"),
    dmarcRua: getSetting("mail.dmarc_rua", "dmarc@agenticlab.sh"),
  };
}

/**
 * 这个人的正文能留多久。
 *
 * 磁盘是这套东西里最贵的资源，所以它挂在**等级**上而不是积分上 ——
 * 用积分买磁盘意味着有人可以一次性买爆磁盘（MAIL.md 3.3）。
 */
export function retentionDaysFor(level: number, config = mailConfig()): number {
  return level >= 3 ? config.retentionDaysHighLevel : config.retentionDays;
}
