import { HeaderSkeleton, ListSkeleton, Skeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      {/* 订阅管理卡的位置 */}
      <Skeleton className="mb-7 h-32 rounded-[var(--radius-card)]" />
      <ListSkeleton rows={5} avatar={false} />
    </>
  );
}
