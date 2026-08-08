/**
 * 邀请的判定规则。纯函数。
 *
 * ─────────────────────────────────────────
 * 邀请体系最容易变成刷分工具
 * ─────────────────────────────────────────
 *
 * 拉一个僵尸号的成本几乎为零。所以这套规则的重点不是「怎么邀请」，
 * 是**「怎么让刷邀请不划算」**：
 *
 *   ① 奖励**延迟发放** —— 等被邀请人真的做了点什么才给
 *   ② **只奖励直接邀请**，没有多级 —— 多级是传销的结构
 *   ③ 被邀请人被封时**回滚奖励** —— 否则刷号被抓也不亏
 *   ④ 一个人只能被邀请一次 —— 否则注销重注册就能反复领
 */

export interface RuleResult {
  ok: boolean;
  error?: string;
}

const OK: RuleResult = { ok: true };
const no = (error: string): RuleResult => ({ ok: false, error });

/**
 * 邀请码的字符表。
 *
 * 刻意去掉了形近字符：0/O、1/I/L、2/Z、5/S、8/B。
 * 这些码会被人念出来、抄下来、在微信里转发 ——
 * 少一个歧义字符，就少一批「码是对的但输错了」的求助。
 */
const ALPHABET = "34679ACDEFGHJKMNPQRTUVWXY";
export const CODE_LENGTH = 8;

export function isValidCodeShape(code: string): boolean {
  const normalized = normalizeCode(code);
  return normalized.length === CODE_LENGTH && [...normalized].every((c) => ALPHABET.includes(c));
}

/**
 * 归一化用户输入的码。
 *
 * 大小写不敏感，去掉空格和连字符 —— 人会把 `ABCD-1234` 抄成
 * `abcd 1234`，为这个让人重输一次不值得。
 */
export function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, "");
}

/** 生成一个码。random 由调用方注入，方便测试与将来换实现 */
export function generateCode(random: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return out;
}

export interface CreateInput {
  maxUses: number | null;
  expiresInDays: number | null;
  note: string;
}

/** 一个码最多能发出去多少次 —— 再多就该考虑是不是该直接开放注册了 */
export const MAX_USES_LIMIT = 50;
export const MAX_EXPIRY_DAYS = 90;

export function checkCreate(input: CreateInput): RuleResult {
  if (input.maxUses !== null) {
    if (!Number.isInteger(input.maxUses) || input.maxUses < 1) {
      return no("可用次数必须是正整数");
    }
    if (input.maxUses > MAX_USES_LIMIT) {
      return no(`一个码最多 ${MAX_USES_LIMIT} 次 —— 再多的话，与其发码不如直接开放注册`);
    }
  }

  if (input.expiresInDays !== null) {
    if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1) {
      return no("有效期必须是正整数天");
    }
    if (input.expiresInDays > MAX_EXPIRY_DAYS) {
      return no(`有效期最长 ${MAX_EXPIRY_DAYS} 天 —— 一个码在外面躺半年，没人记得它是干什么的`);
    }
  }

  if (input.note.trim().length > 100) return no("备注太长了");
  return OK;
}

export interface InviteState {
  maxUses: number | null;
  usedCount: number;
  expiresAt: number | null;
  revokedAt: number | null;
  createdBy: string;
}

export interface RedeemInput {
  invite: InviteState | null;
  /** 使用者。已注册用户用别人的码是无效的 */
  userId: string | null;
  /** 这个人是不是已经被邀请过 */
  alreadyInvited: boolean;
  now: number;
}

export function checkRedeem(input: RedeemInput): RuleResult {
  if (!input.invite) return no("邀请码无效");

  const { invite } = input;
  if (invite.revokedAt !== null) return no("这个邀请码已经被撤销了");
  if (invite.expiresAt !== null && invite.expiresAt <= input.now) return no("邀请码已过期");
  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
    return no("这个邀请码已经用完了");
  }

  // 自己用自己的码没有意义，而且会在邀请树里造出自环
  if (input.userId !== null && input.userId === invite.createdBy) {
    return no("不能使用自己创建的邀请码");
  }

  /*
   * 一个人只能被邀请一次。
   * 不限制的话，注销重注册就能反复给同一个邀请人送奖励。
   */
  if (input.alreadyInvited) return no("你已经通过邀请加入过了");

  return OK;
}

