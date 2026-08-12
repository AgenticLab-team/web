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
      className={`block animate-pulse rounded-[var(--radius-chip)] bg-[var(--fill)] ${className}`}
      style={style}
      aria-hidden
    />
  );
}

/** 分组列表的骨架。行高与真实的 inset-row 对齐 */
export function ListSkeleton({ rows = 6, avatar = true }: { rows?: number; avatar?: boolean }) {
  return (
    <div className="inset-group" role="status" aria-busy="true" aria-label="加载中">
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

/**
 * 横滑筛选 Pill 行的骨架。尺寸对齐 primitives 里的 Pill（t-footnote + px-3 py-1.5）。
 * 纯装饰：加载状态由同页的列表骨架念出来，这里再念一遍只会吵。
 */
export function PillRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="-mx-4 mb-3 flex gap-1.5 overflow-hidden px-4 pb-1 sm:-mx-6 sm:px-6" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton
          key={i}
          className="h-[1.875rem] shrink-0 rounded-[var(--radius-pill)]"
          style={{ width: `${3.5 + (i % 3)}rem` }}
        />
      ))}
    </div>
  );
}

/** 搜索框骨架。对齐真实搜索框：radius-card 的面板 + py-3 里一行 t-body */
export function SearchBarSkeleton() {
  return (
    <div
      className="mb-4 flex items-center rounded-[var(--radius-card)] bg-[var(--surface)] px-4 py-3 hairline"
      aria-hidden
    >
      <Skeleton className="h-[1.375rem] w-1/2" />
    </div>
  );
}

/**
 * 卡片流的骨架（成员目录、资源库这类 space-y-2 的 surface 卡）。
 * 用真实的卡片容器装灰块，而不是整卡涂灰 ——
 * 卡片边界与底色先到位，内容替换时只有文字区在变，跳动感小得多。
 */
export function CardListSkeleton({ cards = 5, avatar = true }: { cards?: number; avatar?: boolean }) {
  return (
    <div className="space-y-2" role="status" aria-busy="true" aria-label="加载中">
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className="rounded-[var(--radius-card)] bg-[var(--surface)] p-3.5 hairline">
          <div className="flex gap-3">
            {avatar && <Skeleton className="h-10 w-10 shrink-0 rounded-full" />}
            <span className="min-w-0 flex-1 space-y-2">
              <Skeleton className={`h-[1.0625rem] ${i % 2 === 0 ? "w-2/5" : "w-1/3"}`} />
              <Skeleton className={`h-[0.8125rem] ${i % 3 === 0 ? "w-4/5" : "w-3/5"}`} />
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 聊天记录行的骨架。对齐按天回看的行：20px 头像 + pl-3 py-1，**一行一条**。
 *
 * 回看那一行后来从三行压成一行（见 components/messages/ArchiveMessage.tsx），
 * 骨架必须跟着压 —— 否则骨架有 12 行 × 62px，真内容只有 12 行 × 30px，
 * 数据一到整页往上跳一大截。骨架的意义就是**把位置先占准**，
 * 占错了比不占更难受。
 */
export function ChatListSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="inset-group" role="status" aria-busy="true" aria-label="加载中">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="inset-row flex items-start gap-2 py-1 pl-3">
          <Skeleton className="mt-0.5 h-5 w-5 shrink-0 rounded-full" />
          <span className="min-w-0 flex-1 py-0.5">
            <Skeleton className={`h-[0.9375rem] ${i % 4 === 0 ? "w-11/12" : i % 4 === 1 ? "w-1/3" : i % 4 === 2 ? "w-2/3" : "w-1/2"}`} />
          </span>
          {/* 右侧那两条窄栏也要占住，不然内容一到时正文宽度会变 */}
          <Skeleton className="mt-1 h-3 w-8 shrink-0" />
          <span className="w-9 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export function ArticleSkeleton() {
  return (
    <div className="pt-6" role="status" aria-busy="true" aria-label="加载中">
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
