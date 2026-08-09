import "server-only";

import { and, count, eq, gt, inArray, lt } from "drizzle-orm";

import { db } from "@/lib/db";
import { bindCodes, groupMembers, groups, messages, users } from "@/lib/db/schema";
import { NekoBotError, nekobot } from "@/lib/nekobot/client";
import type { UpstreamMessage } from "@/lib/nekobot/types";
import { getSetting, getSettingInt } from "@/lib/settings/store";

/**
 * 三通道绑定。
 *
 * **2026-08 起主通道改为群消息**：机器人加好友已经触发微信风控，
 * 好友申请这条路实际走不通了，不能再让它当第一步。现在是：
 *
 *   group_message  — 主通道：在任意含机器人的群里发「登录 123456」。
 *   direct_message — 备用：已经是好友的人私聊机器人发验证码。
 *   friend_request — 仍然保留匹配（只读 /friend-requests 提取理由里的验证码，
 *                    **从不调用 accept**），但不再引导用户走这条路。
 *
 * ⚠️ 群通道的验证码在群里是公开可见的，这是主通道之后最要紧的风险：
 *   1. 必须带前缀词（「登录 123456」而非裸数字），降低被诱导代发的概率
 *   2. **同一个码按时间正序匹配，先发的人赢** —— 见 doPoll 里的说明。
 *      后发的人赢的话，看到码再发一遍就能抢走别人的会话
 *   3. TTL 只有 5 分钟、一次性、绑定后展示明确确认页
 *   4. 生成频率限流
 *
 * 「一次性」不排斥**同一个 nonce 把自己的码接回来**（见 startBind）：
 * 复用只发生在持有原 httpOnly cookie 的那个浏览器上，
 * 码没有换过主人，安全性质与刷新页面显示同一个码等同。
 */

function randomCode(): string {
  // 避开以 0 开头，保证始终是 6 位数字，便于用户抄写
  const n = 100_000 + Math.floor(Math.random() * 900_000);
  return String(n);
}

