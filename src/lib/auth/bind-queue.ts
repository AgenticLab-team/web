/**
 * 绑定审批队列的规则。纯函数，不碰数据库、不碰上游。
 *
 * ─────────────────────────────────────────
 * 这个队列要回答的只有一个问题
 * ─────────────────────────────────────────
 *
 * **「这个人是不是真的在我们群里」。**
 *
 * 整个站的入口规则就一条:只有群成员能登录。绑定流程平时靠验证码
 * 自动完成这件事 —— 码是在群里发的,能发出来就说明人在群里。
 *
 * 而人工审批是**绕过那个证明**的一条路。所以它必须自己把证明补回来,
 * 否则「只有群成员能登录」就退化成了「只有群成员或者某个管理员
 * 点过通过的人能登录」—— 后半句一旦成立,前半句就不再是一条规则,
 * 而只是一个默认值。
 *
 * ─────────────────────────────────────────
 * 通过好友申请：算账，但不拦（2026-08 站长指令）
 * ─────────────────────────────────────────
 *
 * 这套额度原来是服务端的硬性拦截。站长明确要求管理接口不设限速
 * （「我有数」），所以服务端不再拒绝 —— 但**计算保留**：
 * 机器人加好友触发过微信风控是事实，额度算出来摆在界面上，
 * 让点按钮的人在点之前看见「今天已经通过几个」。
 *
 * 也就是说，风控的判断从代码手里交回到了人手里。
 * 数字如果不再显示，这个决定就退化成了「没人知道点了多少下」——
 * 所以改这里的人注意：reason 那句话必须一直有地方展示。
 */

/** 一天通过几个以内算安全 —— 只用于提示，服务端不拦 */
export const ACCEPT_DAILY_CAP = 5;

/** 两次通过之间建议至少隔多久 —— 同上，只是提示 */
export const ACCEPT_MIN_GAP_MS = 5 * 60_000;

export const DAY_MS = 86_400_000;

export interface AcceptBudget {
  usedToday: number;
  remaining: number;
  /** 距建议的安全间隔还差多久；0 表示已经隔够了 */
  waitMs: number;
  reason: string;
}

/**
 * 今天通过了几个、离安全线还有多远。
 *
 * 只产出给人看的判断，不产出「能不能」—— 服务端不再据此拒绝。
 * `recentAcceptTimes` 是最近的通过时间（倒序即可，这里不假设顺序）。
 */
export function acceptBudget(recentAcceptTimes: number[], now: number): AcceptBudget {
  const withinDay = recentAcceptTimes.filter((t) => now - t < DAY_MS);
  const last = withinDay.length > 0 ? Math.max(...withinDay) : null;
  const remaining = Math.max(0, ACCEPT_DAILY_CAP - withinDay.length);
  const waitMs = last === null ? 0 : Math.max(0, ACCEPT_MIN_GAP_MS - (now - last));

  if (remaining === 0) {
    return {
      usedToday: withinDay.length,
      remaining: 0,
      waitMs,
      reason: `今天已经通过 ${withinDay.length} 个，微信对机器人频繁加好友有风控 —— 不拦你，但风险自己拿着`,
    };
  }
  if (waitMs > 0) {
    return {
      usedToday: withinDay.length,
      remaining,
      waitMs,
      reason: `离上一个通过还不到 ${Math.round(ACCEPT_MIN_GAP_MS / 60_000)} 分钟 —— 连得太密是最典型的风控触发姿势`,
    };
  }
  return {
    usedToday: withinDay.length,
    remaining,
    waitMs: 0,
    reason: `今天已通过 ${withinDay.length} 个，${ACCEPT_DAILY_CAP} 个以内比较稳`,
  };
}

/**
 * 申请人在我们这边的活跃度。
 *
 * 这几个数字合起来就是审批的全部依据 ——
 * 没有它们的话，「一键通过」只是在通过一个陌生的微信号。
 */
export interface ApplicantActivity {
  /** 他在我们同步的哪几个群里（已退群的不算） */
  groups: string[];
  /** 在这些群里一共说过多少条 */
  messages: number;
  /** 最后一条消息的时间；从没说过话是 null */
  lastSeenAt: number | null;
  /** 最早入群时间 */
  joinedAt: number | null;
}

export type ApplicantVerdict =
  | { kind: "member"; label: string; detail: string }
  | { kind: "lurker"; label: string; detail: string }
  | { kind: "stranger"; label: string; detail: string };

/** 从没说过话也不算可疑的门槛之下 —— 潜水的人很多，这不是坏事 */
export const QUIET_MESSAGE_THRESHOLD = 5;

/**
 * 把活跃度翻成一句给人看的判断。
 *
 * 三档而不是打分。**打分会让人只看数字不看依据** ——
 * 而这里真正要传达的是「他在不在群里」这个是非题,
 * 一个 73 分没法回答是非题。
 */
