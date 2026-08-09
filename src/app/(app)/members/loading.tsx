import { CardListSkeleton, HeaderSkeleton, PillRowSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton withAction />
      <PillRowSkeleton count={5} />
      <CardListSkeleton cards={6} />
    </>
  );
}
