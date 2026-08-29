/**
 * IndexManager - the seam between "a page was fetched" and "a query can find
 * it". It owns the analyzer, the inverted index, the document store and the
 * persistence policy, and it is the only object the crawler and the API need.
 *
 * Responsibilities:
 *   - field-weighted analysis (a title hit counts more than a body hit)
 *   - id assignment, URL-level and content-level de-duplication
 *   - batched/periodic persistence (never a write per document)
 *   - crash tolerance: missing files, corrupt files, torn snapshots, and
 *     rebuilding the index from the document store when only the index is lost
 */

import { createHash } from 'node:crypto';
import { config as defaultConfig } from '../config/config.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { analyzer as defaultAnalyzer, Analyzer } from '../search/tokenizer.js';
import { InvertedIndex } from './invertedIndex.js';
import { DocumentStore } from './documentStore.js';
import { ensureDir, fileSize, readJsonSafe, removeFiles, writeJsonAtomic } from './persistence.js';
import { getHost, urlKey } from '../utils/url.js';
import { singleLine } from '../utils/text.js';

/**
 * Position gap inserted between fields so that a phrase query cannot match
 * across a field boundary (title ending in "web" + body starting with
 * "crawler" must not satisfy the phrase "web crawler").
 */
const FIELD_POSITION_GAP = 100;

const MAX_TITLE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 600;
const HASH_INPUT_LIMIT = 200_000;

export class IndexManager {
  constructor({
    config = defaultConfig,
    logger = defaultLogger,
    analyzer = defaultAnalyzer,
    index,
    store,
  } = {}) {
    this.config = config;
    this.logger = logger.child({ module: 'index' });
    this.analyzer = analyzer;

    this.index = index ?? new InvertedIndex({
      storePositions: config.index.storePositions,
      maxPositionsPerTerm: config.index.maxPositionsPerTerm,
    });
    this.store = store ?? new DocumentStore();

    this.dirtyCount = 0;
    this.lastSavedAt = null;
    this.lastSaveDurationMs = null;
    this.lastSaveBytes = 0;
    this.saveErrors = 0;
    this.saveTimer = null;
    this.saveChain = null;
    this.closed = false;
    this.loadedFrom = null;
    this.lastCrawl = null;
    this.createdAt = new Date().toISOString();

    this.counters = {
      indexed: 0, updated: 0, unchanged: 0, duplicates: 0, empty: 0, removed: 0, saves: 0,
    };
  }

  /* ----------------------------------------------------------------------- */
  /* Indexing                                                                 */
  /* ----------------------------------------------------------------------- */

  /**
   * Analyse and index one document.
   *
   * @param {object} input
   * @param {string} input.url
   * @param {string} [input.title]
   * @param {string} [input.description]
   * @param {string} [input.text] extracted readable text
   * @param {number} [input.depth]
   * @param {number} [input.statusCode]
   * @param {string} [input.contentType]
   * @param {string} [input.lang]
   * @param {number} [input.linkCount]
   * @param {number} [input.bytes]
   * @param {string} [input.source] 'crawl' | 'manual' | 'benchmark'
   * @returns {{ id: string|null, status: 'indexed'|'updated'|'unchanged'|'duplicate'|'empty',
   *             length: number, terms: number, duplicateOf?: string }}
   */
  indexDocument(input) {
    if (!input || typeof input.url !== 'string' || input.url === '') {
      throw new TypeError('indexDocument: url is required');
    }

    const url = input.url;
    const key = urlKey(url) ?? url;
    const title = singleLine(input.title ?? '').slice(0, MAX_TITLE_CHARS);
    const description = singleLine(input.description ?? '').slice(0, MAX_DESCRIPTION_CHARS);
    const text = typeof input.text === 'string' ? input.text : '';

    const hash = hashContent(title, text);
    const existingByKey = this.store.getByKey(key);

    // Same URL, same bytes: nothing to do beyond bookkeeping.
    if (existingByKey && existingByKey.hash === hash) {
      this.counters.unchanged += 1;
      return { id: existingByKey.id, status: 'unchanged', length: existingByKey.length ?? 0, terms: 0 };
    }

    // Same content under a different URL: index once, remember the winner.
    const existingByHash = this.store.getByHash(hash);
    if (existingByHash && existingByHash.key !== key) {
      this.counters.duplicates += 1;
      return {
        id: null,
        status: 'duplicate',
        duplicateOf: existingByHash.id,
        length: 0,
        terms: 0,
      };
    }

    const { terms, length, tokenCount } = this.#buildTermMap({ title, description, text });
    if (terms.size === 0 || length === 0) {
      this.counters.empty += 1;
      return { id: null, status: 'empty', length: 0, terms: 0 };
    }

    // Re-indexing a known URL keeps the document id stable so bookmarks and
    // cached result links do not rot.
    const isUpdate = Boolean(existingByKey);
    const id = isUpdate ? existingByKey.id : null;
    if (isUpdate) {
      this.index.removeDocument(id);
      this.store.remove(id);
    }

    const maxStoredText = this.config.index.maxStoredText;
    const document = {
      url,
      key,
      host: getHost(url) ?? '',
      title,
      description,
      text: text.length > maxStoredText ? text.slice(0, maxStoredText) : text,
      textLength: text.length,
      length,
      tokenCount,
      hash,
      statusCode: input.statusCode ?? null,
      contentType: input.contentType ?? null,
      lang: input.lang ?? null,
      fetchedAt: input.fetchedAt ?? new Date().toISOString(),
      depth: Number.isFinite(input.depth) ? input.depth : null,
      linkCount: Number.isFinite(input.linkCount) ? input.linkCount : null,
      bytes: Number.isFinite(input.bytes) ? input.bytes : null,
      source: input.source ?? 'crawl',
    };

    const stored = id ? this.store.put({ ...document, id }) : this.store.add(document);
    this.index.addDocument({ id: stored.id, terms, length });

    if (isUpdate) this.counters.updated += 1;
    else this.counters.indexed += 1;

    this.markDirty();

    return {
      id: stored.id,
      status: isUpdate ? 'updated' : 'indexed',
      length,
      terms: terms.size,
    };
  }