export interface RewardInput {
  /** 被邀请人是否完成过首次打卡 */
  inviteeCheckedIn: boolean;
  /** 被邀请人当前状态 */
  inviteeStatus: string;
  /** 是否已经发过 */
  alreadyRewarded: boolean;
  /** 是否已经回滚过 */
  reverted: boolean;
}

/**
 * 该不该发邀请奖励。
 *
 * **门槛是「被邀请人完成首次打卡」**，不是「注册成功」。
 * 注册即给的话，拉一堆僵尸号就能刷分。
 * 而打卡本身要求群里发言或论坛活跃达标 ——
 * 也就是说，只有真的参与了社区的人才会让邀请人拿到奖励。
 * 这条门槛是复用现成的反作弊，不是新造一套。
 */
export function shouldReward(input: RewardInput): boolean {
  if (input.alreadyRewarded || input.reverted) return false;
  if (input.inviteeStatus !== "active") return false;
  return input.inviteeCheckedIn;
}

/**
 * 该不该回滚已发的奖励。
 *
 * 被邀请人被封 = 这次邀请没有带来真实的人。
 * 不回滚的话，「刷号被抓也不亏」，那等于鼓励刷。
 */
export function shouldRevertReward(input: {
  inviteeStatus: string;
  alreadyRewarded: boolean;
  reverted: boolean;
}): boolean {
  if (!input.alreadyRewarded || input.reverted) return false;
  return input.inviteeStatus === "banned" || input.inviteeStatus === "deleted";
}

export interface InviteStatus {
  usable: boolean;
  label: string;
  remaining: number | null;
}

export function describeInvite(invite: InviteState, now: number): InviteStatus {
  if (invite.revokedAt !== null) return { usable: false, label: "已撤销", remaining: 0 };
  if (invite.expiresAt !== null && invite.expiresAt <= now) {
    return { usable: false, label: "已过期", remaining: 0 };
  }

  const remaining = invite.maxUses === null ? null : invite.maxUses - invite.usedCount;
  if (remaining !== null && remaining <= 0) {
    return { usable: false, label: "已用完", remaining: 0 };
  }

  return {
    usable: true,
    label: remaining === null ? "可用（不限次）" : `可用（还剩 ${remaining} 次）`,
    remaining,
  };
}

/**
 * 邀请链的深度上限。
 *
 * 只用于**展示**邀请树，不用于发奖 —— 多级奖励是传销的结构。
 * 限制深度是为了防止数据异常时把页面拖垮。
 */
export const MAX_TREE_DEPTH = 5;

export interface TreeNode<T> {
  value: T;
  children: TreeNode<T>[];
}

/**
 * 从「谁邀请了谁」的扁平关系构建邀请树。
 *
 * **必须防环**：invitedBy 正常情况下天然无环（注册时设一次），
 * 但数据被手工改过就可能成环，那时递归会直接把进程转死。
 */
export function buildTree<T extends { id: string; invitedBy: string | null }>(
  rows: readonly T[],
  rootId: string,
  maxDepth = MAX_TREE_DEPTH,
): TreeNode<T> | null {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.invitedBy) continue;
    const list = children.get(row.invitedBy) ?? [];
    list.push(row);
    children.set(row.invitedBy, list);
  }

  const root = byId.get(rootId);
  if (!root) return null;

  const seen = new Set<string>();

  const build = (node: T, depth: number): TreeNode<T> => {
    // 见过就不再展开 —— 数据成环时这是唯一能拦住无限递归的东西
    if (seen.has(node.id) || depth >= maxDepth) return { value: node, children: [] };
    seen.add(node.id);

    return {
      value: node,
      children: (children.get(node.id) ?? []).map((child) => build(child, depth + 1)),
    };
  };

  return build(root, 0);
}

/** 往上追溯邀请人。同样要防环 */
export function ancestorsOf<T extends { id: string; invitedBy: string | null }>(
  rows: readonly T[],
  userId: string,
  maxDepth = MAX_TREE_DEPTH,
): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: T[] = [];
  const seen = new Set<string>([userId]);

  let cursor = byId.get(userId)?.invitedBy ?? null;
  while (cursor && out.length < maxDepth) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    out.push(node);
    cursor = node.invitedBy;
  }

  return out;
}
