import { HeaderSkeleton, ListSkeleton, Skeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      {/* 个人卡：56px 头像 + 名字两行，对齐真实的 p-4 卡片 */}
      <div className="mb-4 flex items-center gap-4 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline" aria-hidden>
        <Skeleton className="h-14 w-14 shrink-0 rounded-full" />
        <span className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3.5 w-48" />
        </span>
      </div>
      <div className="mb-4 grid grid-cols-3 gap-2" aria-hidden>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[5.25rem] rounded-[var(--radius-card)]" />
        ))}
      </div>
      <ListSkeleton rows={5} avatar={false} />
    </>
  );
}
