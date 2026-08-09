/**
 * 名册同步的安全判定。纯函数，不碰数据库也不碰网络。
 *
 * ─────────────────────────────────────────
 * 「从上游名册里消失」是一个很危险的推断
 * ─────────────────────────────────────────
 *
 * 成员同步的逻辑是：拉一次上游名册，**本地有而上游没有的人视为退群**。
 * 这个推断在上游正常时是对的，而在上游不正常时是灾难性的：
 *
 * · 上游返回空数组（隧道刚通、接口抽风、鉴权过期）→ **整个群的人全部被标成退群**
 * · 上游分页坏了、只回了第一页 → 后面的人全部被标成退群
 * · 群人数超过请求的 limit → 尾巴上那些人**每次同步都被标成退群**
 *
 * 而退群的后果是立刻的：`visibleGroupsFor` 要求 `left_at IS NULL`，
 * 所以这个群的聊天记录对**所有成员**同时消失。
 * 症状是「网站坏了」，而没有任何地方会告诉你是名册同步干的。
 *
 * 这个站今天刚经历过隧道反复断开。**这不是假想。**
 *
 * ─────────────────────────────────────────
 * 所以：缺席只在证据充分时才算数
 * ─────────────────────────────────────────
 *
 * 这一条和积分重算那边的「改动面太大时先拦一下」是同一个道理 ——
 * 一次操作要动一半以上的人时，更可能的解释是**数据本身出了问题**，
 * 而不是真的有一半人同时做了同一件事。
 *
 * 拦下来的只是「缺席 = 退群」这一个推断。**名册里出现的人照常更新**：
 * 加入、改名、以及上游明确标了 `left` 的那些，都不受影响 ——
 * 那些是上游**说出来**的事实，不是我们推断出来的。
 */

export interface RosterCheck {
  /** 上游这次返回了多少条 */
  fetched: number;
  /** 请求时给的 limit —— 返回数等于它，说明多半被截断了 */
  limit: number;
  /** 本地记录里当前还在群里的人数 */
  knownActive: number;
  /** 这次会被判定为「消失了」的人数 */
  missing: number;
}

export type RosterVerdict =
  | { trust: true }
  | { trust: false; reason: "empty" | "truncated" | "too_many_missing"; message: string };

/**
 * 缺席比例超过这个数就不认。
 *
 * 0.3 是估出来的，不是拍的：一个群一次同步间隔（2 分钟）里真的走掉
 * 三成人，只可能是群被解散或者被批量清理 —— 那两种情况都值得
 * 一个人来看一眼，而不是让系统自己悄悄执行。
 *
 * 定得再松（比如 0.8）就挡不住分页只回了第一页这种最常见的坏法；
 * 定得再紧会让小群的正常波动频繁触发（10 个人的群走 3 个就是 30%），
 * 所以下面还有一条「人少时不按比例算」。
 */
export const MAX_MISSING_RATIO = 0.3;

/**
 * 少于这个人数的群不按比例判。
 *
 * 5 个人的群走 2 个就是 40% —— 那是完全正常的事。
 * 比例这种判据在小样本上没有意义，硬套只会让小群永远同步不了名册。
 */
export const SMALL_GROUP_SIZE = 20;

export function checkRoster(input: RosterCheck): RosterVerdict {
  /*
   * 上游一个人都没返回，而本地知道这里有人 —— 这一条最要紧。
   *
   * 不拦的话，一次空响应就会让整个群的聊天记录对所有成员消失。
   * 而空响应是最常见的坏法：隧道刚通、鉴权过期、接口 200 但返回 `[]`。
   */
  if (input.fetched === 0 && input.knownActive > 0) {
    return {
      trust: false,
      reason: "empty",
      message: `上游返回了空名册，而本地记着 ${input.knownActive} 人 —— 这次不动退群判定`,
    };
  }

  /*
   * 返回数刚好等于 limit：几乎可以肯定被截断了。
   *
   * 这种情况下「没出现的人」里混着「在下一页的人」，
   * 而我们分不出来 —— 分不出来时就不该动。
   */
  if (input.limit > 0 && input.fetched >= input.limit) {
    return {
      trust: false,
      reason: "truncated",
      message: `上游返回了 ${input.fetched} 条，正好顶到上限 —— 名册可能没取全，这次不动退群判定`,
    };
  }

  if (input.missing === 0) return { trust: true };

  // 小群不按比例算 —— 5 个人走 2 个是 40%，那完全正常
  if (input.knownActive < SMALL_GROUP_SIZE) return { trust: true };

  const ratio = input.missing / input.knownActive;
  if (ratio > MAX_MISSING_RATIO) {
    return {
      trust: false,
      reason: "too_many_missing",
      message:
        `这次有 ${input.missing}/${input.knownActive} 人从名册里消失（${Math.round(ratio * 100)}%）——` +
        `比起「他们真的同时退群了」，更可能是这次名册没取全。先不动，等人看一眼`,
    };
  }

  return { trust: true };
}

/**
 * 退群之后该收回什么。
 *
 * ─────────────────────────────────────────
 * 群消息的可见权不用收 —— 它本来就是算出来的
 * ─────────────────────────────────────────
 *
 * `visibleGroupsFor` 要求 `left_at IS NULL`，所以标上退群的那一刻
 * 这个群的内容就看不见了，不需要任何额外动作。
 * （之前有说法认为「退群自动降级从未发生」，那一半是不准的。）
 *
 * 真正需要主动收回的是**挂在这个群上的身份组** ——
 * 比如某个群的管理权限。它存在 `user_roles` 里，
 * 和名册没有任何关联，不收就一直挂着。
 *
 * ─────────────────────────────────────────
 * 不自动封号
 * ─────────────────────────────────────────
 *
 * 一个退光了所有群的人，账号仍然能登录。这是刻意的：
 *
 * · 一次名册同步出错就能把一群人挡在门外，而**把真的成员关在门外的
 *   代价，比让一个已经退群的人多登录几天大得多**
 * · 这个项目已经吃过一次同类的亏：早期把接口异常 catch 成
 *   「你不是社群成员」，结果所有人都被挡住了
 *
 * 所以只把名单报给管理员，让人来决定 —— 见 `leftEverything()`。
 */
export type Revocation = { scopeType: "group"; scopeId: string; reason: string };

export function revocationsFor(convId: string): Revocation[] {
  return [{ scopeType: "group", scopeId: convId, reason: "已退出该群" }];
}
