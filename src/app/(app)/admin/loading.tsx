import { HeaderSkeleton, ListSkeleton } from "@/components/ui/Skeleton";

/**
 * 兜住全部后台页 —— 它们都是「标题 + 密集行列」的形状。
 * 这个边界还顺带把 24 个入口的预取截在后台外壳这一层：
 * 预取只拉到第一个 loading 边界为止，每条链接不再各自渲染整页。
 */
export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <ListSkeleton rows={9} avatar={false} />
    </>
  );
}