  /**
   * Field-weighted term map. Title and description occurrences are multiplied,
   * which is a single-field approximation of BM25F and is enough to stop a long
   * body from burying an exact title match.
   */
  #buildTermMap({ title, description, text }) {
    const { titleWeight, descriptionWeight, bodyWeight, maxPositionsPerTerm } = this.config.index;
    const storePositions = this.index.storePositions;
    const terms = new Map();

    const titleAnalysis = this.analyzer.analyze(title);
    Analyzer.toTermMap(titleAnalysis.terms, {
      weight: titleWeight, into: terms, maxPositions: maxPositionsPerTerm, storePositions,
    });

    let offset = titleAnalysis.tokenCount + FIELD_POSITION_GAP;
    const descriptionAnalysis = this.analyzer.analyze(description);
    Analyzer.toTermMap(descriptionAnalysis.terms, {
      weight: descriptionWeight, into: terms, maxPositions: maxPositionsPerTerm,
      storePositions, positionOffset: offset,
    });

    offset += descriptionAnalysis.tokenCount + FIELD_POSITION_GAP;
    const bodyAnalysis = this.analyzer.analyze(text);
    Analyzer.toTermMap(bodyAnalysis.terms, {
      weight: bodyWeight, into: terms, maxPositions: maxPositionsPerTerm,
      storePositions, positionOffset: offset,
    });

    let length = 0;
    for (const entry of terms.values()) length += entry.tf;

