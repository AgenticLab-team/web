/**
 * 站内公告的展示规则。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 发出去的公告没有任何人看得到
 * ─────────────────────────────────────────
 *
 * 后台可以写一条站内公告、提交、复核、发布，界面会回一句
 * 「站内公告已发布。」，库里那行的 `sent_count` 记成 1。
 *
 * 而 `activeAnnouncements()` 这个查询**零调用点** ——
 * 全站没有任何地方读它。`display`（banner / modal / inbox）
 * 三个值写进去也没人读，`target_role_id` 同样。
 *
 * 也就是说：这条链路从头到尾是通的，只差最后一步 ——
 * 而缺了最后一步的结果不是「功能不全」，是**管理员以为自己
 * 通知过大家了**。那比没有这个功能糟得多：真出事要广播的时候，
 * 他会以为消息已经送到了。
 *
 * ─────────────────────────────────────────
 * 只给登录用户看
 * ─────────────────────────────────────────
 *
 * 未登录访客没有身份，也就没有「已读」可言 —— 给他们看的话
 * 那条横幅每次刷新都回来，而他们没有任何办法关掉它。
 * 一个关不掉的横幅，两次之后人就不再读它了，
 * 于是真正要紧的那条也一起被无视。
 *
 * 站点维护之类要给所有人看的东西，走的是 502 页那条路，不是这里。
 */

export type Display = "banner" | "modal" | "inbox";

/** 后台那三个选项，连同「它意味着什么」 */
export const DISPLAYS: { key: Display; label: string; detail: string }[] = [
  {
    key: "banner",
    label: "顶部横幅",
    detail: "每一页顶上一条，直到他自己关掉。适合「今晚 10 点维护」这类要人看见但不必打断的事",
  },
  {
    key: "modal",
    label: "打断一次",
    detail: "盖住页面，必须点掉。**只有真的需要立刻知道的事才配用它** —— 用滥了下次就没人认真看",
  },
  {
    key: "inbox",
    label: "只进通知",
    detail: "不打扰，安静地躺在通知列表里。适合「本月精选出炉」这类看不看都行的事",
  },
];

export function displayLabel(display: string | null): string {
  return DISPLAYS.find((d) => d.key === display)?.label ?? "未指定";
}

/**
 * 这条公告轮不轮得到这个人看。
 *
 * ─────────────────────────────────────────
 * 两个维度：身份组、群
 * ─────────────────────────────────────────
 *
 * `targetRoleId` 为空 = 不限身份组。指定了就只给持有那个身份组的人 ——
 * 「版主请注意」这种话发给所有人，只会让所有人下次都跳过公告。
 *
 * `targetConvIds` 为空 = 不限群。指定了就只给这些群里的人 ——
 * 「A 群周六线下」发给全站，对另外十一个群的人来说是纯噪音，
 * 而且**它顺带告诉了他们 A 群的存在和活动安排**，
 * 而群的事情属于群里的人。
 *
 * ─────────────────────────────────────────
 * 两个都填 = 两个都要满足
 * ─────────────────────────────────────────
 *
 * 取交集而不是并集。并集听起来「覆盖更广」，但它的失败方向是
 * **发多了** —— 而这两个维度存在的理由恰恰是发少一点、发准一点。
 * 一个用来收窄范围的东西，默认行为不该是放宽。
 *
 * 而且交集可以口头讲清楚：「A 群里的版主」。并集要说成
 * 「A 群里的所有人，加上全站所有版主」—— 没有人是这么想事情的。
 */
export function targeted(
  announcement: { targetRoleId: string | null; targetConvIds: string[] | null },
  viewerRoleIds: Iterable<string>,
  viewerConvIds: Iterable<string> = [],
): boolean {
  if (announcement.targetRoleId) {
    let hit = false;
    for (const id of viewerRoleIds) if (id === announcement.targetRoleId) hit = true;
    if (!hit) return false;
  }

  const convs = announcement.targetConvIds;
  if (convs && convs.length > 0) {
    const wanted = new Set(convs);
    let hit = false;
    for (const id of viewerConvIds) if (wanted.has(id)) hit = true;
    if (!hit) return false;
  }

  return true;
}

/** 还在生效期内吗。`expiresAt` 为空 = 不过期 */
export function isLive(announcement: { expiresAt: number | null }, now: number): boolean {
  return announcement.expiresAt === null || announcement.expiresAt > now;
}

/**
 * 一次最多同时摆几条。
 *
 * 三条横幅叠在页面顶上，等于把整个首屏让给了公告 ——
 * 而人只会把它们一起关掉。超出的那些仍然在公告列表里躺着，
 * 关掉前面的之后自然轮到它们。
 */
export const MAX_CONCURRENT_BANNERS = 2;

/**
 * 挑出该现在摆出来的。
 *
 * **打断式的排在最前面而且只留一条** —— 两个模态框叠着弹是
 * 任何界面里最糟糕的一种体验，而它恰恰只在「同时发了两条急事」
 * 那种最忙乱的时刻才会出现。
 */
export function pickVisible<T extends { display: string | null; createdAt: number }>(
  candidates: T[],
): { modal: T | null; banners: T[] } {
  const sorted = [...candidates].sort((a, b) => b.createdAt - a.createdAt);
  const modal = sorted.find((a) => a.display === "modal") ?? null;
  const banners = sorted
    .filter((a) => a.display !== "modal" && a.display !== "inbox")
    .slice(0, MAX_CONCURRENT_BANNERS);
  return { modal, banners };
}

/**
 * 「发给谁」那句话。
 *
 * 后台要显示它 —— 一条定向公告发出去之后，如果界面上只写「已发布」，
 * 管理员没有任何办法确认自己有没有选错身份组，
 * 而选错的表现是「大家都说没收到」。
 */
export function describeAudience(
  roleName: string | null,
  reached: number,
  groupNames: string[] = [],
): string {
  /*
   * 两个条件同时存在时要读得像一句话：「A 群里的『版主』」。
   * 拼成「发给『版主』和 A 群」会被理解成并集 —— 而实际是交集。
   */
  const inGroups =
    groupNames.length === 0 ? ""
    : groupNames.length <= 2 ? `${groupNames.join("、")}里的`
    : `${groupNames.slice(0, 2).join("、")}等 ${groupNames.length} 个群里的`;

  const who = roleName ? `「${roleName}」这个身份组` : inGroups ? "所有人" : "全体登录用户";
  return `发给${inGroups}${who}，${reached} 个人`;
}
