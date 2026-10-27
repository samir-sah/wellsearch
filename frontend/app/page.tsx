"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { SearchApiError, type SearchResponse, search } from "@/lib/api";
import { SearchResult } from "@/components/SearchResult";
import { SearchSkeleton } from "@/components/SearchSkeleton";
import { BrandMark } from "@/components/BrandMark";

export default function Home() {
  const [query, setQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<SearchApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [responseTime, setResponseTime] = useState<number | null>(null);
  const controller = useRef<AbortController | null>(null);

  async function runSearch(nextQuery: string, preserveHistory = false) {
    const normalized = nextQuery.trim();
    if (!normalized) return;
    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    const started = performance.now();
    setLoading(true);
    setResponseTime(null);
    setError(null);
    setData(null);
    setSearchedQuery(normalized);
    if (!preserveHistory) window.history.pushState(null, "", `?q=${encodeURIComponent(normalized)}`);
    try {
      const result = await search(normalized, requestController.signal);
      // A slower, superseded request must never replace a newer result.
      if (controller.current === requestController) {
        setResponseTime(Math.round((performance.now() - started) * 100) / 100);
        setData(result);
      }
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
    <main className={`mx-auto flex min-h-svh w-full max-w-5xl flex-col px-5 sm:px-8 ${compact ? "py-7 sm:py-9" : "justify-center pb-[18vh] pt-12"}`}>
      <header className={`flex items-center gap-4 ${compact ? "mb-8" : "mb-9 justify-center"}`}>
        <Link href="/" aria-label="WellSearch home" className="brand-link group inline-flex min-h-11 max-w-full items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-4 sm:gap-3">
          <BrandMark className="size-12 shrink-0 sm:size-14" />
          <h1 className={`brand-wordmark min-w-0 font-extrabold leading-none tracking-[-0.065em] text-ink ${compact ? "text-[1.65rem] sm:text-3xl" : "text-[2rem] sm:text-[2.75rem]"}`}>Well<span className="text-brand">Search</span></h1>
        </Link>
      </header>

      <form onSubmit={submit} role="search" className={`glass-panel search-shell relative rounded-[1.4rem] ${compact ? "mb-8" : "mx-auto w-full max-w-3xl"}`}>
        <label htmlFor="search" className="sr-only">Search query</label>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-brand/70 sm:left-5"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
        <input id="search" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" maxLength={8192} placeholder="Search Wikipedia" className="h-16 w-full rounded-[1.4rem] bg-transparent pl-12 pr-28 text-base font-medium text-ink outline-none placeholder:text-muted sm:h-20 sm:pl-14 sm:pr-44 sm:text-lg" />
        <button type="submit" disabled={!query.trim() || loading} className="glass-action absolute right-2 top-2 inline-flex h-12 items-center justify-center gap-3 rounded-2xl px-4 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 sm:h-16 sm:px-7 sm:text-base">
          <span className="relative z-10">Search</span>
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="relative z-10 hidden size-4 sm:block"><path d="M4 10h12m-5-5 5 5-5 5" /></svg>
        </button>
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
              <p aria-label="Search response time" title={`Server processing: ${data.took.toLocaleString()} ms`} className="shrink-0 tabular-nums">{(responseTime ?? data.took).toLocaleString()} ms</p>
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
    </main>
  );
}
