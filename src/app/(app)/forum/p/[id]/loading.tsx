import { ArticleSkeleton, ListSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <>
      <ArticleSkeleton />
      <div className="mt-9">
        <ListSkeleton rows={3} />
      </div>
    </>
  );
}
