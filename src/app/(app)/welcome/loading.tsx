import { HeaderSkeleton, ListSkeleton, StatsSkeleton } from "@/components/ui/Skeleton";

/**
 * 补课页的骨架。
 *
 * 这一页要对**每一个可见的群**各跑一遍聚合（节奏、常驻、最热闹的
 * 几天、资源），在群多的人那里比别处慢 —— 而它恰恰是新人打开的
 * 第一页。没有骨架的话，第一印象就是一段空白。
 *
 * 骨架的形状照着真实版式排：标题、三个数字、一列人。
 * 排得不像的话，内容一到位整页会跳一下，比没有骨架更晃眼。
 */
export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <StatsSkeleton />
      <ListSkeleton rows={5} />
    </>
  );
}
