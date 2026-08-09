import { HeaderSkeleton, Skeleton } from "@/components/ui/Skeleton";

/** 发帖是表单不是列表 —— 不用上层的列表骨架，画标题框 + 编辑区 */
export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <div role="status" aria-busy="true" aria-label="加载中">
        <Skeleton className="mb-3 h-[2.875rem] rounded-[var(--radius-card)]" />
        <Skeleton className="h-64 rounded-[var(--radius-card)]" />
      </div>
    </>
  );
}
