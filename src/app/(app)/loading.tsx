import { HeaderSkeleton, ListSkeleton, StatsSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <StatsSkeleton />
      <ListSkeleton rows={8} />
    </>
  );
}
