/**
 * Persistence primitives.
 *
 * Requirements that shaped this file:
 *   - a half-written index must never replace a good one  -> write to `.tmp`
 *     and `rename` (atomic within a filesystem)
 *   - a corrupt file must not prevent startup             -> quarantine + warn
 *   - serialising a large index must not stall the server -> accept an
 *     iterable of fragments and await each write, which yields to the loop
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function fileSize(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically write JSON.
 *
 * @param {string} filePath
 * @param {string|object|Iterable<string>|AsyncIterable<string>} source
 *        A string / object is stringified in one go; an iterable of fragments
 *        (see `InvertedIndex.serialize`) is streamed fragment by fragment.
 * @returns {Promise<{bytes:number, durationMs:number}>}
 */
export async function writeJsonAtomic(filePath, source) {
  const tmpPath = `${filePath}.tmp`;
  await ensureDir(path.dirname(filePath));

  const startedAt = performance.now();
  let bytes = 0;
  let handle;

  try {
    handle = await fs.open(tmpPath, 'w');

    if (typeof source === 'string') {
      bytes = Buffer.byteLength(source);
      await handle.writeFile(source, 'utf8');
    } else if (source && (typeof source[Symbol.iterator] === 'function' ||
                          typeof source[Symbol.asyncIterator] === 'function')) {
      // Batch small fragments so we do not issue thousands of tiny writes.
      let batch = '';
      for await (const fragment of source) {
        batch += fragment;
        if (batch.length >= 256 * 1024) {
          bytes += Buffer.byteLength(batch);
          await handle.write(batch, null, 'utf8');
          batch = '';
        }
      }
      if (batch) {
        bytes += Buffer.byteLength(batch);
        await handle.write(batch, null, 'utf8');
      }
    } else {
      const json = JSON.stringify(source);
      bytes = Buffer.byteLength(json);
      await handle.writeFile(json, 'utf8');
    }

    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch { /* ignore */ }
    }
    try {
      await fs.rm(tmpPath, { force: true });
    } catch { /* ignore */ }
    throw error;
  }

  return { bytes, durationMs: performance.now() - startedAt };
}

/**
 * Read and parse JSON, surviving both "file is not there" and "file is junk".
 *
 * @param {string} filePath
 * @param {{ quarantine?: boolean, now?: number }} [options]
 * @returns {Promise<{data: any, missing: boolean, corrupt: boolean,
 *                    error: Error|null, bytes: number, quarantinedTo: string|null}>}
 */
export async function readJsonSafe(filePath, { quarantine = true, now = Date.now() } = {}) {
  const result = {
    data: null, missing: false, corrupt: false, error: null, bytes: 0, quarantinedTo: null,
  };

  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
    result.bytes = Buffer.byteLength(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      result.missing = true;
    } else {
      result.error = error;
      result.corrupt = true;
    }
    return result;
  }

  if (raw.trim() === '') {
    result.corrupt = true;
    result.error = new Error('file is empty');
  } else {
    try {
      result.data = JSON.parse(raw);
    } catch (error) {
      result.corrupt = true;
      result.error = error;
    }
  }

  if (result.corrupt && quarantine) {
    const target = `${filePath}.corrupt-${now}`;
    try {
      await fs.rename(filePath, target);
      result.quarantinedTo = target;
    } catch { /* best effort */ }
  }

  return result;
}

/** Remove generated artefacts (used by `clear()` and tests). */
export async function removeFiles(filePaths) {
  await Promise.all(
    filePaths.map(async (filePath) => {
      try {
        await fs.rm(filePath, { force: true });
      } catch { /* ignore */ }
    }),
  );
}
