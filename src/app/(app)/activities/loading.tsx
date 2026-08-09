import { CardListSkeleton, HeaderSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <CardListSkeleton cards={4} avatar={false} />
    </>
  );
}
