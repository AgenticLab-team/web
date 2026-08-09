import { CardListSkeleton, HeaderSkeleton, SearchBarSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <SearchBarSkeleton />
      <CardListSkeleton cards={6} />
    </>
  );
}
