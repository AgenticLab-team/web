import { VISIBILITY_LEVELS, type Visibility } from "@/lib/db/schema";
import { isStricter } from "@/lib/forum/visibility";

/**
 * 版块与标签管理的判定规则。纯函数，后台动作和测试共用。
 *
 * 版块配置改错的后果比看起来严重：可见性上限一收紧，
 * 已经发出去的帖子会**当场从别人眼前消失**，作者不知道为什么。
 * 所以这里的重点不是「能不能改」，而是**改之前能不能算出影响面**。
 */

export interface RuleResult {
  ok: boolean;
  error?: string;
}

const OK: RuleResult = { ok: true };
const no = (error: string): RuleResult => ({ ok: false, error });

/** 版块 key 会进 URL，建好之后不能改 —— 改了等于把所有旧链接作废 */
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/;

export function checkBoardKey(key: string): RuleResult {
  if (!KEY_PATTERN.test(key)) {
    return no("版块标识只能用小写字母、数字和连字符，2–31 个字符");
  }
  return OK;
}

export interface BoardInput {
  key: string;
  name: string;
  defaultVisibility: Visibility;
  maxVisibility: Visibility;
  postMinLevel: number;
}

export function checkBoardConfig(input: BoardInput): RuleResult {
  if (!input.name.trim()) return no("版块要有名字");

  /*
   * 默认可见性不能比上限还宽松。
   * 配成这样的话，每个新帖都会被静默降级 ——
   * 作者选了「公开」，发出来却是「仅成员」，而且没有任何提示。
   */
  if (isStricter(input.maxVisibility, input.defaultVisibility)) {
    return no("默认可见性不能比上限更宽松，否则每个新帖都会被悄悄降级");
  }

  if (!Number.isInteger(input.postMinLevel) || input.postMinLevel < 0) {
    return no("发帖等级门槛必须是非负整数");
  }

  return OK;
}

/**
 * 收紧可见性上限会影响多少已有帖子。
 *
 * 返回受影响的帖子，让管理员**在保存前**看到
 * 「这一改，有 12 篇帖子会从公开变成仅成员」。
 * 不给这个数字的话，改配置就是在闭着眼睛动别人的东西。
 */
export function postsAboveCap<T extends { id: string; visibility: Visibility }>(
  posts: readonly T[],
  newMax: Visibility,
): T[] {
  return posts.filter((p) => isStricter(newMax, p.visibility));
}

/** 版块树不能成环 —— 成环会让面包屑和递归查询直接死循环 */
export function wouldCreateCycle(
  boardId: string,
  newParentId: string | null,
  parentOf: ReadonlyMap<string, string | null>,
): boolean {
  if (!newParentId) return false;
  if (newParentId === boardId) return true;

  let cursor: string | null = newParentId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === boardId) return true;
    // 数据本身已经有环时也要能停下来，不然这个检查自己会挂
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  return false;
}

export interface BoardDeleteInput {
  postCount: number;
  childCount: number;
  /** 要把帖子搬去哪个版块，没有就必须先清空 */
  moveTo: string | null;
  boardId: string;
}

export function checkBoardDelete(input: BoardDeleteInput): RuleResult {
  if (input.childCount > 0) return no("请先处理子版块");
  if (input.postCount > 0 && !input.moveTo) {
    // 直接删掉版块会让里面的帖子变成孤儿：查得到、打不开
    return no(`这个版块里还有 ${input.postCount} 篇帖子，请先指定搬去哪里`);
  }
  if (input.moveTo === input.boardId) return no("不能搬到它自己");
  return OK;
}

export interface TagMergeInput {
  fromId: string;
  toId: string;
  fromLocked: boolean;
}

export function checkTagMerge(input: TagMergeInput): RuleResult {
  if (input.fromId === input.toId) return no("不能合并到它自己");
  if (input.fromLocked) return no("被锁定的标签不能合并掉，请先解锁");
  return OK;
}

/**
 * 合并标签时，两个标签都有的帖子只保留一条关联。
 *
 * 不去重的话唯一索引会直接报错，整次合并回滚 ——
 * 而「有帖子同时打了这两个标签」恰恰是最该合并的信号。
 */
export function postsToRelink(
  fromPostIds: readonly string[],
  toPostIds: readonly string[],
): { relink: string[]; dropDuplicate: string[] } {
  const already = new Set(toPostIds);
  const relink: string[] = [];
  const dropDuplicate: string[] = [];
  for (const id of fromPostIds) {
    if (already.has(id)) dropDuplicate.push(id);
    else relink.push(id);
  }
  return { relink, dropDuplicate };
}

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  public: "公开",
  unlisted: "不索引",
  member: "仅成员",
  role: "指定身份组",
  group: "仅本群",
  private: "仅自己",
};

export function visibilityLabel(v: string): string {
  return VISIBILITY_LABELS[v as Visibility] ?? v;
}

export const VISIBILITY_OPTIONS = VISIBILITY_LEVELS.map((key) => ({
  key,
  label: VISIBILITY_LABELS[key],
}));
