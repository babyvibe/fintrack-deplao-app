'use strict';
/**
 * Client for FinTrack's integration API (docs/CONTRACTS.md §2.1–2.2) over deplao.http.fetch:
 * health, workspaces, session (workspace owner session), createAccount, transcribe. Regular routes go through
 * lib/proxy.js.
 *
 *  - Authorization: Bearer <secret>; X-FinTrack-Workspace when acting inside a workspace.
 *  - Errors → FinTrackError { code, status, serverCode, serverMessage, message } with a Vietnamese message; never
 *    contains the secret.
 */

const { USER_AGENT, TIMEOUTS } = require('./constants');
const { normalizeBaseUrl, safeJsonParse, responseText, hostOf, isTimeoutError } = require('./util');

class FinTrackError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'FinTrackError';
    this.code = code;
    this.status = status || 0;
  }
}

/** Error codes by FinTrack HTTP status (shared by integration and regular routes). */
const HTTP_ERROR_CODES = Object.freeze({
  400: 'FT_BAD_REQUEST',
  401: 'FT_UNAUTHORIZED',
  403: 'FT_FORBIDDEN',
  404: 'FT_NOT_FOUND',
  409: 'FT_CONFLICT',
  413: 'FT_TOO_LARGE',
  422: 'FT_UNPROCESSABLE',
  429: 'FT_RATE_LIMITED',
});

const httpErrorCode = (status) => HTTP_ERROR_CODES[status] || (status >= 500 ? 'FT_SERVER' : 'FT_HTTP');

/** Plain message per HTTP status; appends FinTrack's message when present (it is already user-facing). */
function messageFor(status, serverMessage, host) {
  const extra = serverMessage ? ` (${String(serverMessage).slice(0, 200)})` : '';
  switch (status) {
    case 400: return `FinTrack không nhận dữ liệu${extra}.`;
    case 401: return 'FinTrack từ chối secret tích hợp. Triển khai lại ở trang Tuỳ chọn để đặt lại secret (hoặc kiểm tra Secret trong Cài đặt ứng dụng).';
    case 403: return `FinTrack không cho phép thao tác này${extra}.`;
    case 404: return `FinTrack không tìm thấy dữ liệu${extra}.`;
    case 413: return 'Dữ liệu gửi FinTrack quá lớn (ghi âm tối đa 5 MB).';
    case 422: return `FinTrack không xử lý được dữ liệu${extra}.`;
    case 429: return `FinTrack đang giới hạn tần suất${extra}. Thử lại sau.`;
    default:
      if (status >= 500) return `FinTrack (${host}) đang lỗi ${status}${extra}. Thử lại sau.`;
      return `FinTrack trả lỗi ${status}${extra}.`;
  }
}

function cleanServerMessage(v) {
  return typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 300) : '';
}

/**
 * @param {object} opts
 * @param {(url: string, init: object) => Promise<{status:number,text?:string,base64?:string,truncated?:boolean}>} opts.fetch  deplao.http.fetch
 * @param {string} opts.baseUrl
 * @param {string} opts.secret
 * @param {string} [opts.workspaceId]
 */
function createFinTrackClient({ fetch, baseUrl, secret, workspaceId, timeoutMs = TIMEOUTS.INTEGRATION }) {
  const base = normalizeBaseUrl(baseUrl);
  const host = hostOf(base);

  async function request(method, path, { body, workspace = true, timeout = timeoutMs } = {}) {
    if (!base) throw new FinTrackError('FT_NOT_CONFIGURED', 'Chưa có địa chỉ FinTrack. Triển khai ở trang Tuỳ chọn (hoặc nhập Địa chỉ FinTrack trong Cài đặt ứng dụng).');
    if (!secret) throw new FinTrackError('FT_NOT_CONFIGURED', 'Chưa có secret tích hợp. Triển khai FinTrack ở trang Tuỳ chọn.');
    if (workspace && !workspaceId) throw new FinTrackError('FT_NO_WORKSPACE', 'Chưa mở tài khoản FinTrack nào.');
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${secret}`,
      'User-Agent': USER_AGENT,
    };
    if (workspace) headers['X-FinTrack-Workspace'] = String(workspaceId);
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(`${base}${path}`, { method, headers, body: payload, timeoutMs: timeout });
    } catch (err) {
      const timedOut = isTimeoutError(err);
      throw new FinTrackError(timedOut ? 'FT_TIMEOUT' : 'FT_NETWORK', `FinTrack (${host}) ${timedOut ? 'trả lời quá lâu' : 'không kết nối được'}. Kiểm tra Worker đã chạy và địa chỉ đúng.`);
    }
    const status = Number(res && res.status) || 0;
    const json = safeJsonParse(responseText(res));
    if (status >= 200 && status < 300) {
      if (json === undefined) throw new FinTrackError('FT_BAD_RESPONSE', `FinTrack (${host}) trả dữ liệu không đọc được. Có thể địa chỉ không phải FinTrack hoặc FinTrack là bản cũ.`, status);
      return json;
    }
    const serverError = json && typeof json === 'object' ? json.error : null;
    const serverCode = serverError && typeof serverError === 'object' ? String(serverError.code || '') : '';
    const serverMessage = serverError && typeof serverError === 'object' ? serverError.message : typeof serverError === 'string' ? serverError : '';
    const err = new FinTrackError(httpErrorCode(status), messageFor(status, serverMessage, host), status);
    err.serverCode = serverCode;
    /** FinTrack's message (already user-facing); the sign-up form shows it as is. */
    err.serverMessage = cleanServerMessage(serverMessage);
    // Older FinTrack Worker without this route: a 404 with no { error } body or with code not_found, or a 400
    // workspace_required for a route that needs no workspace.
    const outdated = (status === 404 && (!serverError || serverCode === 'not_found'))
      || (status === 400 && serverCode === 'workspace_required' && !workspace);
    if (outdated) {
      err.code = 'FT_NO_INTEGRATION';
      err.message = `FinTrack ở ${host} là bản cũ, chưa có API này. Bấm “Cập nhật FinTrack” ở trang Tuỳ chọn (dữ liệu giữ nguyên).`;
    }
    throw err;
  }

  const t = (opts, fallback) => Math.max(1000, Math.min(Number(opts && opts.timeout) || fallback, 120_000));

  return {
    baseUrl: base,
    /** { ok, version, speechAvailable }; no workspace needed. */
    health: (opts) => request('GET', '/api/integration/health', { workspace: false, timeout: t(opts, TIMEOUTS.HEALTH) }),
    /** [{ id, name, ownerEmail, currency }] */
    workspaces: async (opts) => {
      const data = await request('GET', '/api/integration/workspaces', { workspace: false, timeout: t(opts, timeoutMs) });
      return Array.isArray(data) ? data : Array.isArray(data?.workspaces) ? data.workspaces : [];
    },
    /** Sign-in session of the workspace owner → { token, expiresAt, user } */
    session: (opts) => request('POST', '/api/integration/session', { body: {}, timeout: t(opts, timeoutMs) }),
    /** { audio: base64, mime } → { text, model } */
    transcribe: ({ audio, mime }, opts) => request('POST', '/api/integration/transcribe', { body: { audio, mime }, timeout: t(opts, TIMEOUTS.TRANSCRIBE) }),
    /** Creates a FinTrack account (with its own workspace) from Deplao → { user, session: { token, expiresAt } }. */
    createAccount: ({ email, displayName, password }, opts) => request('POST', '/api/integration/accounts', { body: { email, displayName, password }, workspace: false, timeout: t(opts, timeoutMs) }),
  };
}

module.exports = { createFinTrackClient, httpErrorCode };
