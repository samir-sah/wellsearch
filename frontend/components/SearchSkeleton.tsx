export function SearchSkeleton() {
  return (
    <div className="space-y-4" aria-label="Searching" aria-busy="true">
      {[0, 1, 2].map((item) => (
        <div key={item} className="glass-panel animate-pulse rounded-2xl p-5 motion-reduce:animate-none sm:p-6">
          <div className="flex items-center gap-2.5">
            <div className="size-7 rounded-lg bg-brand-line/65" />
            <div className="h-3 w-2/5 rounded bg-brand-soft" />
          </div>
          <div className="mt-3 h-5 w-3/4 rounded bg-brand-line/70" />
          <div className="mt-4 h-3 w-full rounded bg-brand-soft" />
          <div className="mt-2 h-3 w-5/6 rounded bg-brand-soft" />
          <div className="mt-4 border-t border-brand-line/55 pt-3">
            <div className="h-3 w-1/3 rounded bg-brand-soft" />
          </div>
        </div>
      ))}
    </div>
  );
}