export interface StartBindResult {
  code: string;
  nonce: string;
  expiresAt: number;
  fallbackAfterSeconds: number;
  groupPrefix: string;
  /** 是不是接回了上一次没走完的绑定，而不是新发的码 */
  resumed: boolean;
  /** 码最初签发的时间。恢复提示要靠它说出「你 N 分钟前的登录」 */
  issuedAt: number;
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * 已匹配的码在匹配后多久内还能被接回。
 *
 * 场景：用户在群里发完码、微信内置浏览器就被杀了 —— 码已经 used，
 * 会话还没建。这时不能按码的 expiresAt 判（发码晚的话它可能已经过了），
 * 要按**匹配时间**另开一扇 5 分钟的窗：人刚做完最后一步，
 * 回来就该直接进门，而不是被要求从头再来。
 */
export const RESUME_WINDOW_MS = 5 * 60_000;

export function startBind(opts: { ip?: string; resumeNonce?: string }): StartBindResult {
  const ttl = getSettingInt("auth.bind_code.ttl_seconds", 300) * 1000;
  const now = Date.now();

  /*
   * 先试着接回上一次，再考虑发新码。
   *
   * 微信内置浏览器杀后台是常态，用户「关掉再打开」不是异常路径。
   * 原来每次打开登录页都发一个新码，生产上一天 392 个码里 235 个
   * 从没匹配上 —— 其中很大一部分就是同一个人反复打开页面：
   * 旧码作废、新码接着没人发，轮询窗口里还堆满了死码。
   *
   * 复用的判定分两种，窗口刻意不同：
   *   - pending：码还没被发出去，能用到它自己的 expiresAt 为止
   *   - used：码已经在群里发过、匹配上了，只差建会话 ——
   *     按匹配时间开 RESUME_WINDOW_MS 的窗（见上面的说明）
   *
   * 复用**不检查限流也不占限流额度**：它不产生新行，
   * 刷不爆验证码表，也不该把反复打开页面的人推向 429。
   */
  if (opts.resumeNonce) {
    const prior = db
      .select()
      .from(bindCodes)
      .where(eq(bindCodes.sessionNonce, opts.resumeNonce))
      .get();

    const resumable =
      prior !== undefined &&
      ((prior.status === "pending" && prior.expiresAt > now) ||
        (prior.status === "used" && (prior.matchedAt ?? 0) > now - RESUME_WINDOW_MS));

    if (prior && resumable) {
      return {
        code: prior.code,
        nonce: prior.sessionNonce,
        /*
         * 已匹配的码不再需要被抄写，倒计时只剩展示作用 ——
         * 但前端会在倒计时归零时把整页判成「已过期」并停掉轮询，
         * 所以这里得把展示用的时限撑到窗口末尾，别让界面抢在轮询
         * 拿到 bound 之前宣布死亡。
         */
        expiresAt:
          prior.status === "used"
            ? Math.max(prior.expiresAt, (prior.matchedAt ?? now) + RESUME_WINDOW_MS)
            : prior.expiresAt,
        fallbackAfterSeconds: getSettingInt("auth.bind_code.fallback_after_seconds", 15),
        groupPrefix: getSetting("auth.bind_code.group_prefix", "登录"),
        resumed: true,
        issuedAt: prior.createdAt,
      };
    }
  }

  // 这个接口在公网上裸奔，不限流就能被刷爆验证码表，
  // 也会把大量待验证码塞进轮询窗口，拖慢所有人的绑定。
  //
  // 但阈值不能按「每人」的直觉来定：国内运营商大量使用 NAT，
  // 一个学校或公司出口后面可能有几十个群友共用一个出口 IP。
  // 所以用「短窗口防爆刷 + 宽松日限」，而不是一刀切的低日限。
  if (opts.ip) {
    const burstLimit = getSettingInt("auth.bind_code.burst_limit", 5);
    const burstWindow = getSettingInt("auth.bind_code.burst_window_seconds", 600) * 1000;
    const burst = countIssued(opts.ip, now - burstWindow);
    if (burst >= burstLimit) {
      throw new RateLimitError(
        `请求过于频繁，请 ${Math.ceil(burstWindow / 60000)} 分钟后再试`,
        Math.ceil(burstWindow / 1000),
      );
    }

    const dailyLimit = getSettingInt("auth.bind_code.daily_limit", 30);
    if (countIssued(opts.ip, now - 86_400_000) >= dailyLimit) {
      throw new RateLimitError(`24 小时内最多获取 ${dailyLimit} 次验证码，请稍后再试`, 3600);
    }
  }

  // 过期的码先标记掉，避免旧码一直参与匹配
  db.update(bindCodes)
    .set({ status: "expired" })
    .where(and(eq(bindCodes.status, "pending"), lt(bindCodes.expiresAt, now)))
    .run();

  let code = randomCode();
  // 同一时刻不能有两个相同的待验证码，否则无法判断是谁发的
  for (let i = 0; i < 10; i++) {
    const clash = db
      .select({ id: bindCodes.id })
      .from(bindCodes)
      .where(
        and(
          eq(bindCodes.code, code),
          eq(bindCodes.status, "pending"),
          gt(bindCodes.expiresAt, now),
        ),
      )
      .get();
    if (!clash) break;
    code = randomCode();
  }

  const nonce = crypto.randomUUID();
  db.insert(bindCodes)
    .values({
      code,
      sessionNonce: nonce,
      issuedIp: opts.ip,
      // 显式写入而不用列默认值 —— 返回值里的 issuedAt 和行里的 createdAt
      // 必须是同一个数，恢复时要拿它算「你 N 分钟前的登录」
      createdAt: now,
      expiresAt: now + ttl,
    })
    .run();

  return {
    code,
    nonce,
    expiresAt: now + ttl,
    fallbackAfterSeconds: getSettingInt("auth.bind_code.fallback_after_seconds", 15),
    groupPrefix: getSetting("auth.bind_code.group_prefix", "登录"),
    resumed: false,
    issuedAt: now,
  };
}

function countIssued(ip: string, since: number): number {
  return (
    db
      .select({ n: count() })
      .from(bindCodes)
      .where(and(eq(bindCodes.issuedIp, ip), gt(bindCodes.createdAt, since)))
      .get()?.n ?? 0
  );
}

// 所有待验证的码共用一次上游查询，避免每个前端轮询都打一次上游
let lastPoll = 0;
let inflight: Promise<void> | null = null;

export async function pollBindChannels(): Promise<void> {
  const minInterval = getSettingInt("sync.bind_poll.interval_seconds", 3) * 1000;
  if (inflight) return inflight;
  if (Date.now() - lastPoll < minInterval) return;

  inflight = doPoll().finally(() => {
    lastPoll = Date.now();
    inflight = null;
  });
  return inflight;
}

async function doPoll(): Promise<void> {
  const now = Date.now();
  const pending = db
    .select()
    .from(bindCodes)
    .where(and(eq(bindCodes.status, "pending"), gt(bindCodes.expiresAt, now)))
    .all();

  if (pending.length === 0) return;

  const byCode = new Map(pending.map((c) => [c.code, c]));
  const oldest = Math.min(...pending.map((c) => c.createdAt));
  const prefix = getSetting("auth.bind_code.group_prefix", "登录");

  const [messagesResult, friendResult] = await Promise.allSettled([
    // 一次拉回窗口内所有入站消息，本地匹配所有待验证码
    nekobot.messages({ start_ms: oldest - 60_000, include_self: false, limit: 500, order: "desc" }),
    nekobot.friendRequests({ pending_only: true, limit: 50 }),
  ]);

  if (messagesResult.status === "fulfilled") {
    for (const [code, match] of resolveMessageMatches(
      messagesResult.value.items,
      [...byCode.keys()],
      prefix,
    )) {
      claim(byCode.get(code)!.id, {
        channel: match.isGroup ? "group_message" : "direct_message",
        wxId: match.senderWxId,
        convId: match.convId,
        source: match.content,
        nickname: match.senderName,
      });
      byCode.delete(code);
    }
  }

  if (friendResult.status === "fulfilled") {
    for (const request of friendResult.value.items) {
      const found = [...byCode.keys()].find((code) => request.reason.includes(code));
      if (!found) continue;
      claim(byCode.get(found)!.id, {
        channel: "friend_request",
        wxId: request.wx_id,
        source: request.reason,
        nickname: request.nickname,
        avatar: request.avatar_full || request.avatar,
      });
      byCode.delete(found);
    }
  }
}

export interface BindMatch {
  senderWxId: string;
  senderName: string;
  convId: string;
  content: string;
  createTime: number;
  isGroup: boolean;
}

/**
 * 从一批消息里挑出每个待验证码的归属者。纯函数，与数据库无关。
 *
 * 两条规则都是安全性的，不是功能性的：
 *
 * 1. **先发的人赢。** 上游按 order: "desc" 返回，照原顺序遍历等于
 *    「后发的人赢」—— 群里的验证码是公开可见的，别人看到后原样再发一遍
 *    就能把这个会话抢到自己名下。按时间正序之后，攻击者必须**抢在**
 *    本人发出之前发送，而那要求他先知道码，前提不成立。
 *
 * 2. **群消息必须带前缀词。** 裸数字不接受，否则群里任何一串六位数字
 *    （电话尾号、金额、日期）都可能把某个人的会话绑给发言者。
 *    私聊没有这个问题，是一对一的，不需要前缀。
 */
export function resolveMessageMatches(
  items: readonly UpstreamMessage[],
  codes: readonly string[],
  prefix: string,
): Map<string, BindMatch> {
  const winners = new Map<string, BindMatch>();
  if (codes.length === 0) return winners;

  const ordered = [...items].sort((a, b) => a.create_time - b.create_time);

  for (const msg of ordered) {
    if (msg.type !== "text") continue;

    const isGroup = msg.conv_id.endsWith("@chatroom");
    if (isGroup && !msg.content.includes(prefix)) continue;

    for (const code of codes) {
      if (winners.has(code)) continue;
      if (!msg.content.includes(code)) continue;
      winners.set(code, {
        senderWxId: msg.sender_wx_id,
        senderName: msg.sender_name,
        convId: msg.conv_id,
        content: msg.content,
        createTime: msg.create_time,
        isGroup,
      });
      // 一条消息只认领一个码 —— 一条消息里出现多个待验证码，
      // 正常人不会这么发，只可能是有人在试图批量抢会话
      break;
    }
  }

  return winners;
}

function claim(
  codeId: string,
  info: {
    channel: "friend_request" | "direct_message" | "group_message";
    wxId: string;
    convId?: string;
    source: string;
    nickname?: string;
    avatar?: string;
  },
) {
  db.update(bindCodes)
    .set({
      status: "used",
      matchedChannel: info.channel,
      matchedWxId: info.wxId,
      matchedConvId: info.convId,
      // 绑定纠纷时这是唯一证据，务必保留原文
      matchedSource: info.source,
      matchedAt: Date.now(),
      usedAt: Date.now(),
    })
    .where(and(eq(bindCodes.id, codeId), eq(bindCodes.status, "pending")))
    .run();
}

export type BindStatus =
  | { state: "pending"; expiresAt: number }
  | { state: "expired" }
  | { state: "not_member"; wxId: string; nickname?: string }
  /** 匹配到了身份，但暂时判定不了成员资格（上游不可用）。前端应继续等待 */
  | { state: "upstream_down" }
  | { state: "bound"; userId: string; wxId: string; isNewUser: boolean };

/**
 * 查询绑定进度。前端轮询这个接口。
 * 命中后校验群成员身份 —— 只有在已同步群里发过言的人才算成员。
 */
export async function checkBindStatus(nonce: string): Promise<BindStatus> {
  await pollBindChannels();

  const record = db.select().from(bindCodes).where(eq(bindCodes.sessionNonce, nonce)).get();
  if (!record) return { state: "expired" };

  if (record.status === "pending") {
    if (record.expiresAt < Date.now()) return { state: "expired" };
    return { state: "pending", expiresAt: record.expiresAt };
  }
  if (record.status !== "used" || !record.matchedWxId) return { state: "expired" };

  const wxId = record.matchedWxId;
  const member = await isCommunityMember(wxId);
  if (member === "unknown") return { state: "upstream_down" };
  if (!member) return { state: "not_member", wxId };

  const existing = db.select().from(users).where(eq(users.wxId, wxId)).get();
  if (existing) {
    return { state: "bound", userId: existing.id, wxId, isNewUser: false };
  }

  const created = db
    .insert(users)
    .values({
      wxId,
      // 昵称与头像由 syncUserIdentities 统一维护，这里先填个占位
      wxNickname: record.matchedWxId,
      wxAvatarUrl: null,
      kind: "member",
      status: "active",
      firstBoundAt: Date.now(),
      lastActiveAt: Date.now(),
    })
    .returning({ id: users.id })
    .get();

  return { state: "bound", userId: created.id, wxId, isNewUser: true };
}

/**
 * 是否是社群成员：在任一已开启同步的群里有记录。
 *
 * 三条判定路径，按代价从低到高：本地成员表 → 本地消息镜像 → 回源上游。
 *
 * 返回 "unknown" 而不是 false 表示**判定不了**（上游挂了）。
 * 这个区分很重要：早期版本把异常 catch 成 false，结果所有人都被告知
 * 「你不是社群成员」，而真实原因是接口返回形态与预期不符。
 * 判定失败必须表现为「稍后再试」，不能表现为「你没资格」。
 */
async function isCommunityMember(wxId: string): Promise<boolean | "unknown"> {
  const syncedGroups = db
    .select({ convId: groups.convId })
    .from(groups)
    .where(eq(groups.syncEnabled, true))
    .all()
    .map((g) => g.convId);

  if (syncedGroups.length === 0) return false;

  const rosterRows = db
    .select({ convId: groupMembers.convId, leftAt: groupMembers.leftAt })
    .from(groupMembers)
    .where(and(eq(groupMembers.wxId, wxId), inArray(groupMembers.convId, syncedGroups)))
    .all();

  // 还在任一群里 —— 最直接的证据
  if (rosterRows.some((r) => r.leftAt === null)) return true;

  /*
   * **名册里有他、而且每一条都标着已退群** —— 这是「他不是成员」的
   * 正面证据，比下面那条「他发过言」强。
   *
   * 原来这里不看 `left_at`，于是一个退光了所有群的人照样能绑定新账号；
   * 而且就算看了，如果还接着往下走「发过言就算成员」那条，
   * 结论仍然是 true —— 退过群的人一定发过言。
   * 所以这里必须直接返回，不能只是不返回 true。
   */
  if (rosterRows.length > 0) return false;

  // 名册里根本没有他（多半是名册还没同步过）——
  // 这时候「在已同步群里发过言」仍然是成员的充分证据
  const spoke = db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.senderWxId, wxId), inArray(messages.convId, syncedGroups)))
    .limit(1)
    .get();
  if (spoke) return true;

  try {
    const upstream = await nekobot.userGroups(wxId);
    return upstream.items.some((g) => syncedGroups.includes(g.conv_id));
  } catch (err) {
    if (err instanceof NekoBotError && err.isUpstreamDown) return "unknown";
    // 形态不符之类的意外必须暴露出来，不能伪装成业务结果
    console.error("成员判定失败", err);
    return "unknown";
  }
}
