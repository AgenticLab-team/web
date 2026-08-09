import { ChatListSkeleton, HeaderSkeleton, PillRowSkeleton, Skeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      {/* 两排药丸：选群、选排序（最新在前 / 按对话顺序） */}
      <PillRowSkeleton count={3} />
      <PillRowSkeleton count={2} />
      {/* 日期导航条：真实高度是 py-2 里一个 p-2 图标钮 ≈ 3.25rem */}
      <Skeleton className="mb-4 h-[3.25rem] rounded-[var(--radius-control)]" />
      {/* 行压成一行之后单行变矮了，条数跟着加，占住的高度才和真内容对得上 */}
      <ChatListSkeleton rows={24} />
    </>
  );
}
