import { HeaderSkeleton, SearchBarSkeleton } from "@/components/ui/Skeleton";

/** 结果区不画假列表：多半是不带 q 落地，骨架行解析成空态会像内容消失 */
export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <SearchBarSkeleton />
    </>
  );
}
