import { CardListSkeleton, HeaderSkeleton, PillRowSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      {/* 两排药丸：排序一排、语言一排。骨架的形状要对得上真页面，
          差一排的话内容进来时整页往下跳一次 */}
      <PillRowSkeleton count={3} />
      <PillRowSkeleton count={5} />
      <CardListSkeleton cards={8} />
    </>
  );
}
