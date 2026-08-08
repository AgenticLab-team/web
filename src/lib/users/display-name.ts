/**
 * 显示名解析 —— 全站唯一的一份。
 *
 * 昵称链路是 siteNickname → wxNickname → people.displayName → 兜底，
 * 但链路里任何一环都可能混进**原始微信 ID**：
 *   - people 同步在拿不到任何昵称时曾直接把 wx_id 写进 displayName（存量数据里就有）
 *   - 上游对部分账号的 name 字段实测返回的就是 wx_id
 * wx_id 属于隐私，一旦漏到页面上，任何访客都能拿它去精确加好友。
 *
 * 所以解析必须收口在这一个函数里：逐个候选做「像不像 wx_id」的过滤，
 * 全部落空时给一个不泄露任何信息的占位。各处各自写一遍 ?? 链，
 * 就会像过去一样 —— 有的地方记得过滤、有的地方兜底成了 wx_id。
 */

export const FALLBACK_DISPLAY_NAME = "未命名成员";

/**
 * 判断一段文本是不是原始微信 ID。
 *
 * 两类形态都要认：
 *   - 自动分配的 `wxid_xxxx`
 *   - 群聊 ID `xxx@chatroom`（people 表里实测混进过群 ID 当「人」）
 * 用户自设的微信号（不带 wxid_ 前缀）没法靠形态识别，
 * 只能靠调用方传入已知的 wxId 做精确匹配 —— 见 resolveDisplayName。
 */
export function looksLikeWxId(value: string): boolean {
  const trimmed = value.trim();
  return /^wxid_[0-9a-z_-]+$/i.test(trimmed) || /@chatroom$/i.test(trimmed);
}

export interface ResolveDisplayNameOptions {
  /** 这个人的 wx_id。传了它才能拦住「自设微信号被当成昵称」的形态 */
  wxId?: string | null;
  /** 全部候选落空时的占位。默认「未命名成员」，个别语境用「我」「有人」更自然 */
  fallback?: string;
}

/**
 * 按优先级取第一个**能安全展示**的候选昵称。
 *
 * 候选被拒绝的条件：空白、等于本人 wx_id、或形态上就是个 wx_id。
 * 存量脏数据（displayName 里存着 wx_id 的那批人）也被这层过滤兜住，
 * 不必等重新同步。
 */
export function resolveDisplayName(
  candidates: Array<string | null | undefined>,
  options: ResolveDisplayNameOptions = {},
): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (options.wxId && trimmed === options.wxId.trim()) continue;
    if (looksLikeWxId(trimmed)) continue;
    return trimmed;
  }
  return options.fallback ?? FALLBACK_DISPLAY_NAME;
}
