/**
 * 分页的纯逻辑。不碰数据库，不碰 React。
 *
 * ─────────────────────────────────────────
 * 为什么值得单独一个文件
 * ─────────────────────────────────────────
 *
 * 后台曾经每个列表各写一套 limit —— 结果是十几个页面十几种行为：
 * 有的显示总数有的不显示，有的截断了有的没截断，而**每多一个变体，
 * 页面之间就多一分不一致的机会**。这里把「算总页数、夹页码、算 offset」
 * 收拢成一处，所有列表共用同一套边界行为。
 *
 * ─────────────────────────────────────────
 * 页码来自 URL，所以它是敌对输入
 * ─────────────────────────────────────────
 *
 * `?page=abc`、`?page=-1`、`?page=999` 都会有人打出来 ——
 * 手滑、收藏了旧链接、或者数据被删掉之后总页数变小了。
 * 这些必须落到一个**有内容的页**上，而不是报错或一片空白：
 * 一个显示空白的第 999 页和「数据全没了」在用户眼里是同一件事。
 */

export interface PageSlice {
  /** 夹回合法区间之后的页码，从 1 开始 */
  page: number;
  /** 至少为 1 —— 空列表也算「第 1 页，共 1 页」，否则页码没有落脚点 */
  totalPages: number;
  perPage: number;
  offset: number;
  hasPrev: boolean;
  hasNext: boolean;
}

/**
 * 把 URL 上的原始 page 值解析并夹进 [1, totalPages]。
 *
 * 越界往两头夹而不是回第一页：`?page=999` 多半是「数据变少了的旧链接」，
 * 落到最后一页比落到第一页更接近这个人原本想看的东西。
 * 解析不出来的（abc、负数、小数、空）才回第一页。
 */
export function paginate(rawPage: unknown, total: number, perPage: number): PageSlice {
  // perPage 是代码里写死的常量，但防御一下 0 和负数 —— 除数为 0 会算出 Infinity 页
  const per = Math.max(1, Math.floor(perPage) || 1);
  const safeTotal = Math.max(0, Math.floor(total) || 0);
  const totalPages = Math.max(1, Math.ceil(safeTotal / per));

  // searchParams 里同名参数出现两次会变成数组 —— 取第一个，别让 ?page=2&page=3 抛错
  const raw = Array.isArray(rawPage) ? rawPage[0] : rawPage;

  let page = 1;
  if (typeof raw === "number" && Number.isInteger(raw)) {
    page = raw;
  } else if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
    page = Number.parseInt(raw.trim(), 10);
  }

  page = Math.min(Math.max(1, page), totalPages);

  return {
    page,
    totalPages,
    perPage: per,
    offset: (page - 1) * per,
    hasPrev: page > 1,
    hasNext: page < totalPages,
  };
}

/** 省略号占位。用字符串字面量而不是 null，让消费端的分支写得出名字 */
export type PageItem = number | "gap";

/**
 * 要渲染哪些页码：始终有第一页、最后一页、当前页 ±1，中间用 gap 连接。
 *
 * 上限是 7 个元素（5 个数字 + 2 个 gap）—— 这个数是给手机定的：
 * 这个站一大半访问来自手机，页码一多就挤成一团，
 * 而挤在一起的可点目标比没有页码更糟，点谁全凭运气。
 */
export function pageWindow(page: number, totalPages: number): PageItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const current = Math.min(Math.max(1, page), totalPages);
  const around = [current - 1, current, current + 1].filter((n) => n > 1 && n < totalPages);

  const items: PageItem[] = [1];
  // gap 只在真的跳过了页码时出现 —— 「1 … 2」这种假省略会让人怀疑中间藏了东西
  if (around.length > 0 && around[0] > 2) items.push("gap");
  items.push(...around);
  if (around.length > 0 && around[around.length - 1] < totalPages - 1) items.push("gap");
  items.push(totalPages);
  return items;
}

/**
 * 生成某一页的链接，保留当前的筛选参数。
 *
 * 第一页不带 `page` 参数 —— 「/admin/users」和「/admin/users?page=1」
 * 是同一页，两个 URL 会让「当前页高亮」在其中一个上失灵，
 * 收藏和分享也会分裂成两份。
 */
export function pageHref(
  basePath: string,
  params: Record<string, string | undefined>,
  page: number,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "page") continue; // 调用方传进整包 searchParams 时，旧页码不能跟着走
    if (value) qs.set(key, value);
  }
  if (page > 1) qs.set("page", String(page));
  const s = qs.toString();
  return s ? `${basePath}?${s}` : basePath;
}
