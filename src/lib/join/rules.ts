/**
 * 申请加入社群的规则。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 这是全站唯一一个「陌生人能写」的入口
 * ─────────────────────────────────────────
 *
 * 别的地方都要先登录，而登录要先是群成员。这一页不行 ——
 * 想加入的人**按定义还不是成员**，所以它必须对完全陌生的人开放。
 *
 * 于是它同时是这个站唯一的两个面：垃圾投放面，和信息泄露面。
 *
 * ─────────────────────────────────────────
 * 不能变成「这个微信号是不是成员」的查询接口
 * ─────────────────────────────────────────
 *
 * 最容易犯的错是给友好的反馈：
 *
 *   「你已经是成员了，直接登录吧」
 *   「你已经申请过了，请耐心等待」
 *
 * 这两句话都很体贴，而且**都在回答一个陌生人不该能问的问题**。
 * 前者直接确认了某个微信号在这个社群里；后者确认了这个号申请过。
 * 只要能一个个试，就能把整份成员名单摸出来 ——
 * 而「群成员名单是隐私」是这个站的明规矩。
 *
 * 所以：**不管什么情况，回给提交者的话都一模一样**。
 * 真正的分支判断留给管理员那一侧，那边是登录后才看得到的。
 */

/** 提交之后给人看的话。所有情况共用这一句，不要按情况分支 */
export const SUBMITTED_MESSAGE =
  "收到了。管理员会在群里核对之后处理 —— 如果你已经在群里，直接用登录页的验证码就能进来，不用等这条。";

export const MIN_REASON_CHARS = 10;
export const MAX_REASON_CHARS = 300;
export const MAX_CONTACT_CHARS = 60;
export const MAX_WXID_CHARS = 64;

export type JoinCheck =
  | { ok: true; wxId: string; reason: string; contact: string | null }
  | { ok: false; error: string };

/**
 * 清洗与校验。
 *
 * ─────────────────────────────────────────
 * 只拦「填错了」，不拦「不像成员」
 * ─────────────────────────────────────────
 *
 * 这里的校验只解决一件事：让管理员拿到的东西是可读、可核对的。
 * **不做任何「这个人配不配」的判断** —— 那是人的活，
 * 而且在这一层做的话，判断依据会泄露给提交者（他会试到通过为止）。
 */
export function checkJoinRequest(input: {
  wxId: string;
  reason: string;
  contact?: string;
}): JoinCheck {
  const wxId = input.wxId.trim();
  const reason = input.reason.trim().replace(/\s+/g, " ");
  const contact = input.contact?.trim() || null;

  if (!wxId) return { ok: false, error: "得填微信号，不然管理员在群里找不到你" };
  if (wxId.length > MAX_WXID_CHARS) return { ok: false, error: "微信号太长了" };
  /*
   * 不校验微信号的格式。
   *
   * 微信号可以是自设 ID、也可以是 wxid_ 开头的原始号，规则还变过几次。
   * 按格式拦的话，第一个被挡在外面的多半是个真人 ——
   * 而管理员核对时本来就要人工看一眼。
   */

  if (reason.length < MIN_REASON_CHARS) {
    return {
      ok: false,
      error: `说一下你想做什么、从哪知道这里的（至少 ${MIN_REASON_CHARS} 个字）—— 一句话都没有的申请，管理员没法判断`,
    };
  }

  return {
    ok: true,
    wxId,
    reason: reason.slice(0, MAX_REASON_CHARS),
    contact: contact ? contact.slice(0, MAX_CONTACT_CHARS) : null,
  };
}

/** 同一个 IP 一天最多提交几次 —— 这是全站唯一陌生人能写的入口 */
export const MAX_PER_IP_PER_DAY = 5;
export const DAY_MS = 86_400_000;

export interface RateVerdict {
  allowed: boolean;
  /** 给提交者看的话；**被限流时也不能透露别人的申请情况** */
  message: string;
}

export function checkRate(recentFromIp: number[], now: number): RateVerdict {
  const today = recentFromIp.filter((t) => now - t < DAY_MS).length;
  if (today < MAX_PER_IP_PER_DAY) return { allowed: true, message: "" };
  return {
    allowed: false,
    message: "今天提交得有点多了，明天再来吧 —— 重复提交不会让处理变快",
  };
}

/**
 * 管理员那一侧看到的判断。
 *
 * **这个函数的结果永远不回给提交者。** 它读的是「这个微信号在不在
 * 我们同步的群里」，而那正是不能对外说的事。
 */
export type ApplicantStanding =
  | { kind: "already_member"; label: string; detail: string }
  | { kind: "in_group"; label: string; detail: string }
  | { kind: "outsider"; label: string; detail: string };

export function judgeApplicant(input: {
  groups: string[];
  hasAccount: boolean;
}): ApplicantStanding {
  if (input.hasAccount) {
    return {
      kind: "already_member",
      label: "他已经有账号了",
      detail: "多半是登录时卡住了才来提交申请 —— 去「绑定审批」看看他是不是在那边卡着",
    };
  }
  if (input.groups.length > 0) {
    return {
      kind: "in_group",
      label: "已经在群里，还没建账号",
      detail: `在 ${input.groups.length} 个群：${input.groups.join("、")}。让他在群里发登录验证码就行，不需要再拉一次`,
    };
  }
  return {
    kind: "outsider",
    label: "不在任何群里",
    detail: "要先把人拉进群 —— 这个站的入口只有群，账号是跟着群成员身份来的",
  };
}
