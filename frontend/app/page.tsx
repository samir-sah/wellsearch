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
    <main className={`mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 sm:px-8 ${compact ? "py-8" : "justify-center py-16"}`}>
      <header className={compact ? "mb-8" : "mb-10 text-center"}>
        <Link href="/" aria-label="NixSearch home" className="inline-flex min-h-11 items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
          <span aria-hidden="true" className="grid size-11 place-items-center rounded-2xl bg-slate-900 text-xl font-black text-white shadow-lg shadow-cyan-500/10 dark:bg-white dark:text-slate-950">N</span>
          <h1 className="text-2xl font-bold tracking-tight">Nix<span className="text-cyan-600 dark:text-cyan-400">Search</span></h1>
        </Link>
        {!compact && <p className="mx-auto mt-4 max-w-md text-slate-600 dark:text-slate-400">Search the indexed web with focused, transparent ranking.</p>}
      </header>

      <form onSubmit={submit} role="search" className={`relative ${compact ? "mb-8" : "mx-auto mb-8 w-full max-w-2xl"}`}>
        <label htmlFor="search" className="sr-only">Search query</label>
        <input id="search" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" maxLength={8192} placeholder="Search NixSearch…" className="h-14 w-full rounded-2xl border border-slate-300 bg-white/90 pl-5 pr-28 text-base shadow-lg shadow-slate-900/5 outline-none transition placeholder:text-slate-400 focus:border-cyan-500 focus:ring-4 focus:ring-cyan-500/15 dark:border-slate-700 dark:bg-slate-900/90 dark:focus:border-cyan-400" />
        <button type="submit" disabled={!query.trim() || loading} className="absolute right-1.5 top-1.5 h-11 rounded-xl bg-slate-900 px-5 text-sm font-semibold text-white transition hover:bg-cyan-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-cyan-500 dark:text-slate-950 dark:hover:bg-cyan-400 dark:focus-visible:ring-offset-slate-950">Search</button>
      </form>

      <section aria-live="polite" aria-atomic="false">
        {loading && <SearchSkeleton />}
        {error && (
          <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
            <h2 className="font-semibold">Search unavailable</h2><p className="mt-1 text-sm">{error.message}</p>
            {error.requestId && <p className="mt-2 text-xs opacity-70">Request ID: {error.requestId}</p>}
            <button onClick={() => void runSearch(searchedQuery, true)} className="mt-4 min-h-11 rounded-lg border border-current px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500">Try again</button>
          </div>
        )}
        {data && (
          <>
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2 text-sm text-slate-500 dark:text-slate-400">
              <p>{data.total.toLocaleString()} result{data.total === 1 ? "" : "s"} for <strong className="text-slate-700 dark:text-slate-200">“{data.query}”</strong></p>
              <p>{data.took.toLocaleString()} ms</p>
            </div>
            {data.warnings.length > 0 && <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">{data.warnings.join(" · ")}</div>}
            {data.results.length > 0 ? <div className="space-y-4">{data.results.map((result) => <SearchResult key={result.id} result={result} query={data.query} />)}</div> : (
              <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
                <h2 className="text-lg font-semibold">No results found</h2><p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Try fewer words, check spelling, or remove filters.</p>
                {data.suggestions.length > 0 && <div className="mt-5 flex flex-wrap justify-center gap-2">{data.suggestions.map((suggestion) => <button key={suggestion} onClick={() => { setQuery(suggestion); void runSearch(suggestion); }} className="min-h-11 rounded-full border border-slate-300 px-3 py-2 text-sm hover:border-cyan-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:border-slate-700">{suggestion}</button>)}</div>}
              </div>
            )}
          </>
        )}
      </section>
      <footer className="mt-auto pt-12 text-center text-xs text-slate-400">NixSearch · BM25 ranked search</footer>
    </main>
  );
}
