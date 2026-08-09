/**
 * 投票的规则。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 这一层存在的直接原因
 * ─────────────────────────────────────────
 *
 * 站长说「投票只能看不能发」。查下来是字面意思：
 * `castVote` 接好了、`PollWidget` 渲染得好好的，
 * 而 **`createPoll` 写了 45 行，全站一个调用点都没有** ——
 * 没有任何界面能建出一个投票来。
 *
 * 补界面的时候会多出第二条创建路径（发帖时顺带建投票）。
 * 两条路径各写一份校验，迟早会分叉 —— 而分叉的表现是
 * 「从这个入口建的投票有 12 个选项上限，从那个入口建的没有」，
 * 没人查得出为什么。所以校验收在这里，两边都调它。
 */

/** 选项最多几个 —— 再多在手机上就要滚动才能看完，而看不完的投票没人投 */
export const MAX_OPTIONS = 12;

/** 单个选项最多几个字 */
export const MAX_OPTION_CHARS = 40;

/** 问题最多几个字 */
export const MAX_QUESTION_CHARS = 80;

export type PollDraftCheck =
  | { ok: true; options: string[]; question: string | null }
  | { ok: false; error: string };

/**
 * 把用户填的东西清成能落库的样子。
 *
 * **去重是必须的**：两个一模一样的选项在结果里没法区分，
 * 而投票的意义就在于结果能被读懂。
 * 去重按去空白之后的文本算 —— 「同意」和「同意 」是同一个选项，
 * 不能因为多了个空格就变成两个。
 */
export function normalizePollDraft(input: {
  question?: string | null;
  options: string[];
}): PollDraftCheck {
  const seen = new Set<string>();
  const options: string[] = [];

  for (const raw of input.options) {
    const text = raw.trim();
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    options.push(text.slice(0, MAX_OPTION_CHARS));
    if (options.length >= MAX_OPTIONS) break;
  }

  if (options.length < 2) {
    return { ok: false, error: "至少要两个不一样的选项 —— 只有一个选项的投票问不出任何东西" };
  }

  const question = input.question?.trim() ? input.question.trim().slice(0, MAX_QUESTION_CHARS) : null;
  return { ok: true, options, question };
}

/**
 * 截止时间合不合理。
 *
 * 允许不设 —— 一个不截止的投票是正常的。
 * 但**设了就不能设在过去**：那样建出来的投票一诞生就结束了，
 * 而界面上只会显示「已结束」，人会以为是自己点错了。
 */
export function checkClosesAt(closesAt: number | null | undefined, now: number): PollDraftCheck | null {
  if (closesAt == null) return null;
  if (!Number.isFinite(closesAt)) return { ok: false, error: "截止时间不对" };
  if (closesAt <= now) return { ok: false, error: "截止时间在过去 —— 那样投票一建出来就结束了" };
  return null;
}

/** 建投票的时候界面上默认给几个空行 —— 两个是最少可用的数量 */
export const DEFAULT_OPTION_SLOTS = 2;
