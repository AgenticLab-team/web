import { HeaderSkeleton, ListSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton withAction />
      <ListSkeleton rows={7} />
    </>
  );
}
