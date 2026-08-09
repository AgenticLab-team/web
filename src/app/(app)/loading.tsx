import { HeaderSkeleton, ListSkeleton, Skeleton, StatsSkeleton } from "@/components/ui/Skeleton";

/**
 * 这一层的骨架只服务首页 —— 其余路由各有自己的 loading.tsx。
 * 所以形状照着首页排：桌面两栏（主栏 + 20rem 侧栏），手机单栏，
 * 和真实页面同一套网格，加载完成时栏位不动。
 */
export default function Loading() {
  return (
    <>
      <HeaderSkeleton withAction />
      <div className="grid gap-x-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          {/* 摘要卡的位置。高度取常见两行摘要的卡片高 */}
          <Skeleton className="mb-7 h-28 rounded-[var(--radius-card)]" />
          <StatsSkeleton />
          <ListSkeleton rows={8} />
        </div>
        <aside className="min-w-0" aria-hidden>
          <div className="grid grid-cols-3 gap-2.5 lg:grid-cols-1">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[5.25rem] rounded-[var(--radius-card)]" />
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}
