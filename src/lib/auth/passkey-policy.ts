/**
 * 「管理员强制 Passkey」的判定。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 这个开关在库里躺了很久，没有任何地方读它
 * ─────────────────────────────────────────
 *
 * `auth.require_passkey_for_admin` 默认值是 `"true"`，
 * 标签写着「管理员强制 Passkey 或 2FA」，说明写着「管理员账号不接受纯密码登录」。
 * 后台设置页把它显示成**开着的**。
 *
 * 而没有一行代码读它。
 *
 * 这比忘了做这个功能糟得多：忘了做，至少没有人以为它在。
 * 一个显示成「开」的安全开关，效果是让人**不再去想这件事** ——
 * 它把「管理员账号只有一道密码」这个事实藏了起来。
 *
 * ─────────────────────────────────────────
 * 谁算「管理员」
 * ─────────────────────────────────────────
 *
 * 不按角色名判。`can.ts` 开头就写着「任何地方都不许自己写
 * if (role === "admin")」—— 按名字判的东西会在有人加一个
 * 「运营」角色、给了它一半管理员权限的那天悄悄失效。
 *
 * 按**权限的危险等级**判：手里有任何一项 dangerLevel ≥ 2（危险/极危）
 * 的权限，就算privileged。这个判据跟着权限矩阵自动走。
 */

import { dangerLevelOf } from "@/lib/rbac/permissions";

/** 到这个危险等级就该有第二重保护。2 = 危险，3 = 极危 */
export const PRIVILEGED_DANGER_LEVEL = 2;

/**
 * 手里有没有「危险」级别的权限。
 *
 * 传权限点集合而不是 user，是为了让这一层不依赖数据库 ——
 * 它是登录路径上的判定，测试必须能密集地跑。
 */
export function isPrivileged(permissions: Iterable<string>): boolean {
  for (const key of permissions) {
    if (dangerLevelOf(key) >= PRIVILEGED_DANGER_LEVEL) return true;
  }
  return false;
}

/** 手里那些权限里，够得上「危险」的是哪几项 —— 用来解释「为什么我算管理员」 */
export function privilegedPermissions(permissions: Iterable<string>): string[] {
  return [...permissions].filter((k) => dangerLevelOf(k) >= PRIVILEGED_DANGER_LEVEL).sort();
}

export type PasswordLoginVerdict =
  | { allowed: true }
  | { allowed: false; code: "use_passkey"; message: string }
  | { allowed: false; code: "no_passkey_bound"; message: string };

/**
 * 这个人能不能用密码登录。
 *
 * ─────────────────────────────────────────
 * 两种拒绝要分开说
 * ─────────────────────────────────────────
 *
 *   · **有 Passkey**：直接让他去用，一句话就够
 *   · **没有 Passkey**：他现在**进不来**了 —— 这种情况必须说清楚，
 *     否则他会一遍遍试密码，而密码是对的，
 *     那种「明明没错却进不去」是最让人不知所措的失败
 *
 * 后一种在这里如实拒绝，不放行。放行的话这个开关就又变成了半个谎：
 * 说明里写着「不接受纯密码登录」，实际有时候接受。
 *
 * 而「会不会把所有管理员都锁在外面」不靠这里放水来防，
 * 靠 lockoutRisk() 把风险摆到台面上 —— 那是个能一直看得见的数字，
 * 比登录失败时才发现要早得多。
 */
export function passwordLoginVerdict(input: {
  privileged: boolean;
  hasPasskey: boolean;
  enforced: boolean;
}): PasswordLoginVerdict {
  if (!input.enforced || !input.privileged) return { allowed: true };

  if (input.hasPasskey) {
    return {
      allowed: false,
      code: "use_passkey",
      message: "这个账号有管理权限，按站点设置必须用 Passkey 登录。回上一步选「用 Passkey 登录」。",
    };
  }

  return {
    allowed: false,
    code: "no_passkey_bound",
    message:
      "这个账号有管理权限，按站点设置必须用 Passkey 登录，但它还没有绑定 Passkey —— 密码是对的，进不来是因为这条规则。找站长处理。",
  };
}

export interface LockoutRisk {
  /**
   * **真的被这条规则挡在外面的人**：有危险权限、有密码、但没有 Passkey。
   *
   * 「有密码」这个条件是在生产上跑第一遍时补的。原来只看
   * 「有权限且没 Passkey」，于是一个既没密码也没 Passkey 的管理员
   * 被报成了 down —— 可他本来就不走密码这条路，这条规则没挡住他任何事。
   *
   * 一个不成立的 down 比没有告警更糟：它教人忽略这个组件。
   */
  strandedCount: number;
  strandedNames: string[];
  /**
   * 有危险权限、也没有 Passkey，但现在还没有密码。
   *
   * 今天没事 —— 他们没在走密码这条路。但**任何一个人设了密码的那天
   * 就会进不来**，而那时没有人会想起是这条规则。所以要单独数出来。
   */
  atRiskCount: number;
  atRiskNames: string[];
  /** 开关现在是不是开着 */
  enforced: boolean;
  /** 现在就有人被挡在外面 */
  active: boolean;
}