export function judgeApplicant(activity: ApplicantActivity, now: number): ApplicantVerdict {
  if (activity.groups.length === 0) {
    return {
      kind: "stranger",
      label: "不在任何群里",
      detail: "我们同步的群里都没有这个人 —— 通过他等于给站外的人开门",
    };
  }

  const where = `在 ${activity.groups.length} 个群：${activity.groups.join("、")}`;

  if (activity.messages < QUIET_MESSAGE_THRESHOLD) {
    return {
      kind: "lurker",
      label: "在群里，但几乎没说过话",
      detail: `${where}，共 ${activity.messages} 条。潜水的人很多，这不代表有问题，只是没有别的信息可看`,
    };
  }

  const days =
    activity.lastSeenAt === null ? null : Math.floor((now - activity.lastSeenAt) / DAY_MS);
  const recency =
    days === null ? "" : days === 0 ? "，今天还在说话" : `，最后一次说话在 ${days} 天前`;

  return {
    kind: "member",
    label: "群里的活跃成员",
    detail: `${where}，共 ${activity.messages} 条${recency}`,
  };
}

export type ManualBindCheck = { ok: true } | { ok: false; error: string };

/**
 * 能不能手动把一个绑定请求归到这个微信号上。
 *
 * ─────────────────────────────────────────
 * 这里是整站入口规则的最后一道
 * ─────────────────────────────────────────
 *
 * 手动绑定绕过了验证码 —— 而验证码本身就是「这个人在群里」的证明。
 * 所以这里必须把那个证明**重新要一遍**,而且是硬性的:
 * 不在任何群里就是不行,没有「管理员确认过」这种例外。
 *
 * 留了例外的话,这条规则的实际含义就变成了
 * 「只有群成员、或者某个管理员愿意点通过的人能登录」。
 */
export function canManualBind(input: {
  activity: ApplicantActivity;
  alreadyBoundTo: string | null;
  reason: string;
}): ManualBindCheck {
  if (input.activity.groups.length === 0) {
    return {
      ok: false,
      error: "这个微信号不在我们同步的任何群里 —— 只有群成员能登录，手动绑定也不例外",
    };
  }
  if (input.alreadyBoundTo) {
    return {
      ok: false,
      error: `这个微信号已经绑到账号 ${input.alreadyBoundTo} 了 —— 要换人得先解绑`,
    };
  }
  if (input.reason.trim().length < 4) {
    return {
      ok: false,
      error: "手动绑定要写清楚为什么（至少 4 个字）—— 它绕过了验证码，事后要说得清",
    };
  }
  return { ok: true };
}

/**
 * 一次没完成的绑定还值不值得处理。
 *
 * 太久以前的不再显示:那个人多半早就重试成功、或者已经放弃了,
 * 而一个越堆越长的队列**等于没有队列** —— 没人会翻到第三屏。
 */
export const STALE_BIND_MS = 24 * 3600_000;

export function isActionable(createdAt: number, now: number): boolean {
  return now - createdAt < STALE_BIND_MS;
}

/**
 * 取过几次码还没成功，才算「这个人卡住了」。
 *
 * ─────────────────────────────────────────
 * 这个数字是量出来的，不是拍的
 * ─────────────────────────────────────────
 *
 * 打开登录页就会取一个码。所以「有没匹配上的码」根本不是卡住的信号 ——
 * 生产上一天 392 个码、235 个没匹配上，绝大多数只是有人点开看了一眼。
 *
 * 按 IP 数了一遍：
 *
 *   取过 ≥1 次且一次都没成功  →  54 个 IP   ← 大多是路过的
 *   取过 ≥2 次且一次都没成功  →  12 个      ← 在反复试
 *   取过 ≥3 次                →   4 个
 *   取过 ≥6 次                →   1 个
 *
 * 门槛定在 2:一个人取了码就走开不算卡住,取了两次说明他没放弃。
 * 定在 1 的话这个队列每天两百多条,而**两百多条的队列没有人会看** ——
 * 那就等于这个功能不存在。
 */
export const STUCK_CODE_THRESHOLD = 2;

export interface StuckApplicant {
  ip: string;
  codes: number;
  firstAt: number;
  lastAt: number;
  /** 最近那个码 —— 要处理就处理它 */
  latestCodeId: string;
  latestCode: string;
  latestExpiresAt: number;
}

/** 从「一串没匹配上的码」里挑出真正像卡住的人 */
export function groupStuck(
  rows: { id: string; code: string; issuedIp: string | null; createdAt: number; expiresAt: number }[],
  threshold = STUCK_CODE_THRESHOLD,
): StuckApplicant[] {
  const byIp = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.issuedIp) continue;
    byIp.set(row.issuedIp, [...(byIp.get(row.issuedIp) ?? []), row]);
  }

  const out: StuckApplicant[] = [];
  for (const [ip, list] of byIp) {
    if (list.length < threshold) continue;
    const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt);
    const latest = sorted[sorted.length - 1];
    out.push({
      ip,
      codes: sorted.length,
      firstAt: sorted[0].createdAt,
      lastAt: latest.createdAt,
      latestCodeId: latest.id,
      latestCode: latest.code,
      latestExpiresAt: latest.expiresAt,
    });
  }

  // 试得最多的排最前 —— 他是最需要有人管的那个
  return out.sort((a, b) => b.codes - a.codes || b.lastAt - a.lastAt);
}
