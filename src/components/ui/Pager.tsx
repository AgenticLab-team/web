import Link from "next/link";

/**
 * 上一页 / 下一页。
 *
 * ─────────────────────────────────────────
 * 服务端组件：翻页是导航，不是交互
 * ─────────────────────────────────────────
 *
 * 做成 `useRouter().push` 的客户端按钮，就得为一件浏览器本来就会做的事
 * 往首屏塞一份 JS，而且会失去中键新开、右键复制链接、
 * 以及**加载中长按能取消**这些行为。
 *
 * 两个 `<a>` 就够了。
 */
export function Pager({
  page,
  pages,
  total,
  /** 当前的查询参数（过滤条件），翻页时要原样带上 */
  params,
  unit = "条",
}: {
  page: number;
  pages: number;
  total: number;
  params: Record<string, string | undefined>;
  unit?: string;
}) {
  if (pages <= 1) {
    /*
     * 只有一页时不显示翻页器，但**总数还是要说**。
     *
     * 「一共 7 条」和「这是前 7 条，后面还有」在屏幕上长得一样，
     * 而它们是完全不同的两件事 —— 尤其在一个用来审计的列表里。
     */
    return (
      <p className="t-caption2 mt-2 px-1 text-[var(--ink-quaternary)]">
        一共 {total} {unit}
      </p>
    );
  }

  const href = (target: number) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) next.set(key, value);
    }
    if (target > 1) next.set("page", String(target));
    else next.delete("page");
    const qs = next.toString();
    return qs ? `?${qs}` : "?";
  };

  const box =
    "t-footnote inline-flex min-h-9 items-center rounded-[var(--radius-control)] px-3 transition active:opacity-60";

  return (
    <div className="mt-2 flex items-center justify-between gap-2 px-1">
      {page > 1 ? (
        <Link href={href(page - 1)} className={box} style={{ background: "var(--fill)" }}>
          上一页
        </Link>
      ) : (
        /* 占位，让「第 x / y 页」始终居中 —— 不占位的话它会左右跳 */
        <span className={box} style={{ opacity: 0.35 }} aria-hidden>
          上一页
        </span>
      )}

      <span className="tabular t-caption2 text-[var(--ink-quaternary)]">
        第 {page} / {pages} 页 · 共 {total} {unit}
      </span>

      {page < pages ? (
        <Link href={href(page + 1)} className={box} style={{ background: "var(--fill)" }}>
          下一页
        </Link>
      ) : (
        <span className={box} style={{ opacity: 0.35 }} aria-hidden>
          下一页
        </span>
      )}
    </div>
  );
}
