export type SearchResult = {
  id: string;
  rank: number;
  url: string;
  displayUrl: string;
  host: string;
  title: string;
  titleHtml: string;
  description: string;
  snippet: string;
  snippetHtml: string;
  score: number;
  bm25Score: number;
  proximityBoost: number;
  matchedTerms: number;
  documentLength: number;
  fetchedAt: string | null;
  depth: number | null;
  explain?: {
    contributions: Array<{ term: string; tf: number; df: number; idf: number; contribution: number }>;
    lengthPenalty: number;
    snippetSource: string;
  };
};

export type SearchResponse = {
  query: string;
  terms: string[];
  results: SearchResult[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  took: number;
  timings: {
    parsing: number;
    retrieval: number;
    scoring: number;
    filtering: number;
    sorting: number;
    presentation: number;
    total: number;
  };
  diagnostics: {
    documentCount: number;
    averageDocumentLength: number;
    candidates: number;
    postingsScanned: number;
    truncated: boolean;
    proximityApplied: boolean;
    unknownTerms: string[];
    phrases: string[];
    exclusions: string[];
    hosts: string[];
    bm25: { k1: number; b: number };
    reason?: string;
  };
  suggestions: string[];
  warnings: string[];
};

type ErrorEnvelope = { error: { code: string; message: string; requestId?: string } };
export type SearchErrorKind = "timeout" | "network" | "rate-limit" | "server" | "malformed" | "request";

export class SearchApiError extends Error {
  constructor(
    message: string,
    public readonly kind: SearchErrorKind,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "SearchApiError";
  }
}

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 10_000;

export async function search(query: string, signal?: AbortSignal): Promise<SearchResponse> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;

  try {
    const params = new URLSearchParams({ q: query });
    response = await fetch(`${API_URL}/api/search?${params}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: combinedSignal,
    });
  } catch (error) {
    if (timeout.aborted) throw new SearchApiError("The search took too long. Please try again.", "timeout");
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new SearchApiError("NixSearch is unreachable. Check your connection and try again.", "network");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = isErrorEnvelope(payload) ? payload : undefined;
    const requestId = envelope?.error.requestId;
    if (response.status === 429) throw new SearchApiError("Too many searches. Please wait a moment and retry.", "rate-limit", requestId);
    if (response.status >= 500) throw new SearchApiError("NixSearch is having trouble right now. Please try again.", "server", requestId);
    throw new SearchApiError(envelope?.error.message ?? "The search request could not be completed.", "request", requestId);
  }

  if (!isSearchResponse(payload)) {
    throw new SearchApiError("NixSearch returned an unexpected response. Please try again.", "malformed");
  }
  return payload;
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!isRecord(value) || !isRecord(value.error)) return false;
  return typeof value.error.code === "string" && typeof value.error.message === "string" &&
    (value.error.requestId === undefined || typeof value.error.requestId === "string");
}

function isSearchResponse(value: unknown): value is SearchResponse {
  if (!isRecord(value) || !Array.isArray(value.results) || !value.results.every(isSearchResult)) return false;
  if (!isRecord(value.timings) || !isRecord(value.diagnostics) || !isRecord(value.diagnostics.bm25)) return false;
  return typeof value.query === "string" && isStringArray(value.terms) &&
    numbers(value, ["total", "page", "limit", "totalPages", "took"]) &&
    numbers(value.timings, ["parsing", "retrieval", "scoring", "filtering", "sorting", "presentation", "total"]) &&
    numbers(value.diagnostics, ["documentCount", "averageDocumentLength", "candidates", "postingsScanned"]) &&
    typeof value.diagnostics.truncated === "boolean" && typeof value.diagnostics.proximityApplied === "boolean" &&
    isStringArray(value.diagnostics.unknownTerms) && isStringArray(value.diagnostics.phrases) &&
    isStringArray(value.diagnostics.exclusions) && isStringArray(value.diagnostics.hosts) &&
    numbers(value.diagnostics.bm25, ["k1", "b"]) &&
    (value.diagnostics.reason === undefined || typeof value.diagnostics.reason === "string") &&
    isStringArray(value.suggestions) && isStringArray(value.warnings);
}

function isSearchResult(value: unknown): value is SearchResult {
  if (!isRecord(value)) return false;
  return ["id", "url", "displayUrl", "host", "title", "titleHtml", "description", "snippet", "snippetHtml"].every(
    (key) => typeof value[key] === "string",
  ) && numbers(value, ["rank", "score", "bm25Score", "proximityBoost", "matchedTerms", "documentLength"]) &&
    (value.fetchedAt === null || typeof value.fetchedAt === "string") &&
    (value.depth === null || typeof value.depth === "number");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function numbers(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]));
}
