import { HeaderSkeleton, ListSkeleton, Skeleton, StatsSkeleton } from "@/components/ui/Skeleton";

/**
 * 也兜住 /me 下的子页（积分、资料、安全…）——
 * 它们都是「头 + 列表/表单」的形状，这个骨架足够贴。
 */
export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      {/* 个人卡：60px 头像 + 名字与角色两行，对齐真实的 p-5 inset-group */}
      <div className="inset-group mb-7 flex items-center gap-4 p-5" aria-hidden>
        <Skeleton className="h-[3.75rem] w-[3.75rem] shrink-0 rounded-full" />
        <span className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-4 w-24" />
        </span>
      </div>
      <StatsSkeleton />
      <ListSkeleton rows={4} avatar={false} />
    </>
  );
}
