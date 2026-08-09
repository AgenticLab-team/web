import { createHash } from "node:crypto";

/**
 * 群发的判定规则。纯函数。
 *
 * ─────────────────────────────────────────
 * 为什么这一套比别处都长
 * ─────────────────────────────────────────
 *
 * 群发是全站唯一**做错之后没法挽回**的功能。
 * 删错帖可以恢复，扣错分可以冲正，封错人可以解封 ——
 * 但一条发到十二个群、一千六百人手机上响过的消息，
 * 撤回窗口只有几分钟且不保证成功。
 *
 * 所以这里的每条规则都不是为了「更规范」，
 * 是为了让**出错的那一次尽可能不发生**。
 */

export interface RuleResult {
  ok: boolean;
  error?: string;
}

const OK: RuleResult = { ok: true };
const no = (error: string): RuleResult => ({ ok: false, error });

/** 微信群发的内容上限。太长的消息在手机上会被折叠，等于没人看 */
export const MAX_WECHAT_LENGTH = 800;
export const MIN_LENGTH = 5;

/**
 * 内容哈希。**复核的人看到什么，发出去的就必须是什么。**
 *
 * 不冻结的话，「先提一版温和的骗到批准，再改成别的」这条路是敞开的 ——
 * 而这类操作事后从审计日志里看不出来：两条记录都合法。
 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content.trim()).digest("hex").slice(0, 32);
}

export interface DraftInput {
  channel: "site" | "wechat";
  content: string;
  targetConvIds: readonly string[];
  /**
   * 这个渠道下允许出现的群 id。
   *
   * **两个渠道的合法集合不一样**：微信群发只能发到机器人进得去的群，
   * 而站内公告可以限定到站里认得的任何一个群 ——
   * 一个机器人发不进去的群，里面的人照样在用这个站。
   *
   * 传错的后果不对称：给站内公告传了「可发送」那份，
   * 结果是管理员选了一个明明在列表里的群却被拒；
   * 给微信群发传了「站里认得的」那份，结果是往一个发不进去的群发。
   */
  availableConvIds: readonly string[];
}

export function checkDraft(input: DraftInput): RuleResult {
  const content = input.content.trim();
  if (content.length < MIN_LENGTH) return no(`内容太短了，至少 ${MIN_LENGTH} 个字`);

  if (input.channel === "wechat") {
    if (content.length > MAX_WECHAT_LENGTH) {
      return no(
        `微信群发不能超过 ${MAX_WECHAT_LENGTH} 字（当前 ${content.length}）—— 太长在手机上会被折叠，等于没人看`,
      );
    }

    if (input.targetConvIds.length === 0 && input.availableConvIds.length === 0) {
      return no("没有任何可发送的群");
    }
  }

  /*
   * 目标校验对两个渠道都做。
   *
   * 以前只在微信那一支里查，于是站内公告的 `targetConvIds`
   * **完全没人校验** —— 一个手写的请求可以塞进任意 id，
   * 存下来的是一条谁也匹配不上的公告，
   * 而界面只会说「已发布」。
   */
  const unknown = input.targetConvIds.filter((id) => !input.availableConvIds.includes(id));
  if (unknown.length > 0) {
    return no(
      input.channel === "wechat"
        ? `有 ${unknown.length} 个目标不在可发送列表里`
        : `有 ${unknown.length} 个群不在站里认得的群列表里`,
    );
  }

  return OK;
}

export interface ApproveInput {
  actorId: string;
  createdBy: string;
  status: string;
  /** 提交复核时冻结的哈希 */
  frozenHash: string | null;
  /** 现在数据库里的内容算出来的哈希 */
  currentHash: string;
  note: string;
}

export function checkApprove(input: ApproveInput): RuleResult {
  if (!input.note.trim()) return no("必须写明复核意见");
  if (input.status !== "pending") return no("这条不在待复核状态");

  /*
   * 双人复核的全部意义就在这一条。
   * 起草人自己批准的话，这套流程只是给一个人多点了一次鼠标。
   */
  if (input.actorId === input.createdBy) {
    return no("不能复核自己起草的群发 —— 换一个人来看");
  }

  if (input.frozenHash === null) return no("这条没有冻结内容，无法复核");
  if (input.frozenHash !== input.currentHash) {
    return no("内容在提交复核后被改过了，请重新提交复核");
  }

  return OK;
}

