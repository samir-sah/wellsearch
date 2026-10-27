import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let search: typeof import("./api").search;

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

beforeEach(async () => {
  vi.resetModules();
  ({ search } = await import("./api"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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

  it("returns a completed repeat search immediately without another request", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => response(validResponse));
    vi.stubGlobal("fetch", fetchMock);

    await expect(search("needle & thread")).resolves.toEqual(validResponse);
    await expect(search("  needle & thread  ")).resolves.toEqual(validResponse);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fetches fresh results after the completed search expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
    const fetchMock = vi.fn().mockImplementation(async () => response(validResponse));
    vi.stubGlobal("fetch", fetchMock);

    await search("needle & thread");
    vi.setSystemTime(new Date("2026-10-27T00:00:29.999Z"));
    await search("needle & thread");
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date("2026-10-27T00:00:30Z"));
    await search("needle & thread");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds memory by evicting the least recently used of 30 searches", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => response(validResponse));
    vi.stubGlobal("fetch", fetchMock);

    for (let index = 0; index < 30; index += 1) await search(`topic ${index}`);
    await search("topic 0");
    expect(fetchMock).toHaveBeenCalledTimes(30);
    await search("topic 30");
    await search("topic 0");
    expect(fetchMock).toHaveBeenCalledTimes(31);
    await search("topic 1");
    expect(fetchMock).toHaveBeenCalledTimes(32);
  });

  it.each([
    { name: "rate limits", status: 429, body: { error: { code: "RATE_LIMITED", message: "retry" } }, kind: "rate-limit" },
    { name: "server failures", status: 503, body: {}, kind: "server" },
    { name: "invalid JSON contracts", status: 200, body: { results: "invalid" }, kind: "malformed" },
  ])("never caches $name", async ({ status, body, kind }) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(body, status))
      .mockResolvedValueOnce(response(validResponse));
    vi.stubGlobal("fetch", fetchMock);

    await expect(search("needle & thread")).rejects.toMatchObject({ kind });
    await expect(search("needle & thread")).resolves.toEqual(validResponse);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors caller cancellation even when results are already cached", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => response(validResponse));
    vi.stubGlobal("fetch", fetchMock);
    await search("needle & thread");
    const controller = new AbortController();
    controller.abort();

    await expect(search("needle & thread", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("shows partial results but retries immediately after an upstream warning", async () => {
    const partialResponse = {
      ...validResponse,
      warnings: ["1 Wikipedia article(s) could not be downloaded; showing available results."],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(partialResponse))
      .mockResolvedValueOnce(response(validResponse));
    vi.stubGlobal("fetch", fetchMock);

    await expect(search("needle & thread")).resolves.toEqual(partialResponse);
    await expect(search("needle & thread")).resolves.toEqual(validResponse);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(search("needle & thread")).resolves.toEqual(validResponse);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a response whose caller cancels during body parsing", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => {
          controller.abort();
          return validResponse;
        },
      })
      .mockResolvedValueOnce(response(validResponse));
    vi.stubGlobal("fetch", fetchMock);

    await expect(search("needle & thread", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(search("needle & thread")).resolves.toEqual(validResponse);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