/**
 * 「开了这个开关，谁会进不来」。
 *
 * 这个函数存在的理由：一个安全开关最危险的时刻不是它没生效，
 * 而是它**生效了但没人知道会有什么后果**。
 * 把人数摆在设置页上，比等某个管理员某天登不进来再去查要好。
 */
export function lockoutRisk(
  people: { name: string; privileged: boolean; hasPasskey: boolean; hasPassword: boolean }[],
  enforced: boolean,
): LockoutRisk {
  const exposed = people.filter((p) => p.privileged && !p.hasPasskey);
  const stranded = exposed.filter((p) => p.hasPassword);
  const atRisk = exposed.filter((p) => !p.hasPassword);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "zh");

  return {
    atRiskCount: atRisk.length,
    atRiskNames: atRisk.sort(byName).map((p) => p.name),
    strandedCount: stranded.length,
    /*
     * 按中文排序，不用默认的 sort()。
     *
     * 默认按 UTF-16 码位排，「乙」会排在「甲」前面 ——
     * 这串名字是要给人读的，读起来乱的名单会让人以为漏了谁。
     */
    strandedNames: stranded.sort(byName).map((p) => p.name),
    enforced,
    active: enforced && stranded.length > 0,
  };
}

/** 给设置页和健康检查用的一句话 */
export function describeRisk(risk: LockoutRisk): string {
  const tail =
    risk.atRiskCount > 0
      ? `。另有 ${risk.atRiskCount} 人有危险级权限、没绑 Passkey、也还没设密码（${risk.atRiskNames.join("、")}）—— 今天没事，设了密码那天就进不来`
      : "";

  if (!risk.enforced) {
    return risk.strandedCount > 0
      ? `没开启。开启的话有 ${risk.strandedCount} 人会登不进来（有危险级权限但没绑 Passkey）${tail}`
      : `没开启。管理员账号目前接受纯密码登录${tail}`;
  }
  if (risk.strandedCount === 0) {
    return `已开启，没有人被挡在外面${tail || "，所有有危险级权限的账号都绑了 Passkey"}`;
  }
  return `已开启，而 ${risk.strandedCount} 人有危险级权限却没绑 Passkey —— 他们现在登不进来：${risk.strandedNames.join("、")}${tail}`;
}

// ── 一个人自己的登录处境 ────────────────────────────────────

export interface SelfLoginStatus {
  /** 现在真的能把他放进门的路，按可靠程度排序 */
  paths: string[];
  /**
   * 红色：现在就有问题。目前只有一种 —— 有密码却被管理员强制
   * Passkey 挡着，「密码是对的却进不来」是最让人不知所措的失败
   */
  danger: string | null;
  /** 黄色：今天没事，但某个具体的将来会出事 */
  caution: string | null;
  /** 「不设密码」这个选择在他身上是否说得通（有别的可靠门路） */
  passwordlessViable: boolean;
}

/**
 * 「我现在到底能怎么登录」。给 /me 的登录与安全页用。
 *
 * 判定复用 lockoutRisk 的 stranded / atRisk 口径（传单人名单进去），
 * 而不是在这里重抄一份条件 —— 抄件和原件迟早会分叉，
 * 分叉的表现是：设置页说「有 1 人会被锁在外面」，
 * 而那个人自己的安全页却一片绿。
 */
export function selfLoginStatus(input: {
  privileged: boolean;
  hasPasskey: boolean;
  hasPassword: boolean;
  enforced: boolean;
}): SelfLoginStatus {
  const risk = lockoutRisk([{ name: "me", ...input }], input.enforced);
  const stranded = risk.active;
  const atRisk = input.enforced && risk.atRiskCount > 0;
  // 密码这条路通不通，问的是和登录时同一个判定 —— 不另抄条件
  const passwordUsable =
    input.hasPassword && passwordLoginVerdict(input).allowed;

  const paths: string[] = [];
  if (input.hasPasskey) paths.push("Passkey");
  if (passwordUsable) paths.push("密码");
  // 验证码永远排最后：它依赖群猫娘没被风控，是兜底不是正路
  paths.push("微信群验证码");

  return {
    paths,
    danger: stranded
      ? "你有管理权限，而站点要求管理员用 Passkey 登录 —— 你设的密码现在进不来，先绑一个 Passkey"
      : null,
    caution: atRisk
      ? "你有管理权限但还没绑 Passkey。现在走验证码没事，但哪天设了密码会发现它进不来 —— 先绑 Passkey"
      : !input.hasPasskey && !input.hasPassword
        ? "你现在只有群里的验证码这一条路 —— 它依赖群猫娘没被风控。绑一个 Passkey 最稳"
        : null,
    /*
     * 「不设密码」要有一条不依赖机器人的门路才算站得住：
     * 只剩验证码的人选择不设密码，等于把钥匙全押在风控没来上。
     * 不禁止（站长说了没密码的人走 Passkey 或绑定码），但界面要说清。
     */
    passwordlessViable: input.hasPasskey,
  };
}
