/**
 * Minimal structured logger (no dependencies).
 *
 * - `pretty` output for local development (aligned, coloured when on a TTY)
 * - `json` output for production, one object per line, ready for log shipping
 * - child loggers carry bindings (e.g. `{ module: 'crawler', workerId: 3 }`)
 *
 * Errors are serialised explicitly because `JSON.stringify(new Error())` is
 * `{}`, which is the single most common logging bug in Node services.
 */

import { config } from '../config/config.js';

export const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const COLORS = {
  error: '\u001b[31m',
  warn: '\u001b[33m',
  info: '\u001b[36m',
  debug: '\u001b[90m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  reset: '\u001b[0m',
};

function serializeError(error) {
  if (!(error instanceof Error)) return error;
  const out = { name: error.name, message: error.message };
  if (error.code) out.code = error.code;
  if (error.status) out.status = error.status;
  if (error.cause instanceof Error) out.cause = serializeError(error.cause);
  else if (error.cause !== undefined) out.cause = error.cause;
  if (config.env !== 'production' && error.stack) {
    out.stack = error.stack.split('\n').slice(1, 4).map((line) => line.trim());
  }
  return out;
}

function normalizeFields(fields) {
  if (!fields) return undefined;
  if (fields instanceof Error) return { error: serializeError(fields) };
  const out = {};
  let hasKeys = false;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = value instanceof Error ? serializeError(value) : value;
    hasKeys = true;
  }
  return hasKeys ? out : undefined;
}

export class Logger {
  /**
   * @param {object} [options]
   * @param {keyof LEVELS} [options.level]
   * @param {'json'|'pretty'} [options.format]
   * @param {object} [options.bindings]
   * @param {{ write(chunk: string): unknown }} [options.stream]
   */
  constructor({ level, format, bindings = {}, stream } = {}) {
    this.level = level ?? config.log.level;
    this.format = format ?? config.log.format;
    this.bindings = bindings;
    this.stream = stream ?? process.stdout;
    this.threshold = LEVELS[this.level] ?? LEVELS.info;
    this.colors = this.format === 'pretty' && Boolean(this.stream.isTTY);
  }

  child(bindings) {
    return new Logger({
      level: this.level,
      format: this.format,
      bindings: { ...this.bindings, ...bindings },
      stream: this.stream,
    });
  }

  isEnabled(level) {
    return (LEVELS[level] ?? LEVELS.info) <= this.threshold;
  }

  setLevel(level) {
    if (LEVELS[level] === undefined) return false;
    this.level = level;
    this.threshold = LEVELS[level];
    return true;
  }

  error(message, fields) {
    this.#log('error', message, fields);
  }

  warn(message, fields) {
    this.#log('warn', message, fields);
  }

  info(message, fields) {
    this.#log('info', message, fields);
  }

  debug(message, fields) {
    this.#log('debug', message, fields);
  }

  #log(level, message, fields) {
    if (!this.isEnabled(level)) return;

    // Allow `logger.error(error)` as a shorthand.
    if (message instanceof Error) {
      fields = { ...(normalizeFields(fields) ?? {}), error: serializeError(message) };
      message = message.message;
    }

    const payload = normalizeFields({ ...this.bindings, ...(fields ?? {}) });
    const time = new Date();

    let line;
    if (this.format === 'json') {
      line = JSON.stringify({ time: time.toISOString(), level, msg: String(message), ...payload });
    } else {
      line = this.#pretty(level, time, String(message), payload);
    }

    try {
      this.stream.write(`${line}\n`);
    } catch {
      /* never let logging take the process down */
    }
  }

  #pretty(level, time, message, payload) {
    const stamp = time.toISOString().slice(11, 23);
    const label = level.toUpperCase().padEnd(5);
    const scope = payload?.module ? ` ${payload.module}` : '';
    const rest = payload ? { ...payload } : undefined;
    if (rest) delete rest.module;

    const detail = rest && Object.keys(rest).length ? ` ${formatFields(rest)}` : '';

    if (!this.colors) return `${stamp} ${label}${scope} ${message}${detail}`;

    const color = COLORS[level] ?? '';
    return (
      `${COLORS.dim}${stamp}${COLORS.reset} ` +
      `${color}${label}${COLORS.reset}` +
      `${scope ? `${COLORS.bold}${scope}${COLORS.reset}` : ''} ` +
      `${message}` +
      `${detail ? `${COLORS.dim}${detail}${COLORS.reset}` : ''}`
    );
  }
}

function formatFields(fields) {
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    let rendered;
    if (value === null) rendered = 'null';
    else if (typeof value === 'object') rendered = JSON.stringify(value);
    else if (typeof value === 'string' && /\s/.test(value)) rendered = JSON.stringify(value);
    else rendered = String(value);
    parts.push(`${key}=${rendered}`);
  }
  return parts.join(' ');
}

/** Discards everything - handy in tests. */
export const silentLogger = new Logger({ level: 'silent', stream: { write() {} } });

export const logger = new Logger();
export default logger;
