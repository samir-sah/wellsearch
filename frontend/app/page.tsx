"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { SearchApiError, type SearchResponse, search } from "@/lib/api";
import { SearchResult } from "@/components/SearchResult";
import { SearchSkeleton } from "@/components/SearchSkeleton";

export default function Home() {
  const [query, setQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<SearchApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);

  async function runSearch(nextQuery: string, preserveHistory = false) {
    const normalized = nextQuery.trim();
    if (!normalized) return;
    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    setLoading(true);
    setError(null);
    setData(null);
    setSearchedQuery(normalized);
    if (!preserveHistory) window.history.pushState(null, "", `?q=${encodeURIComponent(normalized)}`);
    try {
      const result = await search(normalized, requestController.signal);
      // A slower, superseded request must never replace a newer result.
      if (controller.current === requestController) setData(result);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (controller.current === requestController) {
        setError(caught instanceof SearchApiError ? caught : new SearchApiError("Something went wrong. Please try again.", "network"));
      }
    } finally {
      if (controller.current === requestController) setLoading(false);
    }
  }

  useEffect(() => {
    const restoredQuery = new URLSearchParams(window.location.search).get("q") ?? "";
    if (restoredQuery) {
      queueMicrotask(() => {
        setQuery(restoredQuery);
        void runSearch(restoredQuery, true);
      });
    }
    return () => {
      controller.current?.abort();
      controller.current = null;
    };
  }, []); // Run once to restore a shared/bookmarked query.

  function submit(event: FormEvent) {
    event.preventDefault();
    void runSearch(query);
  }

  const compact = loading || data || error;
  return (
    <main className={`mx-auto flex min-h-svh w-full max-w-4xl flex-col px-5 sm:px-8 ${compact ? "py-7 sm:py-10" : "pb-7 pt-[clamp(5rem,18vh,11rem)]"}`}>
      <header className={compact ? "mb-7" : "mb-9 text-center"}>
        {!compact && <div className="mb-6"><span className="glass-panel inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-[11px] font-medium tracking-wide text-brand"><span aria-hidden="true" className="size-1.5 rounded-full bg-brand" />A world of knowledge, a little closer.</span></div>}
        <Link href="/" aria-label="WellSearch home" className="group inline-flex min-h-11 max-w-full items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-4 sm:gap-3">
          <span aria-hidden="true" className={`matte-button grid shrink-0 place-items-center font-bold ${compact ? "size-10 rounded-xl text-lg" : "size-11 rounded-2xl text-xl sm:size-14 sm:text-2xl"}`}>W</span>
          <h1 className={`min-w-0 font-bold tracking-[-0.06em] text-brand ${compact ? "text-2xl" : "text-[clamp(1.95rem,8vw,3.5rem)] leading-tight"}`}>Well<span className="text-ink">Search</span></h1>
        </Link>
        {!compact && <p className="mx-auto mt-5 max-w-md text-sm leading-7 text-muted sm:text-base">Find your next rabbit hole.<br className="sm:hidden" /> Explore Wikipedia, beautifully simply.</p>}
      </header>

      <form onSubmit={submit} role="search" className={`glass-panel search-shell relative rounded-[1.25rem] ${compact ? "mb-8" : "mx-auto mb-8 w-full max-w-2xl"}`}>
        <label htmlFor="search" className="sr-only">Search query</label>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-brand/70"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
        <input id="search" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" maxLength={8192} placeholder="Search WellSearch…" className="h-[4.5rem] w-full rounded-[1.25rem] bg-transparent pl-12 pr-28 text-base text-ink outline-none placeholder:text-muted" />
        <button type="submit" disabled={!query.trim() || loading} className="matte-button absolute right-2.5 top-3 h-12 rounded-xl px-5 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">Search</button>
      </form>

      <section aria-live="polite" aria-atomic="false">
        {loading && <SearchSkeleton />}
        {error && (
          <div role="alert" className="glass-panel rounded-2xl border-rose-200/70 p-5 text-rose-900">
            <h2 className="font-semibold">Search unavailable</h2><p className="mt-1 text-sm">{error.message}</p>
            {error.requestId && <p className="mt-2 text-xs opacity-70">Request ID: {error.requestId}</p>}
            <button onClick={() => void runSearch(searchedQuery, true)} className="quiet-button mt-4 min-h-11 rounded-xl px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">Try again</button>
          </div>
        )}
        {data && (
          <>
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2 text-xs leading-6 text-muted sm:text-sm">
              <p className="min-w-0 [overflow-wrap:anywhere]">{data.total.toLocaleString()} result{data.total === 1 ? "" : "s"} for <strong className="font-semibold text-ink">“{data.query}”</strong></p>
              <p className="shrink-0 tabular-nums">{data.took.toLocaleString()} ms</p>
            </div>
            {data.warnings.length > 0 && <div className="glass-panel mb-4 rounded-xl border-amber-200/70 px-4 py-3 text-sm text-amber-900">{data.warnings.join(" · ")}</div>}
            {data.results.length > 0 ? <div className="space-y-3">{data.results.map((result) => <SearchResult key={result.id} result={result} query={data.query} />)}</div> : (
              <div className="glass-panel rounded-2xl px-5 py-12 text-center">
                <h2 className="text-lg font-semibold text-brand">No results found</h2><p className="mt-2 text-sm leading-6 text-muted">Try fewer words, check spelling, or remove filters.</p>
                {data.suggestions.length > 0 && <div className="mt-5 flex flex-wrap justify-center gap-2">{data.suggestions.map((suggestion) => <button key={suggestion} onClick={() => { setQuery(suggestion); void runSearch(suggestion); }} className="quiet-button min-h-11 max-w-full rounded-full px-4 py-2 text-sm [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">{suggestion}</button>)}</div>}
              </div>
            )}
          </>
        )}
      </section>
      <footer className="mt-auto pt-12 text-center text-[11px] tracking-wide text-muted"><span className="font-semibold text-brand">WellSearch</span> <span aria-hidden="true" className="mx-1.5 text-brand/30">/</span> Made for curious minds.</footer>
    </main>
  );
}
