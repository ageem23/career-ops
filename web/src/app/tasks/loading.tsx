import { Skeleton } from "@/components/ui/skeleton";

// Mirrors tasks-view.tsx: max-w-3xl container, a serif title and intro, the
// filter chips, then a list of task rows.
export default function TasksLoading() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10" aria-label="Loading tasks">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="mt-3 h-4 w-full max-w-lg" />
      <div className="mt-6 flex gap-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-7 w-20 rounded-full" style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
      <div className="mt-8 space-y-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" style={{ animationDelay: `${i * 80}ms` }} />
        ))}
      </div>
    </div>
  );
}
