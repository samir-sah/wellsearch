import type { SearchResult as Result } from "@/lib/api";
import { HighlightedText } from "./HighlightedText";

export function SearchResult({ result, query }: { result: Result; query: string }) {
  const href = safeHttpUrl(result.url);
  return (
    <article className="group rounded-2xl border border-slate-200/80 bg-white/75 p-5 shadow-sm transition hover:border-cyan-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-900/65 dark:hover:border-cyan-700">
      <div className="mb-2 flex min-w-0 items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-slate-100 font-semibold dark:bg-slate-800">{result.rank}</span>
        <span className="truncate">{result.displayUrl}</span>
      </div>
      <h2 className="text-lg font-semibold leading-snug text-slate-900 dark:text-slate-100">
        {href ? (
          <a className="rounded-sm decoration-cyan-500 decoration-2 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500" href={href} target="_blank" rel="noopener noreferrer">
            <HighlightedText text={result.title} query={query} />
          </a>
        ) : <HighlightedText text={result.title} query={query} />}
      </h2>
      <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
        <HighlightedText text={result.snippet || result.description} query={query} />
      </p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400" aria-label="Result metadata">
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
