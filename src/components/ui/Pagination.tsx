import Link from "next/link";

import { pageHref, pageWindow, type PageSlice } from "@/lib/pagination";

/**
 * 后台列表共用的分页控件。纯服务端渲染 —— 翻页就是导航，
 * 不值得为它往首屏塞任何客户端代码。
 *
 * 总数必须显示（「共 1803 个账号」）：只有上一页/下一页的分页，
 * 人没法判断自己在哪、还剩多少 —— 翻到第五页时不知道后面是一页还是一百页，
 * 唯一的办法是一直翻到头。
 */
export function Pagination({
  slice,
  total,
  noun,
  basePath,
  params = {},
}: {
  slice: PageSlice;
  total: number;
  /** 计数单位，如「个账号」「条记录」—— 让总数读起来是句人话 */
  noun: string;
  basePath: string;
  /** 当前生效的筛选参数，翻页时原样保留（page 除外） */
  params?: Record<string, string | undefined>;
}) {
  // 只有一页时整个控件不出现 —— 总数由各页的标题负责，别在页尾再念一遍
  if (slice.totalPages <= 1) return null;

  const href = (page: number) => pageHref(basePath, params, page);

  const linkBase =
    "t-footnote flex h-10 min-w-10 items-center justify-center rounded-[var(--radius-control)] px-2 font-medium transition-colors";

  return (
    <nav aria-label="分页" className="mt-5 flex flex-col items-center gap-2">
      <p className="tabular t-caption text-[var(--ink-tertiary)]">
        共 {total.toLocaleString("zh-CN")} {noun} · 第 {slice.page} / {slice.totalPages} 页
      </p>

      <div className="flex flex-wrap items-center justify-center gap-1">
        {/* 不可用时保留占位而不是消失 —— 按钮位置一跳，手指就点到别的页码上了 */}
        {slice.hasPrev ? (
          <Link href={href(slice.page - 1)} className={`${linkBase} bg-[var(--fill)] text-[var(--ink-secondary)] hover:bg-[var(--fill-strong)]`}>
            上一页
          </Link>
        ) : (
          <span aria-disabled="true" className={`${linkBase} text-[var(--ink-quaternary)]`}>
            上一页
          </span>
        )}

        {pageWindow(slice.page, slice.totalPages).map((item, i) =>
          item === "gap" ? (
            <span key={`gap-${i}`} aria-hidden className="px-1 text-[var(--ink-quaternary)]">
              …
            </span>
          ) : (
            <Link
              key={item}
              href={href(item)}
              aria-label={`第 ${item} 页`}
              aria-current={item === slice.page ? "page" : undefined}
              className={`${linkBase} tabular ${
                item === slice.page
                  ? "bg-[var(--ink)] text-[var(--canvas)]"
                  : "bg-[var(--fill)] text-[var(--ink-secondary)] hover:bg-[var(--fill-strong)]"
              }`}
            >
              {item}
            </Link>
          ),
        )}

        {slice.hasNext ? (
          <Link href={href(slice.page + 1)} className={`${linkBase} bg-[var(--fill)] text-[var(--ink-secondary)] hover:bg-[var(--fill-strong)]`}>
            下一页
          </Link>
        ) : (
          <span aria-disabled="true" className={`${linkBase} text-[var(--ink-quaternary)]`}>
            下一页
          </span>
        )}
      </div>
    </nav>
  );
}

/**
 * 「列表被截断了」的统一提示。
 *
 * 静默截断比没有列表更糟：limit 20 的列表长得和完整列表一模一样，
 * 管理员会以为「就这些」—— 于是第 21 条之后的东西等于不存在。
 * 凡是保留 limit 而不做完整分页的地方，至少要把这句话摆出来。
 */
export function TruncationNote({
  shown,
  total,
  noun = "条",
}: {
  shown: number;
  total: number;
  noun?: string;
}) {
  if (total <= shown) return null;
  return (
    <p className="tabular t-caption mt-2 px-1 text-[var(--ink-tertiary)]" role="note">
      只列出了 {shown.toLocaleString("zh-CN")} {noun}，共 {total.toLocaleString("zh-CN")} {noun}。
    </p>
  );
}