    return {
      terms,
      length,
      tokenCount: titleAnalysis.tokenCount + descriptionAnalysis.tokenCount + bodyAnalysis.tokenCount,
    };
  }

  removeDocument(id) {
    const removedFromIndex = this.index.removeDocument(id);
    const removedFromStore = this.store.remove(id);
    if (removedFromIndex || removedFromStore) {
      this.counters.removed += 1;
      this.markDirty();
      return true;
    }
    return false;
  }

  removeByUrl(url) {
    const key = urlKey(url) ?? url;
    const document = this.store.getByKey(key);
    return document ? this.removeDocument(document.id) : false;
  }

  /* ----------------------------------------------------------------------- */
  /* Persistence                                                              */
  /* ----------------------------------------------------------------------- */

  markDirty(count = 1) {
    this.dirtyCount += count;
    if (this.closed) return;

    if (this.dirtyCount >= this.config.index.persistBatchSize) {
      // Fire and forget: indexing must not wait on disk.
      this.save().catch((error) => this.logger.error('background save failed', { error }));
      return;
    }
    this.#armSaveTimer();
  }

  #armSaveTimer() {
    if (this.saveTimer || this.config.index.persistIntervalMs <= 0) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((error) => this.logger.error('scheduled save failed', { error }));
    }, this.config.index.persistIntervalMs);
    // Never hold the process open just to flush an index.
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  /**
   * Persist the index. Concurrent calls are serialised so two writers can never
   * interleave into the same temp file.
   *
   * @param {{force?: boolean}} [options] force writes even when nothing changed
   * @returns {Promise<{ok:boolean, skipped?:boolean, bytes?:number, durationMs?:number, error?:string}>}
   */
  async save({ force = false } = {}) {
    if (!force && this.dirtyCount === 0) return { ok: true, skipped: true, reason: 'clean' };

    const run = () => this.#writeAll();
    const chained = (this.saveChain ?? Promise.resolve()).then(run, run);
    this.saveChain = chained.then(
      () => { this.saveChain = null; },
      () => { this.saveChain = null; },
    );
    return chained;
  }

  async #writeAll() {
    const startedAt = performance.now();
    const dirtyAtStart = this.dirtyCount;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    try {
      await ensureDir(this.config.paths.data);

      // Documents first: a torn snapshot then means "index knows about a
      // document the store does not", which load() reconciles by dropping it.
      const documentsWrite = await writeJsonAtomic(this.config.paths.documents, this.store.serialize());
      const indexWrite = await writeJsonAtomic(this.config.paths.index, this.index.serialize());
      const statsWrite = await writeJsonAtomic(this.config.paths.stats, this.snapshot());

      const bytes = documentsWrite.bytes + indexWrite.bytes + statsWrite.bytes;
      const durationMs = performance.now() - startedAt;

      this.dirtyCount = Math.max(0, this.dirtyCount - dirtyAtStart);
      this.lastSavedAt = new Date().toISOString();
      this.lastSaveDurationMs = Number(durationMs.toFixed(2));
      this.lastSaveBytes = bytes;
      this.counters.saves += 1;

      this.logger.debug('index persisted', {
        documents: this.index.documentCount,
        terms: this.index.termCount,
        bytes,
        ms: this.lastSaveDurationMs,
      });

      if (this.dirtyCount > 0) this.#armSaveTimer();

      return { ok: true, bytes, durationMs: this.lastSaveDurationMs };
    } catch (error) {
      this.saveErrors += 1;
      // A failed write keeps the dirty counter, so the next attempt retries.
      this.logger.error('could not persist index', { error, dataDir: this.config.paths.data });
      return { ok: false, error: error.message };
    }
  }

  /**
   * Load a previously persisted index.
   *
   * Failure modes handled here:
   *   - nothing on disk               -> start empty
   *   - corrupt file                  -> quarantine, warn, continue
   *   - index lost, documents intact  -> re-analyse the stored text
   *   - torn snapshot                 -> reconcile store <-> index
   */
  async load() {
    const startedAt = performance.now();
    const [documentsRead, indexRead, statsRead] = await Promise.all([
      readJsonSafe(this.config.paths.documents),
      readJsonSafe(this.config.paths.index),
      readJsonSafe(this.config.paths.stats),
    ]);

    for (const [name, read] of [['documents.json', documentsRead], ['index.json', indexRead]]) {
      if (read.corrupt) {
        this.logger.warn(`${name} is unreadable and was quarantined`, {
          error: read.error?.message,
          quarantinedTo: read.quarantinedTo,
        });
      }
    }

    if (documentsRead.data) {
      this.store = DocumentStore.fromJSON(documentsRead.data);
    }

    let rebuilt = false;
    if (indexRead.data && Array.isArray(indexRead.data.documents)) {
      this.index = InvertedIndex.fromJSON(indexRead.data, {
        storePositions: this.config.index.storePositions,
        maxPositionsPerTerm: this.config.index.maxPositionsPerTerm,
      });
    } else if (this.store.size > 0) {
      this.rebuildFromStore();
      rebuilt = true;
    }

    const reconciled = this.#reconcile();

    if (statsRead.data && statsRead.data.lastCrawl) this.lastCrawl = statsRead.data.lastCrawl;

    const durationMs = performance.now() - startedAt;
    this.loadedFrom = documentsRead.missing && indexRead.missing ? null : this.config.paths.data;
    this.dirtyCount = rebuilt || reconciled.dropped > 0 ? 1 : 0;

    const summary = {
      documents: this.index.documentCount,
      terms: this.index.termCount,
      rebuilt,
      dropped: reconciled.dropped,
      ms: Number(durationMs.toFixed(1)),
    };

    if (documentsRead.missing && indexRead.missing) {
      this.logger.info('no persisted index found, starting empty', { dataDir: this.config.paths.data });
    } else if (rebuilt) {
      this.logger.warn('index rebuilt from the document store', summary);
    } else {
      this.logger.info('index loaded', summary);
    }

    return summary;
  }

  /**
   * Re-analyse every stored document. Used as a recovery path and by
   * `scripts/benchmark.js` to measure indexing throughput on a real corpus.
   *
   * Note: the store keeps text truncated to MAX_STORED_TEXT, so a rebuilt
   * index can be slightly smaller than the original.
   */
  rebuildFromStore() {
    this.index = new InvertedIndex({
      storePositions: this.config.index.storePositions,
      maxPositionsPerTerm: this.config.index.maxPositionsPerTerm,
    });

    let count = 0;
    for (const document of this.store.values()) {
      const { terms, length } = this.#buildTermMap({
        title: document.title ?? '',
        description: document.description ?? '',
        text: document.text ?? '',
      });
      if (terms.size === 0) continue;
      this.index.addDocument({ id: document.id, terms, length });
      document.length = length;
      count += 1;
    }
    return count;
  }

  /** Drop documents that exist on only one side of the store/index pair. */
  #reconcile() {
    let dropped = 0;

    for (const id of [...this.index.documentIds()]) {
      if (!this.store.has(id)) {
        this.index.removeDocument(id);
        dropped += 1;
      }
    }
    for (const id of [...this.store.ids()]) {
      if (!this.index.hasDocument(id)) {
        this.store.remove(id);
        dropped += 1;
      }
    }

    if (dropped > 0) this.logger.warn('reconciled a torn index snapshot', { dropped });
    return { dropped };
  }

  /** Wipe memory and disk. */
  async clear() {
    this.index.clear();
    this.store.clear();
    this.dirtyCount = 0;
    this.lastCrawl = null;
    for (const key of Object.keys(this.counters)) this.counters[key] = 0;
    await removeFiles([
      this.config.paths.index,
      this.config.paths.documents,
      this.config.paths.stats,
    ]);
    this.logger.info('index cleared');
    return { ok: true };
  }

  /* ----------------------------------------------------------------------- */
  /* Reporting                                                                */
  /* ----------------------------------------------------------------------- */

  recordCrawl(summary) {
    this.lastCrawl = summary;
    this.markDirty(0);
  }

  /** Serialised into stats.json and served by /api/stats. */
  snapshot() {
    const indexStats = this.index.stats();
    return {
      version: 2,
      savedAt: new Date().toISOString(),
      createdAt: this.createdAt,
      index: indexStats,
      store: this.store.stats(),
      bm25: { k1: this.config.bm25.k1, b: this.config.bm25.b },
      analyzer: {
        stemming: this.analyzer.stemming,
        stopWords: this.analyzer.stopWords.size,
        stemCacheSize: this.analyzer.stemmer.size,
      },
      counters: { ...this.counters },
      lastCrawl: this.lastCrawl,
    };
  }

  async stats() {
    const [indexBytes, documentBytes] = await Promise.all([
      fileSize(this.config.paths.index),
      fileSize(this.config.paths.documents),
    ]);
    const base = this.snapshot();
    return {
      ...base,
      persistence: {
        dataDir: this.config.paths.data,
        dirty: this.dirtyCount,
        lastSavedAt: this.lastSavedAt,
        lastSaveDurationMs: this.lastSaveDurationMs,
        lastSaveBytes: this.lastSaveBytes,
        saveErrors: this.saveErrors,
        indexFileBytes: indexBytes,
        documentsFileBytes: documentBytes,
        loadedFrom: this.loadedFrom,
      },
      topHosts: this.store.hostHistogram(8),
    };
  }

  /** Flush and stop timers. Safe to call twice. */
  async close() {
    this.closed = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirtyCount > 0) {
      const result = await this.save({ force: true });
      return result;
    }
    if (this.saveChain) await this.saveChain.catch(() => {});
    return { ok: true, skipped: true };
  }
}

function hashContent(title, text) {
  const source = text.length > HASH_INPUT_LIMIT ? text.slice(0, HASH_INPUT_LIMIT) : text;
  return createHash('sha1')
    .update(title)
    .update('|')
    .update(source)
    .digest('hex')
    .slice(0, 16);
}

export default IndexManager;
