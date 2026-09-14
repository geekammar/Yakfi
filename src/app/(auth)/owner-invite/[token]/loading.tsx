import {
  ListRowSkeleton,
  LoadingAnnouncement,
} from "@/components/shared/page-skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <LoadingAnnouncement label="جارٍ التحميل…" />
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <ListRowSkeleton key={index} />
        ))}
      </div>
    </div>
  );
}
