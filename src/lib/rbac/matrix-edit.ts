/**
 * 权限矩阵的在线编辑。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 一次矩阵改动是这个站里影响面最大的写操作
 * ─────────────────────────────────────────
 *
 * 改一格,可能有四十个人从此能删别人的帖。而在矩阵上,
 * 那一格和旁边四百格长得一模一样 —— **它的影响面是看不见的**。
 *
 * 所以这里有两半:
 *
 *   · **护栏**:有些改动无论如何都不许发生
 *   · **diff**:允许的改动,要在按下保存之前把后果说出来
 *
 * 第二半不是锦上添花。一个看得见后果的危险操作,和一个看不见后果的
 * 安全操作相比,前者更不容易出事。
 *
 * ─────────────────────────────────────────
 * 提权是这里唯一不能商量的一条
 * ─────────────────────────────────────────
 *
 * `role.manage` 是 dangerLevel 2,管理员有。而 ADMIN_DENIES 里
 * 明确不给管理员 `system.settings`、`role.grant.admin`、`permission.override`。
 *
 * 如果矩阵编辑只查 `role.manage`,那管理员可以直接编辑「管理员」这个
 * 身份组,给自己加上 `system.settings` —— **ADMIN_DENIES 整张表当场作废**。
 * 一个绕过所有其它权限检查的入口。
 *
 * 所以:**你不能授予你自己没有的权限**。这条一旦破了,
 * 权限系统剩下的部分全都失去意义。
 */

import type { MatrixState } from "@/lib/admin/matrix-types";
import { PERMISSION_KEYS } from "@/lib/rbac/permissions";

export type { MatrixState };

export interface CellChange {
  roleId: string;
  roleName: string;
  permissionKey: string;
  from: MatrixState;
  to: MatrixState;
}

/**
 * 把「当前矩阵」和「提交上来的改动」对成一串真正变了的格子。
 *
 * 提交上来的东西里会混着没变的格子（前端往往整行整表提交），
 * 原样存下去的话变更历史里会全是噪音,
 * 而**噪音多的历史等于没有历史** —— 没有人会去翻一份每次都几百条的日志。
 */
export function diffCells(
  current: Map<string, Map<string, MatrixState>>,
  proposed: { roleId: string; permissionKey: string; state: MatrixState }[],
  roleName: (roleId: string) => string,
): CellChange[] {
  const changes: CellChange[] = [];

  for (const cell of proposed) {
    const from = current.get(cell.roleId)?.get(cell.permissionKey) ?? "none";
    if (from === cell.state) continue;
    changes.push({
      roleId: cell.roleId,
      roleName: roleName(cell.roleId),
      permissionKey: cell.permissionKey,
      from,
      to: cell.state,
    });
  }

  return changes.sort(
    (a, b) => a.roleName.localeCompare(b.roleName, "zh") || a.permissionKey.localeCompare(b.permissionKey),
  );
}

/**
 * 一次改动的真实后果。
 *
 * `affectedUsers` 是**按人算出来的**,不是「这个身份组有几个人」。
 * 两者经常差很多:
 *
 *   · 一个人同时在三个组里,改其中一个组未必改变他的最终权限
 *   · `denied` 压过任何 `granted` —— 把一格从 none 改成 denied,
 *     会把这个人从**别的身份组**拿到的权限也一起打掉
 *
 * 第二条是最容易估错的:看着像「没给他加东西」,实际是「拿走了他的东西」。
 */
export interface MatrixImpact {
  gained: { userId: string; name: string; permissions: string[] }[];
  lost: { userId: string; name: string; permissions: string[] }[];
}

export interface MatrixDiff {
  changes: CellChange[];
  impact: MatrixImpact;
  /** 一句话摘要,放在确认按钮旁边 */
  summary: string;
}

/**
 * 「将获得 3 项、失去 1 项,影响 4 人」。
 *
 * 三个数字都要有,而且**失去要排在获得前面** ——
 * 收回权限比授予权限更容易出事,把它放在句子后半段人会读漏。
 */
export function summarizeImpact(impact: MatrixImpact): string {
  const lostCount = impact.lost.reduce((n, u) => n + u.permissions.length, 0);
  const gainedCount = impact.gained.reduce((n, u) => n + u.permissions.length, 0);
  const people = new Set([...impact.gained, ...impact.lost].map((u) => u.userId)).size;

  if (people === 0) return "没有人的实际权限会改变";

  const parts: string[] = [];
  if (lostCount > 0) parts.push(`失去 ${lostCount} 项`);
  if (gainedCount > 0) parts.push(`获得 ${gainedCount} 项`);
  return `${parts.join("、")}，影响 ${people} 人`;
}

