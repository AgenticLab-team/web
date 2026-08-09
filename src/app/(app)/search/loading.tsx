import { HeaderSkeleton, PillRowSkeleton, SearchBarSkeleton } from "@/components/ui/Skeleton";

/**
 * 只画确定会出现的部分：搜索框和筛选行。
 * 结果区不画假列表 —— 落地时多半没带 q，骨架行解析成空态
 * 会像内容凭空消失，比空白更让人困惑。
 */
export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <SearchBarSkeleton />
      <PillRowSkeleton count={4} />
      <PillRowSkeleton count={2} />
    </>
  );
}
