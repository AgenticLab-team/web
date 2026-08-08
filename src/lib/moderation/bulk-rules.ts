/**
 * 批量操作的判定。纯函数。
 *
 * 批量操作是后台里**最容易造成不可逆损失**的功能：
 * 全选一下、点一次删除，两百篇内容和它们背后两百个人的心血就没了。
 * 而且做错之后往往没人立刻发现 —— 内容消失是安静的。
 *
 * 所以这里的每一条都在给「手滑」加成本：
 *
 *   ① **有条数上限。** 一次最多处理 50 条。真要清理更多，
 *      分几次做 —— 分批的过程本身就是几次「你确定吗」。
 *   ② **必填理由，且每一条都独立留痕。** 只记一条汇总日志的话，
 *      用户档案上看不到自己那条，申诉时也无从查起。
 *   ③ **部分失败必须如实报告。** 批量里最恶心的是「成功了 47 条」
 *      而剩下 3 条静默消失 —— 那 3 条到底怎么了没人知道。
 */

export type BulkAction = "hide" | "delete" | "restore" | "lock" | "unlock" | "feature" | "unfeature";

/** 一次最多处理多少条 */
export const BULK_LIMIT = 50;

/** 会让内容从别人眼前消失的动作，需要更强的确认 */
const DESTRUCTIVE: ReadonlySet<BulkAction> = new Set(["hide", "delete"]);

export function isDestructive(action: string): boolean {
  return DESTRUCTIVE.has(action as BulkAction);
}

export interface RuleResult {
  ok: boolean;
  error?: string;
}

const OK: RuleResult = { ok: true };
const no = (error: string): RuleResult => ({ ok: false, error });

export interface BulkInput {
  ids: readonly string[];
  action: BulkAction;
  reason: string;
}

export function checkBulk(input: BulkInput): RuleResult {
  if (input.ids.length === 0) return no("一条都没选");

  if (input.ids.length > BULK_LIMIT) {
    return no(`一次最多处理 ${BULK_LIMIT} 条，选了 ${input.ids.length} 条 —— 请分批做`);
  }

  if (!input.reason.trim()) return no("必须填写理由");

  /*
   * 破坏性操作的理由要长一点。
   * 「违规」两个字在三个月后的申诉里毫无价值 ——
   * 当事人看不出自己到底做错了什么，处理的人也回忆不起来。
   */
  if (isDestructive(input.action) && input.reason.trim().length < 4) {
    return no("删除和隐藏要写清楚原因，至少四个字");
  }

  // 同一个 id 出现两次会导致重复留痕、重复通知
  if (new Set(input.ids).size !== input.ids.length) {
    return no("选中的条目里有重复");
  }

  return OK;
}

export interface BulkOutcome {
  id: string;
  ok: boolean;
  error?: string;
}

export interface BulkReport {
  total: number;
  succeeded: number;
  failed: BulkOutcome[];
  /** 给用户看的一句话总结 */
  message: string;
}

/**
 * 汇总批量结果。
 *
 * **失败的必须被点名**。只报「成功 47 条」的话，
 * 剩下 3 条到底怎么了没人知道，而那 3 条往往正是有问题的那几条。
 */
export function summarize(outcomes: readonly BulkOutcome[], actionLabel: string): BulkReport {
  const failed = outcomes.filter((o) => !o.ok);
  const succeeded = outcomes.length - failed.length;

  let message: string;
  if (failed.length === 0) {
    message = `已${actionLabel} ${succeeded} 条`;
  } else if (succeeded === 0) {
    message = `全部失败（${failed.length} 条）：${failed[0].error ?? "未知原因"}`;
  } else {
    message = `${actionLabel}了 ${succeeded} 条，${failed.length} 条失败：${failed[0].error ?? "未知原因"}`;
  }

  return { total: outcomes.length, succeeded, failed, message };
}

export const ACTION_LABELS: Record<BulkAction, string> = {
  hide: "隐藏",
  delete: "删除",
  restore: "恢复",
  lock: "锁定",
  unlock: "解锁",
  feature: "加精",
  unfeature: "取消加精",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action as BulkAction] ?? action;
}

/**
 * 会影响多少个人。
 *
 * 界面上要说「影响 12 位作者」而不只是「12 条内容」——
 * 前者才让人意识到这是在动别人的东西。
 */
export function distinctAuthors(items: readonly { authorId: string }[]): number {
  return new Set(items.map((i) => i.authorId)).size;
}
