/**
 * 「按天回看」的纯规则：排序、分页、锚点。
 *
 * 不碰数据库、不碰 React —— 因为**同一套算法有两个使用者**：
 * 一个是页面（按 offset 切出这一页），另一个是链接生成方
 * （通知里要算出「那条消息在第几页」）。两边各写一份的话，
 * 差一个 ±1 的表现是：点开通知，落到了那一页，而那条消息在上一页。
 * 这种错法看起来像「定位不准」，其实是两套算法在打架。
 *
 * 一天最多的时候有 4500 条消息（真实数据）。这就是为什么
 * 这一页非分页不可，也是为什么「跳到那一天」根本不等于「找到那条」。
 */

/** 每页条数。100 条已经要滑十几屏了，再多分页就失去意义 */
export const ARCHIVE_PAGE_SIZE = 100;

export type MessageOrder = "asc" | "desc";

/**
 * 默认最新在前。
 *
 * 原来是**正序且不滚到底部** —— 打开今天，看到的是今天最早的
 * 那几条，想看刚刚聊了什么得一路滑到最底下（今天可能有几千条）。
 * 聊天软件的「正序 + 落在底部」是一套完整的做法，
 * 这里只抄了前半句，于是变成了最难用的那一种。
 *
 * 补法有两条：落在最后一页、或者倒过来。选倒序是因为
 * 这一页是**回看**不是聊天：人来这里是「刚才/昨天说了什么」，
 * 从最新往回读就是他脑子里的顺序。
 * 想按对话顺序读的（整理一段讨论）一键切回来，见 flipOrder。
 */
export const DEFAULT_ORDER: MessageOrder = "desc";

/** URL 上的 order 参数。认不出来的一律回默认值，不报错 */
export function resolveOrder(raw: unknown): MessageOrder {
  // searchParams 同名参数出现两次会变成数组 —— 取第一个
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "asc" || value === "desc" ? value : DEFAULT_ORDER;
}

export function flipOrder(order: MessageOrder): MessageOrder {
  return order === "asc" ? "desc" : "asc";
}

/** 下标（从 0 数）落在第几页（从 1 数） */
export function pageOfIndex(index: number, perPage: number = ARCHIVE_PAGE_SIZE): number {
  const per = Math.max(1, Math.floor(perPage) || 1);
  const safe = Math.max(0, Math.floor(index) || 0);
  return Math.floor(safe / per) + 1;
}

/**
 * 正序下标 → 当前显示顺序下的下标。
 *
 * 数据库里只有一种自然顺序（按时间正序），而页面可能倒着显示。
 * 倒序时第 0 条是最后一条 —— 这个换算错了的话，
 * 「倒序看的时候定位就跳到对称的另一头」，而正序看着一切正常。
 */
export function displayIndex(
  indexAsc: number,
  total: number,
  order: MessageOrder,
): number {
  if (order === "asc") return indexAsc;
  return Math.max(0, total - 1 - indexAsc);
}

/** 某条消息在当前排序下落在第几页 */
export function pageOfMessage(input: {
  /** 这条消息在当天（按时间正序）里的下标，从 0 数 */
  indexAsc: number;
  /** 当天可显示的总条数 */
  total: number;
  order: MessageOrder;
  perPage?: number;
}): number {
  return pageOfIndex(
    displayIndex(input.indexAsc, input.total, input.order),
    input.perPage ?? ARCHIVE_PAGE_SIZE,
  );
}

/**
 * 锚点的 DOM id。
 *
 * 加前缀是因为消息 id 是上游给的纯数字串（`5811344628303360702`），
 * 而以数字开头的 id 在 CSS 选择器里不合法 —— `#5811…` 选不中，
 * 浏览器的 `:target` 也不会认。
 */
export function messageAnchor(messageId: string): string {
  return `msg-${messageId}`;
}

/**
 * URL 上的 m 参数（要定位的消息 id）。
 *
 * 这是敌对输入，而且它会被直接写进 DOM id 和 URL 片段里，
 * 所以先卡形状再用。卡不住就当没传 —— 不报错，退回普通的按天回看。
 */
export function parseMessageId(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[A-Za-z0-9_.:@-]{1,128}$/.test(id) ? id : null;
}

/**
 * 「直达某一条消息」的永久链接。
 *
 * 只带 id 就够了 —— 群、日期、页码全部由服务端按 id 算出来
 * （见 lib/messages/locate.ts）。这样这个链接本身可以被收藏、
 * 被分享、被刷新，而不会因为「那天的消息变多了、它挪到第 3 页了」而失效。
 *
 * `#` 后面那段是给浏览器的：不用一行 JS，原生就会滚到那一条。
 * 高亮则由服务端按 `m` 参数直接渲染成 class —— 不靠 `:target`，
 * 因为客户端路由是 pushState，`:target` 在部分浏览器上不会跟着更新。
 *
 * fallback 里的 group/date 是给「这条消息已经被存储裁剪掉了」准备的：
 * 那时按 id 定位不到，至少还能落到那一天。
 */
export function messageLink(
  messageId: string,
  fallback?: { convId?: string; date?: string },
  basePath = "/archive",
): string {
  const qs = new URLSearchParams();
  if (fallback?.convId) qs.set("group", fallback.convId);
  if (fallback?.date) qs.set("date", fallback.date);
  qs.set("m", messageId);
  return `${basePath}?${qs.toString()}#${messageAnchor(messageId)}`;
}
