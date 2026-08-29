/**
 * Document store: the "forward" half of the index.
 *
 * The inverted index answers "which documents contain this term"; the store
 * answers "what is document 42" - URL, title, extracted text (for snippets)
 * and crawl metadata. It also owns id assignment and the two dedupe maps:
 *
 *   byKey  : canonical URL key -> id   (the same page reached by two URLs)
 *   byHash : content hash      -> id   (mirrors, print views, session URLs)
 */

export const STORE_FORMAT_VERSION = 2;

/** Fields persisted for every document, in a fixed order. */
const DOCUMENT_FIELDS = [
  'id', 'url', 'key', 'host', 'title', 'description', 'text', 'textLength',
  'length', 'tokenCount', 'hash', 'statusCode', 'contentType', 'lang',
  'fetchedAt', 'depth', 'linkCount', 'bytes', 'source',
];

export class DocumentStore {
  constructor() {
    /** @type {Map<string, object>} */
    this.documents = new Map();
    /** @type {Map<string, string>} canonical url key -> document id */
    this.byKey = new Map();
    /** @type {Map<string, string>} content hash -> document id */
    this.byHash = new Map();
    this.nextId = 1;
  }

  get size() {
    return this.documents.size;
  }

  /**
   * Insert a document, assigning the next free id.
   * @param {object} document must carry at least `url`
   * @returns {object} the stored document (frozen shape, not frozen object)
   */
  add(document) {
    if (!document || typeof document.url !== 'string' || document.url === '') {
      throw new TypeError('DocumentStore.add: document.url is required');
    }
    const id = `doc_${this.nextId}`;
    this.nextId += 1;
    return this.put({ ...document, id });
  }

  /**
   * Insert a document that already has an id (used when loading from disk and
   * when re-indexing an existing URL).
   */
  put(document) {
    if (!document || typeof document.id !== 'string') {
      throw new TypeError('DocumentStore.put: document.id is required');
    }

    const previous = this.documents.get(document.id);
    if (previous) {
      if (previous.key) this.byKey.delete(previous.key);
      if (previous.hash) this.byHash.delete(previous.hash);
    }

    this.documents.set(document.id, document);
    if (document.key) this.byKey.set(document.key, document.id);
    if (document.hash) this.byHash.set(document.hash, document.id);

    // Keep the id counter ahead of any explicitly supplied id.
    const numeric = Number.parseInt(document.id.replace(/^doc_/, ''), 10);
    if (Number.isFinite(numeric) && numeric >= this.nextId) this.nextId = numeric + 1;

    return document;
  }

  get(id) {
    return this.documents.get(id);
  }

  has(id) {
    return this.documents.has(id);
  }

  getByKey(key) {
    const id = this.byKey.get(key);
    return id === undefined ? undefined : this.documents.get(id);
  }

  getByHash(hash) {
    const id = this.byHash.get(hash);
    return id === undefined ? undefined : this.documents.get(id);
  }

  /** Linear scan - only used by diagnostics, never on the search path. */
  findByUrl(url) {
    for (const document of this.documents.values()) {
      if (document.url === url) return document;
    }
    return undefined;
  }

  remove(id) {
    const document = this.documents.get(id);
    if (!document) return false;
    this.documents.delete(id);
    if (document.key && this.byKey.get(document.key) === id) this.byKey.delete(document.key);
    if (document.hash && this.byHash.get(document.hash) === id) this.byHash.delete(document.hash);
    return true;
  }

  clear() {
    this.documents.clear();
    this.byKey.clear();
    this.byHash.clear();
    this.nextId = 1;
  }

  values() {
    return this.documents.values();
  }

  ids() {
    return this.documents.keys();
  }

  /** Host histogram for the dashboard. */
  hostHistogram(limit = 10) {
    const counts = new Map();
    for (const document of this.documents.values()) {
      const host = document.host ?? 'unknown';
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([host, count]) => ({ host, count }));
  }

  stats() {
    let storedTextBytes = 0;
    let withDescription = 0;
    for (const document of this.documents.values()) {
      storedTextBytes += document.text ? document.text.length : 0;
      if (document.description) withDescription += 1;
    }
    return {
      documents: this.documents.size,
      uniqueUrls: this.byKey.size,
      uniqueContentHashes: this.byHash.size,
      storedTextChars: storedTextBytes,
      withDescription,
      nextId: this.nextId,
    };
  }

  /** Streaming serialiser - one document per fragment. */
  *serialize() {
    yield `{"version":${STORE_FORMAT_VERSION},"nextId":${this.nextId},"documents":[`;
    let first = true;
    let buffer = '';
    for (const document of this.documents.values()) {
      const projected = {};
      for (const field of DOCUMENT_FIELDS) {
        if (document[field] !== undefined) projected[field] = document[field];
      }
      buffer += `${first ? '' : ','}${JSON.stringify(projected)}`;
      first = false;
      if (buffer.length > 128 * 1024) {
        yield buffer;
        buffer = '';
      }
    }
    if (buffer) yield buffer;
    yield ']}';
  }

  toJSON() {
    let json = '';
    for (const chunk of this.serialize()) json += chunk;
    return JSON.parse(json);
  }

  static fromJSON(data) {
    const store = new DocumentStore();
    if (!data || !Array.isArray(data.documents)) return store;
    for (const document of data.documents) {
      if (!document || typeof document.id !== 'string' || typeof document.url !== 'string') continue;
      store.put(document);
    }
    if (Number.isFinite(data.nextId) && data.nextId > store.nextId) store.nextId = data.nextId;
    return store;
  }
}

export default DocumentStore;