export interface GuardrailInput {
  changes: CellChange[];
  /** 操作者自己有效的权限点 */
  actorPermissions: Set<string>;
  /** 操作者手上优先级最高的身份组 */
  actorPriority: number;
  /** roleId -> 这个身份组的优先级 */
  rolePriority: Map<string, number>;
  /** 改完之后,还有几个活跃的人能改矩阵 */
  keystoneHoldersAfter: number;
  /** 必填理由 */
  reason: string;
}

/**
 * 改完之后必须还有人握着的权限。
 *
 * 把 `role.manage` 从所有身份组上摘掉,矩阵就**永远改不回来了** ——
 * 这不是一个可以事后修的错误,这是把门从里面锁上再把钥匙扔了。
 */
export const KEYSTONE_PERMISSION = "role.manage";

/** 理由至少要有内容,而不是一个空格 */
export const MIN_REASON_LENGTH = 4;

export function guardrailErrors(input: GuardrailInput): string[] {
  const errors: string[] = [];

  if (input.changes.length === 0) {
    errors.push("没有任何改动");
    return errors;
  }

  if (input.reason.trim().length < MIN_REASON_LENGTH) {
    errors.push(`得写清楚为什么改（至少 ${MIN_REASON_LENGTH} 个字）—— 事后复盘时这句话比 diff 本身有用`);
  }

  const validKeys = new Set<string>(PERMISSION_KEYS);

  for (const change of input.changes) {
    /*
     * 认不出的权限点直接拒绝。
     *
     * UI 上不会发生 —— 格子是从权限表渲染出来的。但这个 action 收的是
     * 客户端传来的东西,而一个拼错的权限点会**静默地**在
     * role_permissions 里留下一行永远匹配不到任何东西的记录。
     *
     * 「存下来了但不起作用」是这套系统里最难查的一类问题:
     * 矩阵上看着是打勾的,而判定永远走不到那一格。
     */
    if (!validKeys.has(change.permissionKey)) {
      errors.push(`没有「${change.permissionKey}」这个权限点 —— 存下去也只会是一行永远匹配不到的记录`);
      continue;
    }

    if (!input.rolePriority.has(change.roleId)) {
      errors.push(`找不到「${change.roleName}」这个身份组，它可能刚被删掉了`);
      continue;
    }

    /*
     * 提权:你不能授予你自己没有的权限。
     *
     * 「把 denied 改成 none」也算授予 —— 显式拒绝挡掉的东西,
     * 撤掉拒绝就等于放行。只看 to === "granted" 会漏掉这一路。
     */
    const isGranting = change.to === "granted" || (change.from === "denied" && change.to === "none");
    if (isGranting && !input.actorPermissions.has(change.permissionKey)) {
      errors.push(`你自己没有「${change.permissionKey}」，不能把它授予别人`);
    }

    /*
     * 不能动比自己高的身份组。
     *
     * 没有这一条的话,管理员可以把站长的权限一项项摘掉 ——
     * 每一项都符合「我自己有这个权限」,合起来是一次夺权。
     */
    const priority = input.rolePriority.get(change.roleId) ?? 0;
    if (priority > input.actorPriority) {
      errors.push(`「${change.roleName}」的优先级比你高，不能改它`);
    }
  }

  if (input.keystoneHoldersAfter === 0) {
    errors.push(
      `改完之后就没有人能再改权限矩阵了 —— 这不是能事后修的错误，是把门从里面锁上再把钥匙扔了`,
    );
  }

  // 同一条错误可能被多个格子触发,去重之后才是给人看的
  return [...new Set(errors)];
}

/** 三态之间的说法,给 diff 列表用 */
export function stateLabel(state: MatrixState): string {
  return { granted: "允许", denied: "显式拒绝", none: "未授予" }[state];
}

/**
 * 这一格的改动危险吗 —— 用来决定 diff 里要不要标红。
 *
 * 「变成显式拒绝」也算危险:它会把人从**别的身份组**拿到的权限打掉,
 * 而这是所有三态操作里最容易估错后果的一个。
 */
export function isRiskyChange(change: CellChange, dangerLevel: number): boolean {
  if (change.to === "denied") return true;
  if (change.to === "granted" && dangerLevel >= 2) return true;
  return false;
}
