import type { SearchResult as Result } from "@/lib/api";
import { HighlightedText } from "./HighlightedText";

export function SearchResult({ result, query }: { result: Result; query: string }) {
  const href = safeHttpUrl(result.url);
  return (
    <article className="glass-panel interactive-surface group rounded-2xl p-5 sm:p-6">
      <div className="mb-3 flex min-w-0 items-center gap-2.5 text-xs text-muted">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-brand-line bg-brand-soft/90 font-semibold text-brand shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">{result.rank}</span>
        <span className="truncate">{result.displayUrl}</span>
      </div>
      <h2 className="break-words text-lg font-bold leading-snug tracking-[-0.025em] text-brand [overflow-wrap:anywhere]">
        {href ? (
          <a className="rounded-sm decoration-brand/50 decoration-2 underline-offset-4 transition-colors hover:text-[#003e20] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2" href={href} target="_blank" rel="noopener noreferrer">
            <HighlightedText text={result.title} query={query} />
          </a>
        ) : <HighlightedText text={result.title} query={query} />}
      </h2>
      <p className="mt-2.5 break-words text-sm leading-6 text-[#55665e] [overflow-wrap:anywhere]">
        <HighlightedText text={result.snippet || result.description} query={query} />
      </p>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-brand-line/55 pt-3 text-xs text-muted" aria-label="Result metadata">
        <span>Score {result.score.toFixed(3)}</span>
        <span>{result.matchedTerms} matched term{result.matchedTerms === 1 ? "" : "s"}</span>
        {result.fetchedAt && <span>Fetched {formatDate(result.fetchedAt)}</span>}
      </div>
    </article>
  );
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}
