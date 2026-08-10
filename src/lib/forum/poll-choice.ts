/**
 * 投票时，把提交上来的选项收拾成「真能投的那几个」。纯判定。
 *
 * ─────────────────────────────────────────
 * 选项 id 是客户端送上来的
 * ─────────────────────────────────────────
 *
 * 所以必须逐个对回**这个投票自己的**选项表。不对的话，
 * 一次请求就能给**别的投票**的选项加票：
 * `poll_votes` 里会出现 pollId 是这一个、optionId 是那一个的行，
 * 而那个投票的票数被一群从没看过它的人抬上去。
 *
 * 那种脏数据没有任何地方会报错 —— 票数就是比实际多几票，
 * 而没有人能说清多的是哪几票。
 *
 * ─────────────────────────────────────────
 * 顺带收拾另外两件
 * ─────────────────────────────────────────
 *
 * · **去重**：同一个选项提交两次只能算一票
 * · **单选**：多选投票才允许一次选多个
 */

export interface ChoiceResult {
  ok: boolean;
  /** 真正要落库的那几个选项 */
  chosen: string[];
  /** 拒绝时给人看的话；通过时为 null */
  error: string | null;
}

export function validateChoices(input: {
  submitted: readonly string[];
  /** 这个投票自己的选项 id */
  validIds: readonly string[];
  multi: boolean;
}): ChoiceResult {
  const valid = new Set(input.validIds);
  /*
   * 先去重再过滤 —— 顺序反过来也对，但先去重能少比几次，
   * 而且「同一个选项提交十次」这种请求是真会出现的。
   */
  const chosen = [...new Set(input.submitted)].filter((id) => valid.has(id));

  if (chosen.length === 0) {
    /*
     * 提交了东西但一个都不合法，和什么都没提交，给同一句话。
     *
     * 分开说的话（「这些选项不属于这个投票」）等于告诉对方
     * 「你猜的那个 id 存在，只是不在这儿」—— 而选项 id 是 ULID，
     * 本来就不该让人从错误信息里试出来。
     */
    return { ok: false, chosen: [], error: "请选择一个选项" };
  }

  if (!input.multi && chosen.length > 1) {
    return { ok: false, chosen: [], error: "这是单选投票" };
  }

  return { ok: true, chosen, error: null };
}