export interface SendInput {
  status: string;
  frozenHash: string | null;
  currentHash: string;
  approvedBy: string | null;
  /** 距上一次群发多久 */
  msSinceLastSend: number | null;
  /** 今天已经发了几次 */
  sentToday: number;
  quota: { perMinute: { used: number; limit: number }; perHour: { used: number; limit: number } };
  /** 这次要发几个群 */
  targetCount: number;
}

/** 两次群发之间的最小间隔。微信对高频发送有风控，机器人已经因为加好友被限过一次 */
export const MIN_SEND_GAP_MS = 30 * 60_000;
/** 每天最多几次群发 —— 超过这个数，大家会开始屏蔽这个群 */
export const MAX_SENDS_PER_DAY = 3;

export function checkSend(input: SendInput): RuleResult {
  if (input.status !== "approved") return no("还没通过复核");
  if (!input.approvedBy) return no("缺少复核人记录");

  // 复核之后又被改过 —— 最后一道闸，绝不能省
  if (input.frozenHash !== input.currentHash) {
    return no("内容与复核时不一致，拒绝发送");
  }

  if (input.sentToday >= MAX_SENDS_PER_DAY) {
    return no(`今天已经群发 ${input.sentToday} 次了 —— 再多大家会开始屏蔽这个群`);
  }

  if (input.msSinceLastSend !== null && input.msSinceLastSend < MIN_SEND_GAP_MS) {
    const wait = Math.ceil((MIN_SEND_GAP_MS - input.msSinceLastSend) / 60_000);
    return no(`距上次群发不到 ${MIN_SEND_GAP_MS / 60_000} 分钟，还要等 ${wait} 分钟`);
  }

  /*
   * 上游额度不够时**提前拒绝**，而不是发到一半被上游拒。
   * 发到一半的群发是最糟的状态：一部分人收到了，一部分没有，
   * 而重发会让前一部分人收到两遍。
   */
  const minuteLeft = input.quota.perMinute.limit - input.quota.perMinute.used;
  const hourLeft = input.quota.perHour.limit - input.quota.perHour.used;
  if (input.targetCount > hourLeft) {
    return no(`上游本小时只剩 ${hourLeft} 条额度，发不完 ${input.targetCount} 个群`);
  }
  if (minuteLeft <= 0) {
    return no("上游本分钟额度已用完，等一分钟再发");
  }

  return OK;
}

/**
 * 逐群发送的间隔。
 *
 * 一秒钟连发十二条是最典型的风控触发姿势。
 * 按上游每分钟额度算出一个安全间隔，宁可慢一点。
 */
export function sendIntervalMs(perMinuteLimit: number): number {
  if (perMinuteLimit <= 0) return 60_000;
  // 只用额度的一半，给别的功能（比如打卡回执）留余地
  return Math.ceil(60_000 / Math.max(1, perMinuteLimit / 2));
}

export interface RevokeInput {
  status: string;
  msgSvrId: string | null;
  sentAt: number | null;
  now: number;
}

/** 微信的撤回窗口。超过基本必失败，界面上要提前说清楚而不是让人白试 */
export const REVOKE_WINDOW_MS = 2 * 60_000;

export function checkRevoke(input: RevokeInput): RuleResult {
  if (input.status !== "sent") return no("这一条没有发送成功，无需撤回");
  if (!input.msgSvrId) return no("没有留下消息 id，撤不回来了");
  if (input.sentAt === null) return no("缺少发送时间");

  const age = input.now - input.sentAt;
  if (age > REVOKE_WINDOW_MS) {
    return no(
      `已经过去 ${Math.floor(age / 60_000)} 分钟，超出微信的撤回窗口 —— 撤不回来了`,
    );
  }

  return OK;
}

export const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  pending: "待复核",
  approved: "待发送",
  sending: "发送中",
  sent: "已发送",
  failed: "发送失败",
  rejected: "已驳回",
  canceled: "已取消",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export const CHANNEL_LABELS: Record<string, string> = {
  site: "站内公告",
  wechat: "微信群发",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}
