import { CardListSkeleton, HeaderSkeleton } from "@/components/ui/Skeleton";

/**
 * 每个群都要跑一遍聚合（30 天分布、14 天趋势、基线对比），
 * 12 个群叠起来不是瞬间返回的 —— 没有骨架的话，
 * 点进后台这一页会先白一下。
 */
export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <CardListSkeleton cards={4} avatar={false} />
    </>
  );
}
