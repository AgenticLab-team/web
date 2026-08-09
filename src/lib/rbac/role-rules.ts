/**
 * 自定义身份组。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 四个字段，零引用
 * ─────────────────────────────────────────
 *
 * `roles` 表上 `max_holders`、`auto_grant_rule`、`auto_revoke`、
 * `badge_style` 四列在 schema 之外**没有任何地方读或写**，
 * 而后台那一页是只读的 —— 身份组只能靠改代码里的
 * `BUILTIN_ROLES` 来增减。
 *
 * ─────────────────────────────────────────
 * 自动授予是一条提权路径
 * ─────────────────────────────────────────
 *
 * 「累计 1000 分自动给某某身份」听起来只是荣誉，
 * 而身份组是**权限容器**：给出去的那一刻，那个人拿到的是
 * 这个组挂着的全部权限点。
 *
 * 一条写错的规则（比如把 `>=` 写成 `<=`）会把一个带删帖权的组
 * 发给全站所有人，而这个过程是自动的、无声的、每五分钟跑一次。
 *
 * 所以：**带危险权限的组不许配自动授予**。这不是可配置的谨慎，
 * 是一条写死的线。
 *
 * ─────────────────────────────────────────
 * 自动回收只回收自动发的
 * ─────────────────────────────────────────
 *
 * 管理员手动给出去的身份是一个人的决定 ——
 * 规则不该把它撤掉。一次分数波动就抹掉站长亲手给的荣誉，
 * 而当事人只会看到「我的身份没了」，没有任何解释。
 *
 * 判据是 `user_roles.granted_by`：自动发的记 "system"。
 */

/** 自动发放时记在 granted_by 上的值 —— 和积分那边的约定一致 */
export const SYSTEM_ACTOR = "system";

export const MAX_ROLE_NAME = 12;
export const MAX_ROLE_KEY = 32;

export interface RoleDraft {
  key: string;
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  priority: number;
  maxHolders?: number | null;
  autoGrantRule?: unknown;
  autoRevoke?: boolean;
}

export type RoleVerdict = { ok: true; draft: RoleDraft } | { ok: false; error: string };

/**
 * key 的形状。
 *
 * 只允许小写字母、数字和下划线 —— 它会出现在权限判定、
 * 配置文件和 URL 里，一个带空格或中文的 key 迟早会在某处被截断，
 * 而截断之后的判定结果是**放行**（找不到就当没有这个组）。
 */
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * 内置的那几个 key 不许被自定义组占用。
 *
 * 占了之后，`can()` 里按 key 找的地方会拿到错的那一个 ——
 * 而那些地方判的是「是不是管理员」。
 */
export const RESERVED_KEYS = [
  "owner",
  "admin",
  "moderator",
  "group_admin",
  "auditor",
  "member",
  "external",
  "system",
  "guest",
];

export function checkRole(input: RoleDraft, existingKeys: string[]): RoleVerdict {
  const key = input.key.trim().toLowerCase();
  const name = input.name.trim().replace(/\s+/g, " ");

  if (!KEY_PATTERN.test(key)) {
    return { ok: false, error: "key 只能用小写字母、数字和下划线，且以字母开头" };
  }
  if (key.length > MAX_ROLE_KEY) return { ok: false, error: `key 最多 ${MAX_ROLE_KEY} 个字符` };
  if (RESERVED_KEYS.includes(key)) {
    return { ok: false, error: `「${key}」是内置身份组的 key，换一个` };
  }
  if (existingKeys.includes(key)) return { ok: false, error: "已经有同 key 的身份组了" };

  if (!name) return { ok: false, error: "得有名字 —— 它会显示在所有人的名字旁边" };
  if (name.length > MAX_ROLE_NAME) {
    return { ok: false, error: `名字最多 ${MAX_ROLE_NAME} 个字` };
  }

  if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 1000) {
    return { ok: false, error: "优先级要是 0–1000 的整数" };
  }

  if (input.color && !/^#[0-9a-fA-F]{6}$/.test(input.color)) {
    return { ok: false, error: "颜色要写成 #RRGGBB" };
  }

  if (
    input.maxHolders !== null &&
    input.maxHolders !== undefined &&
    (!Number.isInteger(input.maxHolders) || input.maxHolders < 1)
  ) {
    return { ok: false, error: "名额上限要是 1 以上的整数，不限就留空" };
  }

  return {
    ok: true,
    draft: { ...input, key, name, description: input.description?.trim() || null },
  };
}

