'use strict';
/** Small helpers with no Deplao dependency (usable in tests). */

const crypto = require('crypto');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} quá ${Math.round(ms / 1000)} giây`);
    this.name = 'TimeoutError';
    this.code = 'TIMEOUT';
  }
}

/** Races a promise against a timer → TimeoutError (the original promise keeps running; we just stop waiting). */
function withTimeout(promise, ms, label = 'Thao tác') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), Math.max(1, ms));
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Timeout errors: the plugin's TimeoutError, or a Deplao http.fetch error (Deplao wraps a timeout as
 * UPSTREAM_ERROR "http.fetch: Quá thời gian …", Vietnamese for "timed out").
 */
function isTimeoutError(err) {
  if (!err) return false;
  if (err.code === 'TIMEOUT' || err.name === 'TimeoutError') return true;
  return /quá thời gian|timed? ?out|timeout/i.test(String(err.message || ''));
}

/** Time budget for one processing run. */
function createDeadline(totalMs, now = Date.now) {
  const end = now() + totalMs;
  return {
    remaining: () => Math.max(0, end - now()),
    expired: () => now() >= end,
  };
}

function truncate(value, max) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

/** Single line, control characters removed, length capped; for strings that come from users / AI. */
function cleanLine(value, max) {
  if (value === null || value === undefined) return '';
  // eslint-disable-next-line no-control-regex
  const s = String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return truncate(s, max);
}

/** Random base64url secret (≥ 32 bytes per CONTRACTS §2.1). */
function randomSecret(bytes = 32) {
  return crypto.randomBytes(Math.max(32, bytes)).toString('base64url');
}

function safeJsonParse(text) {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Error message of a FinTrack body: { error: "…" } (regular route) or { error: { message } } (integration route). */
function bodyError(body, max = 300) {
  const e = isPlainObject(body) ? body.error : null;
  return cleanLine(typeof e === 'string' ? e : isPlainObject(e) ? e.message : '', max);
}

/** deplao.http.fetch response body ({ text } or { base64 }) → UTF-8 string. */
function responseText(res) {
  if (typeof res?.text === 'string') return res.text;
  return typeof res?.base64 === 'string' ? Buffer.from(res.base64, 'base64').toString('utf8') : '';
}

/** Host of a URL (for error messages); an invalid URL → the raw string. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || '');
  }
}

/**
 * Normalizes a FinTrack URL: https only (http only for localhost during development), no user/pass,
 * query/hash and trailing "/" removed. Invalid → ''.
 */
function normalizeBaseUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let u;
  try {
    u = new URL(text);
  } catch {
    return '';
  }
  if (u.username || u.password) return '';
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return '';
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.origin}${path}`;
}

/** "acme.workers.dev" or "acme" → https://<worker>.acme.workers.dev ('' if invalid). */
function workersDevUrl(subdomain, workerName = 'fintrack') {
  const s = String(subdomain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!s || !/^[a-z0-9.-]+$/.test(s)) return '';
  return `https://${workerName}.${s.endsWith('.workers.dev') ? s : `${s}.workers.dev`}`;
}

/** Compares "a.b.c" versions (suffix after "-" ignored): < 0 if a < b, 0 if equal, > 0 if a > b; malformed → 0. */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^\d+(\.\d+){0,2}/.exec(String(v || '').trim());
    return m ? m[0].split('.').map(Number) : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** The plugin's fixed UUID namespace (for deterministic UUID v5). */
const UUID_NAMESPACE = '6f2b8a0e-4c1d-5e7a-9b3f-1d2c3e4f5a6b';

/**
 * Deterministic UUID v5 (RFC 4122/9562) from a string: same name → same UUID; version nibble 5, variant 10xx.
 * Used as the FinTrack assistant's conversationId for each Zalo group (FinTrack validates it with zod uuid).
 */
function uuidFromName(name, namespace = UUID_NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(ns).update(String(name), 'utf8').digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Simple serial queue (in-process lock) for storage read-modify-write operations. Not re-entrant: a function running
 * inside the lock must not call the same lock again (it would wait forever).
 */
function createMutex() {
  let tail = Promise.resolve();
  return function run(fn) {
    const next = tail.then(() => fn());
    tail = next.catch(() => undefined);
    return next;
  };
}

module.exports = {
  sleep,
  withTimeout,
  isTimeoutError,
  createDeadline,
  truncate,
  cleanLine,
  randomSecret,
  safeJsonParse,
  isPlainObject,
  bodyError,
  responseText,
  hostOf,
  normalizeBaseUrl,
  workersDevUrl,
  compareVersions,
  createMutex,
  uuidFromName,
};
