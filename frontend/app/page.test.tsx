import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Home from "./page";
import { SearchApiError, type SearchResponse } from "@/lib/api";

const searchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, search: searchMock };
});

function resultResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    query: "needle", terms: ["needle"], total: 1, page: 1, limit: 10, totalPages: 1, took: 3,
    timings: { parsing: 0, retrieval: 0, scoring: 1, filtering: 0, sorting: 0, presentation: 0, total: 3 },
    diagnostics: {
      documentCount: 1, averageDocumentLength: 20, candidates: 1, postingsScanned: 1,
      truncated: false, proximityApplied: false, unknownTerms: [], phrases: [], exclusions: [], hosts: [],
      bm25: { k1: 1.5, b: 0.75 },
    },
    results: [{
      id: "doc-1", rank: 1, url: "https://fixture.invalid/guide", displayUrl: "fixture.invalid/guide",
      host: "fixture.invalid", title: "Needle <img src=x onerror=alert(1)>", titleHtml: "",
      description: "Needle guide", snippet: "A safe needle result", snippetHtml: "", score: 2.5,
      bm25Score: 2.5, proximityBoost: 0, matchedTerms: 1, documentLength: 20,
      fetchedAt: null, depth: 0,
    }],
    suggestions: [], warnings: [], ...overrides,
  };
}

beforeEach(() => {
  searchMock.mockReset();
  window.history.replaceState(null, "", "/");
});

describe("search page behavior", () => {
  it("exposes a single page heading and an unambiguous home link name", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { level: 1, name: "NixSearch" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "NixSearch home" })).toBeTruthy();
  });

  it("submits trimmed input, preserves the query in the URL, and renders safe results", async () => {
    searchMock.mockResolvedValue(resultResponse());
    render(<Home />);
    fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "  needle  " } });
    fireEvent.submit(screen.getByRole("search"));

    expect(searchMock).toHaveBeenCalledWith("needle", expect.any(AbortSignal));
    expect(window.location.search).toBe("?q=needle");
    expect(await screen.findByText(/1 result for/)).toBeTruthy();
    const link = screen.getByRole("link", { name: /Needle/ });
    expect(link.getAttribute("href")).toBe("https://fixture.invalid/guide");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getAllByText("Needle", { selector: "mark" }).length).toBeGreaterThan(0);
  });

  it("keeps the newest results when an older request completes afterwards", async () => {
    let resolveFirst: (value: SearchResponse) => void;
    let resolveSecond: (value: SearchResponse) => void;
    const first = new Promise<SearchResponse>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<SearchResponse>((resolve) => { resolveSecond = resolve; });
    searchMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    render(<Home />);
    const input = screen.getByLabelText("Search query");
    const form = screen.getByRole("search");
    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.submit(form);
    fireEvent.change(input, { target: { value: "second" } });
    fireEvent.submit(form);

    resolveSecond!(resultResponse({ query: "second" }));
    await waitFor(() => expect(resultSummaryQuery()).toBe("second"));
    resolveFirst!(resultResponse({ query: "first" }));
    await waitFor(() => expect(resultSummaryQuery()).toBe("second"));
  });

  it("restores a bookmarked query and searches without rewriting history", async () => {
    window.history.replaceState(null, "", "/?q=saved%20query");
    searchMock.mockResolvedValue(resultResponse({ query: "saved query" }));
    render(<Home />);
    expect(await screen.findByDisplayValue("saved query")).toBeTruthy();
    expect(searchMock).toHaveBeenCalledWith("saved query", expect.any(AbortSignal));
    expect(window.location.search).toBe("?q=saved%20query");
  });

  it("shows loading UI while the request is pending", async () => {
    searchMock.mockReturnValue(new Promise(() => {}));
    render(<Home />);
    fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByLabelText("Searching")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search" }).hasAttribute("disabled")).toBe(true);
  });

  it("renders the empty state", async () => {
    searchMock.mockResolvedValue(resultResponse({ total: 0, results: [], diagnostics: { ...resultResponse().diagnostics, documentCount: 0 } }));
    render(<Home />);
    fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "missing" } });
    fireEvent.submit(screen.getByRole("search"));
    expect(await screen.findByText("No results found")).toBeTruthy();
  });

  it("renders generic errors and does not link unsafe result URLs", async () => {
    searchMock.mockRejectedValueOnce(new SearchApiError("NixSearch is unreachable. Check your connection and try again.", "network"));
    render(<Home />);
    fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "needle" } });
    fireEvent.submit(screen.getByRole("search"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/NixSearch is unreachable/)).toBeTruthy();

    searchMock.mockResolvedValueOnce(resultResponse({ results: [{ ...resultResponse().results[0], url: "javascript:alert(1)" }] }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByRole("link", { name: /Needle/ })).toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toContain("Needle");
  });
});

function resultSummaryQuery() {
  return document.querySelector("section strong")?.textContent?.replace(/[“”]/g, "") ?? null;
}