export type AutoGrantVerdict = { ok: true } | { ok: false; error: string };

/**
 * 这个组能不能配自动授予。
 *
 * ─────────────────────────────────────────
 * 带危险权限的一律不行
 * ─────────────────────────────────────────
 *
 * 一条写错的规则会把这个组发给全站所有人，而这个过程是自动的、
 * 无声的、每五分钟跑一次。发出去的是删帖权、封号权这类东西的话，
 * 等有人发现时已经发生过了。
 *
 * 判据用权限的 dangerLevel，不是「是不是内置组」——
 * 一个自定义组照样可以挂上危险权限。
 */
export function canAutoGrant(input: {
  isSystem: boolean;
  maxDangerLevel: number;
}): AutoGrantVerdict {
  if (input.isSystem) {
    return { ok: false, error: "内置身份组不能配自动授予 —— 它们决定谁是管理员" };
  }
  if (input.maxDangerLevel >= 2) {
    return {
      ok: false,
      error: "这个组挂着危险权限，不能自动发 —— 规则写错一次就会发给所有人，而且没有声音",
    };
  }
  return { ok: true };
}

export interface HolderState {
  userId: string;
  /** 自动发的还是人给的 */
  auto: boolean;
}

export interface SettlePlan {
  grant: string[];
  revoke: string[];
  /** 够格但名额满了 —— 要说出来，否则「为什么我没拿到」无从解释 */
  waitlisted: string[];
}

/**
 * 一轮自动结算要做什么。
 *
 * @param eligible 现在够格的人
 * @param holders  现在持有的人
 * @param maxHolders 名额上限，null = 不限
 * @param autoRevoke 不够格时要不要收回
 */
export function planSettle(input: {
  eligible: string[];
  holders: HolderState[];
  maxHolders: number | null;
  autoRevoke: boolean;
}): SettlePlan {
  const holding = new Set(input.holders.map((h) => h.userId));

  /*
   * 先算回收，再算发放 —— 顺序有意义。
   *
   * 反过来的话，一个名额满了的组永远发不出去新的，
   * 即使这一轮正好有人不够格了该腾出位置。
   */
  const revoke = input.autoRevoke
    ? input.holders
        .filter((h) => h.auto && !input.eligible.includes(h.userId))
        /*
         * **只回收自动发的**。管理员手动给出去的身份是一个人的决定，
         * 规则不该把它撤掉 —— 一次分数波动抹掉站长亲手给的荣誉，
         * 而当事人只会看到「我的身份没了」。
         */
        .map((h) => h.userId)
    : [];

  const afterRevoke = holding.size - revoke.length;
  const room = input.maxHolders === null ? Infinity : Math.max(0, input.maxHolders - afterRevoke);

  const candidates = input.eligible.filter((id) => !holding.has(id) || revoke.includes(id));
  const grant = candidates.slice(0, room === Infinity ? candidates.length : room);
  const waitlisted = candidates.slice(grant.length);

  return { grant, revoke, waitlisted };
}

/** 名额还剩多少 —— 后台要显示，「满了」和「没人够格」是两回事 */
export function seatsLeft(maxHolders: number | null, current: number): number | null {
  return maxHolders === null ? null : Math.max(0, maxHolders - current);
}

/**
 * 删一个身份组之前。
 *
 * 有人持有的组不给删 —— 删掉之后那些人的权限会**静默地少掉一块**，
 * 而他们只会发现某些页面突然打不开了。先撤干净再删。
 */
export function canDelete(input: { isSystem: boolean; holders: number }): AutoGrantVerdict {
  if (input.isSystem) return { ok: false, error: "内置身份组不能删" };
  if (input.holders > 0) {
    return {
      ok: false,
      error: `还有 ${input.holders} 个人持有 —— 先撤掉再删，否则他们的权限会无声地少一块`,
    };
  }
  return { ok: true };
}
