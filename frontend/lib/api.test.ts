import { afterEach, describe, expect, it, vi } from "vitest";
import { search } from "./api";

const validResponse = {
  query: "needle & thread",
  terms: ["needle", "thread"],
  results: [],
  total: 0,
  page: 1,
  limit: 10,
  totalPages: 1,
  took: 2,
  timings: { parsing: 0, retrieval: 0, scoring: 0, filtering: 0, sorting: 0, presentation: 0, total: 2 },
  diagnostics: {
    documentCount: 0, averageDocumentLength: 0, candidates: 0, postingsScanned: 0,
    truncated: false, proximityApplied: false, unknownTerms: [], phrases: [], exclusions: [], hosts: [],
    bm25: { k1: 1.5, b: 0.75 },
  },
  suggestions: [],
  warnings: [],
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("search API client", () => {
  it("URL-encodes the query and accepts the backend contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(validResponse));
    vi.stubGlobal("fetch", fetchMock);

    await expect(search("needle & thread")).resolves.toEqual(validResponse);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/search?q=needle+%26+thread");
  });

  it("reports network failures with a useful generic error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(search("needle")).rejects.toMatchObject({
      kind: "network",
      message: "WellSearch is unreachable. Check your connection and try again.",
    });
  });

  it("handles HTTP 429 and preserves its request ID", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      error: { code: "RATE_LIMITED", message: "slow down", requestId: "req-429" },
    }, 429)));
    await expect(search("needle")).rejects.toMatchObject({
      kind: "rate-limit", requestId: "req-429", message: "Too many searches. Please wait a moment and retry.",
    });
  });

  it("rejects malformed successful JSON instead of rendering it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ results: "not-an-array" })));
    await expect(search("needle")).rejects.toMatchObject({
      kind: "malformed", message: "WellSearch returned an unexpected response. Please try again.",
    });
  });
});
