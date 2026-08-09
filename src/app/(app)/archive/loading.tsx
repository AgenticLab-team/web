import { ChatListSkeleton, HeaderSkeleton, PillRowSkeleton, Skeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <PillRowSkeleton count={3} />
      {/* 日期导航条：真实高度是 py-2 里一个 p-2 图标钮 ≈ 3.25rem */}
      <Skeleton className="mb-4 h-[3.25rem] rounded-[var(--radius-control)]" />
      <ChatListSkeleton rows={12} />
    </>
  );
}
