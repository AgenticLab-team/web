/**
 * 骨架屏。
 *
 * 比转圈让人感觉更快 —— 转圈只说明「在等」，骨架屏预告了
 * 「马上出现的是什么形状」，所以内容到位时不会有突兀感。
 * 更实际的好处是**避免布局跳动**：占位尺寸与真实内容一致，CLS 为 0。
 */

export function Skeleton({
  className = "",
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={`block animate-pulse rounded-[0.375rem] bg-[var(--fill)] ${className}`}
      style={style}
      aria-hidden
    />
  );
}

/** 分组列表的骨架。行高与真实的 inset-row 对齐 */
export function ListSkeleton({ rows = 6, avatar = true }: { rows?: number; avatar?: boolean }) {
  return (
    <div className="inset-group" role="status" aria-label="加载中">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="inset-row flex items-center gap-3 px-4 py-3.5">
          {avatar && <Skeleton className="h-[2.375rem] w-[2.375rem] shrink-0 rounded-full" />}
          <span className="min-w-0 flex-1 space-y-2">
            {/* 宽度错开，看起来像真实的长短不一的标题 */}
            <Skeleton className="h-[0.9375rem]" />
            <Skeleton className={`h-[0.8125rem] ${i % 3 === 0 ? "w-1/2" : i % 3 === 1 ? "w-3/4" : "w-2/3"}`} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function HeaderSkeleton({ withAction = false }: { withAction?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 pt-8 pb-6">
      <span className="min-w-0 flex-1 space-y-2.5">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-4 w-32" />
      </span>
      {withAction && <Skeleton className="h-9 w-20 shrink-0 rounded-[var(--radius-control)]" />}
    </div>
  );
}

export function StatsSkeleton() {
  return (
    <div className="mb-7 grid grid-cols-3 gap-2.5">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-[5.25rem] rounded-[var(--radius-card)]" />
      ))}
    </div>
  );
}

export function ArticleSkeleton() {
  return (
    <div className="pt-6" role="status" aria-label="加载中">
      <Skeleton className="mb-4 h-8 w-3/4" />
      <div className="mb-6 flex items-center gap-2.5">
        <Skeleton className="h-8 w-8 rounded-full" />
        <span className="space-y-1.5">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-32" />
        </span>
      </div>
      <div className="space-y-2.5">
        {[100, 92, 96, 60, 88, 74].map((w, i) => (
          <Skeleton key={i} className="h-4" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}
