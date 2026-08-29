export function SearchSkeleton() {
  return (
    <div className="space-y-4" aria-label="Searching" aria-busy="true">
      {[0, 1, 2].map((item) => (
        <div key={item} className="animate-pulse rounded-2xl border border-slate-200 bg-white/70 p-5 dark:border-slate-800 dark:bg-slate-900/60">
          <div className="h-3 w-2/5 rounded bg-slate-200 dark:bg-slate-700" />
          <div className="mt-4 h-5 w-3/4 rounded bg-slate-200 dark:bg-slate-700" />
          <div className="mt-4 h-3 w-full rounded bg-slate-200 dark:bg-slate-700" />
          <div className="mt-2 h-3 w-5/6 rounded bg-slate-200 dark:bg-slate-700" />
        </div>
      ))}
    </div>
  );
}
