'use strict';
/**
 * Proxy from the FinTrack UI (and the workflow nodes) → the user's FinTrack Worker (CONTRACTS §3.2–3.3).
 *
 *  - Regular routes only (relative to /api); /integration/* is blocked (403), the integration secret is NEVER sent.
 *  - Sessions per account (workspace): the UI uses the open account; workflow nodes and draft commands pass their
 *    account (opts.workspaceId). Missing / expired → POST /api/integration/session, only for accounts remembered on
 *    this Deplao. No account open yet → send without a cookie so FinTrack shows its sign-in / sign-up screen (on first
 *    use, if FinTrack has exactly one account and the user never signed out → open that account automatically).
 *  - Headers (ASCII only): Cookie fintrack_session (URI-encoded token), X-FinTrack-Client: deplao; /assistant/* also
 *    gets X-FinTrack-AI: deplao | fintrack and X-FinTrack-Assistant: encodeURIComponent(<Deplao assistant name>).
 *  - set-cookie (sign-up / sign-in / sign-out) → store / clear the token of that account; signing out in the UI =
 *    signing out on Deplao (no automatic sign-in afterwards).
 *  - 401 while using a session → mint a new session once (if allowed) and resend.
 *  - 428 code "delegate" → aiChat(raw_system) → resend with delegated { output, model, usage };
 *    502 code "bad_output" → ask the assistant once more (JSON only) if time allows.
 */

const C = require('./constants');
const state = require('./state');
const { PluginError, describeError } = require('./errors');
const { createFinTrackClient } = require('./fintrackClient');
const { safeJsonParse, cleanLine, withTimeout, isPlainObject, responseText, hostOf, isTimeoutError } = require('./util');

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const NO_RETRY_401 = /^\/auth\/(login|register)(?:$|[/?])/;
const SIGN_IN = /^\/auth\/(login|register)(?:$|\?)/;
const SIGN_OUT = /^\/auth\/logout(?:$|\?)/;
const ASSISTANT_PATH = /^\/assistant\//;
const JSON_ONLY = 'Câu trả lời vừa rồi không dùng được. Chỉ trả về đúng MỘT object JSON hợp lệ theo JSON schema đã cho, không markdown, không thêm chữ nào khác.';

const minting = new Map(); // workspaceId → Promise of the session being minted
const assistantCache = new Map(); // chosen Deplao assistant id ('' = default) → { at, value }
let autoLinkCheckedAt = 0; // time of the last failed attempt to open an account automatically (0 or ≥ 2 accounts)

/** Validate a UI request → { method, path, blocked }. Invalid → PluginError VALIDATION_ERROR. */
function validateRequest(req) {
  const method = String(req?.method || 'GET').toUpperCase();
  if (!METHODS.has(method)) throw new PluginError('VALIDATION_ERROR', 'Phương thức API không hợp lệ.');
  const path = req?.path;
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.length > 2000 || /[\x00-\x1f\x7f\\#]/.test(path)) {
    throw new PluginError('VALIDATION_ERROR', 'Đường dẫn API không hợp lệ.');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(path.split('?')[0]);
  } catch {
    throw new PluginError('VALIDATION_ERROR', 'Đường dẫn API không hợp lệ.');
  }
  if (pathname.split('/').some((seg) => seg === '..' || seg === '.')) throw new PluginError('VALIDATION_ERROR', 'Đường dẫn API không hợp lệ.');
  const blocked = /^\/+integration(\/|$)/i.test(pathname);
  return { method, path, blocked };
}

// ─── AI assistant ────────────────────────────────────────────────────────────

/**
 * Deplao assistants to choose from (listAiAssistantOptions, scope ai:use: name / platform / model only).
 * null = this Deplao version lacks the function (only the default assistant can be used).
 */
async function listAssistantOptions(deplao) {
  let list;
  try {
    list = await withTimeout(deplao.ai.listAiAssistantOptions(), C.TIMEOUTS.AI_LIST, 'Trợ lý AI');
  } catch (err) {
    if (err && err.code === 'NOT_FOUND') return null;
    throw err;
  }
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && a.id !== undefined && a.id !== null && a.id !== '')
    .map((a) => ({
      id: String(a.id),
      name: cleanLine(a.name || a.id, 80),
      platform: cleanLine(a.platform || '', 40),
      model: cleanLine(a.model || '', 100),
      enabled: a.enabled !== false,
      isDefault: !!a.is_default,
    }));
}

function assistantValue(a, chosen) {
  // Node http rejects header values outside Latin-1 → the (Vietnamese) name goes percent-encoded; FinTrack decodes it.
  return {
    id: String(a.id),
    name: cleanLine(a.name || '', 80),
    model: cleanLine(a.model || '', 100),
    platform: cleanLine(a.platform || '', 40),
    enabled: a.enabled !== false,
    chosen,
    header: encodeURIComponent(cleanLine(a.name || '', 80)),
  };
}

/**
 * Deplao AI assistant for a choice: the chosen id (if still in Deplao) or Deplao's default assistant. The result is
 * cached 5 minutes; a failed lookup (Deplao busy, timeout) is not cached, so the next call retries. `chosen` = send
 * assistant_id when calling aiChat.
 */
async function deplaoAssistant(deplao, pickedId = '') {
  const key = String(pickedId || '');
  const hit = assistantCache.get(key);
  if (hit && Date.now() - hit.at < C.ASSISTANT_TTL_MS) return hit.value;
  let value = null;
  try {
    if (key) {
      const list = await listAssistantOptions(deplao);
      const a = list && list.find((x) => x.id === key);
      if (a) value = assistantValue(a, true);
    }
    if (!value) {
      const a = await withTimeout(deplao.ai.getDefaultAiAssistant(), C.TIMEOUTS.AI_LIST, 'Trợ lý AI');
      if (a && a.id) value = assistantValue(a, false);
    }
  } catch {
    return null;
  }
  assistantCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Assistant that answers for an account: { source: 'fintrack' } (FinTrack's own assistant) or
 * { source: 'deplao', assistant }. A workflow node set to its own Deplao assistant (assistantId) that still exists in
 * Deplao → always that one; otherwise → the account's choice.
 */
async function aiFor(deplao, workspaceId, overrideId) {
  if (overrideId) {
    const a = await deplaoAssistant(deplao, overrideId);
    if (a && a.chosen) return { source: 'deplao', assistant: a };
  }
  const choice = await state.getAiChoice(deplao, workspaceId);
  if (choice.source === 'fintrack') return { source: 'fintrack', assistant: null };
  return { source: 'deplao', assistant: await deplaoAssistant(deplao, choice.id) };
}

function resetAssistantCache() {
  assistantCache.clear();
}

function resetCaches() {
  resetAssistantCache();
  minting.clear();
  autoLinkCheckedAt = 0;
}

// ─── Sessions ────────────────────────────────────────────────────────────────

/** May mint a session with the secret: only accounts remembered on this Deplao. */
async function canMint(deplao, workspaceId) {
  if (!workspaceId) return false;
  const accounts = await state.listAccounts(deplao);
  return accounts.some((a) => a.workspaceId === workspaceId);
}

/** Mint a workspace-owner session with the integration secret (one request at a time per workspace). */
function mintSession(deplao, cfg, workspaceId, timeout) {
  if (minting.has(workspaceId)) return minting.get(workspaceId);
  const p = (async () => {
    let minted;
    try {
      minted = await createFinTrackClient({ fetch: deplao.http.fetch, baseUrl: cfg.baseUrl, secret: cfg.secret, workspaceId }).session({ timeout });
    } catch (err) {
      if (err && err.code === 'FT_NOT_FOUND' && err.serverCode === 'workspace_not_found') {
        // The account no longer exists in FinTrack → drop it from the remembered list / as the open account.
        await state.forgetAccount(deplao, workspaceId).catch(() => undefined);
        const active = await state.getActive(deplao);
        if (active && active.id === workspaceId) await state.setActive(deplao, null);
        throw new PluginError('WORKSPACE_GONE', 'Tài khoản FinTrack này không còn. Đăng nhập tài khoản khác.');
      }
      throw err;
    }
    if (!minted || typeof minted.token !== 'string' || !minted.token) throw new PluginError('FT_BAD_RESPONSE', 'FinTrack không trả phiên đăng nhập.');
    const expiresAt = Date.parse(minted.expiresAt) || Date.now() + C.SESSION_DAYS_MS;
    await state.setSession(deplao, { token: minted.token, expiresAt, workspaceId });
    return { token: minted.token, expiresAt, workspaceId };
  })().finally(() => minting.delete(workspaceId));
  minting.set(workspaceId, p);
  return p;
}

/**
 * First use (no remembered account, never signed out) and FinTrack has exactly one account → open that account right
 * away (automatic sign-in). Not possible (0 or ≥ 2 accounts, FinTrack error) → '' and ask again only after
 * AUTO_LINK_RECHECK_MS.
 */
async function autoLink(deplao, cfg) {
  if (Date.now() - autoLinkCheckedAt < C.AUTO_LINK_RECHECK_MS) return '';
  if (await state.isSignedOut(deplao)) return '';
  if ((await state.listAccounts(deplao)).length) return '';
  let list;
  try {
    list = await createFinTrackClient({ fetch: deplao.http.fetch, baseUrl: cfg.baseUrl, secret: cfg.secret }).workspaces({ timeout: C.TIMEOUTS.WORKSPACES });
  } catch (err) {
    console.warn(`[fintrack] Không tự mở được tài khoản: ${describeError(err).message}`);
    list = [];
  }
  if (list.length !== 1 || !list[0] || list[0].id === undefined || list[0].id === null) {
    autoLinkCheckedAt = Date.now();
    return '';
  }
  const w = list[0];
  const account = { workspaceId: String(w.id), name: String(w.name || ''), email: String(w.ownerEmail || '') };
  await state.rememberAccount(deplao, account);
  await state.setActive(deplao, account);
  return account.workspaceId;
}

/**
 * The UI stops using the open account (session expired and cannot be re-minted, account disabled…): like signing out,
 * without calling FinTrack.
 */
async function dropActive(deplao) {
  await state.setActive(deplao, null);
  await state.setSignedOut(deplao, true);
}

/**
 * Session for a request → { token, workspaceId }; token null = send without a cookie.
 *  - workspaceId: the given account (workflow node, draft command).
 *  - none: the account open in the UI. A non-remembered account whose session expired, or a disabled account owner →
 *    treated as signed out (FinTrack shows its sign-in screen).
 *  - staleToken: token that just got a 401, skip it; a different stored session (just minted by another request) is
 *    used as is.
 *  - timeout: limit for minting the session (ms), defaults to the integration client's.
 */
async function ensureSession(deplao, cfg, { workspaceId = '', staleToken = '', timeout } = {}) {
  const ui = !workspaceId;
  let wsId = workspaceId;
  if (ui) {
    const active = await state.getActive(deplao);
    wsId = active ? active.id : await autoLink(deplao, cfg);
    if (!wsId) return { token: null, workspaceId: '' };
  }
  const s = await state.getSession(deplao, wsId);
  if (s && s.token !== staleToken && s.expiresAt > Date.now() + C.SESSION_SKEW_MS) return s;
  if (!(await canMint(deplao, wsId))) {
    if (ui) await dropActive(deplao);
    return { token: null, workspaceId: ui ? '' : wsId };
  }
  try {
    return await mintSession(deplao, cfg, wsId, timeout);
  } catch (err) {
    if (ui && err && err.code === 'FT_FORBIDDEN' && err.serverCode === 'account_disabled') {
      await dropActive(deplao);
      return { token: null, workspaceId: '' };
    }
    throw err;
  }
}

/** The response's fintrack_session set-cookie → { token, expiresAt } | { cleared: true } | null. */
function readSessionCookie(headers) {
  const raw = headers ? headers['set-cookie'] ?? headers['Set-Cookie'] : undefined;
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  for (const line of list) {
    const parts = String(line).split(';').map((p) => p.trim());
    const [name, ...rest] = parts[0].split('=');
    if (name !== C.SESSION_COOKIE) continue;
    let value = rest.join('=');
    try { value = decodeURIComponent(value); } catch { /* keep as is */ }
    const maxAgePart = parts.find((p) => /^max-age=/i.test(p));
    const maxAge = maxAgePart ? Number(maxAgePart.split('=')[1]) : NaN;
    if (!value || maxAge === 0) return { cleared: true };
    return { token: value, expiresAt: Date.now() + (maxAge > 0 ? maxAge * 1000 : C.SESSION_DAYS_MS) };
  }
  return null;
}

/** One request to the Worker → { status, json, headers, cookie }. */
async function send(deplao, cfg, { method, path, body, token, ai, timeoutMs = C.TIMEOUTS.FINTRACK }) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': C.USER_AGENT,
    [C.CLIENT_HEADER]: 'deplao',
  };
  if (ai) {
    headers[C.AI_HEADER] = ai.source === 'fintrack' ? 'fintrack' : 'deplao';
    if (ai.source !== 'fintrack' && ai.assistant && ai.assistant.header) headers[C.ASSISTANT_HEADER] = ai.assistant.header;
  }
  if (token) headers.Cookie = `${C.SESSION_COOKIE}=${encodeURIComponent(token)}`;
  let payload;
  if (body !== undefined && body !== null && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await deplao.http.fetch(`${cfg.baseUrl}/api${path}`, { method, headers, body: payload, timeoutMs, responseType: 'text' });
  } catch (err) {
    const timedOut = isTimeoutError(err);
    throw new PluginError(timedOut ? 'FT_TIMEOUT' : 'FT_NETWORK', timedOut ? 'FinTrack trả lời quá lâu. Thử lại sau.' : `Không kết nối được FinTrack (${hostOf(cfg.baseUrl)}). Kiểm tra mạng và trạng thái ở trang Tuỳ chọn.`);
  }
  if (res && res.truncated) {
    throw new PluginError('TOO_LARGE', 'Dữ liệu FinTrack trả về lớn hơn 5 MB nên không mở được trong Deplao. Việc này (vd sao lưu, xuất dữ liệu lớn) hãy làm trên FinTrack bằng trình duyệt.');
  }
  const status = Number(res && res.status) || 0;
  const text = responseText(res);
  let json = null;
  let finalStatus = status;
  if (text && text.trim()) {
    const parsed = safeJsonParse(text);
    if (parsed === undefined) {
      // HTML / plain text (older Worker, Cloudflare error page…) → a readable error for the UI. `code` lets the node
      // tell it apart from assistant errors (FinTrack's own 502 has JSON).
      json = { error: status >= 400 ? `FinTrack lỗi ${status}.` : 'FinTrack trả dữ liệu không đọc được.', code: 'bad_response' };
      if (status < 400) finalStatus = 502;
    } else {
      json = parsed;
    }
  }
  return { status: finalStatus, json, headers: res && res.headers, cookie: readSessionCookie(res && res.headers) };
}

/** FinTrack user in a sign-in / sign-up response → account { workspaceId, email, name } or null. */
function accountOf(user) {
  if (!isPlainObject(user) || !user.workspaceId) return null;
  return { workspaceId: String(user.workspaceId), email: cleanLine(user.email, 120), name: cleanLine(user.displayName, 80) };
}

/** Open an account in the UI: store the session, make it the open account, (un)remember it per `remember`. */
async function adoptAccount(deplao, account, session, { remember }) {
  await state.setSession(deplao, { token: session.token, expiresAt: session.expiresAt, workspaceId: account.workspaceId });
  await state.setActive(deplao, account);
  await state.setSignedOut(deplao, false);
  if (remember) await state.rememberAccount(deplao, account);
  else if (remember === false) await state.forgetAccount(deplao, account.workspaceId);
}

/** Sign the open account out of Deplao: end the session in FinTrack, no automatic sign-in. It stays remembered. */
async function signOut(ctx) {
  const { deplao, settings } = ctx;
  const active = await state.getActive(deplao);
  if (active) {
    const cfg = await state.getFinTrackConfig(deplao, settings);
    const s = await state.getSession(deplao, active.id);
    if (cfg.baseUrl && s && s.token) {
      await send(deplao, cfg, { method: 'POST', path: '/auth/logout', body: {}, token: s.token, timeoutMs: C.TIMEOUTS.SESSION_CHECK }).catch(() => undefined);
    }
    await state.clearSession(deplao, active.id);
  }
  await dropActive(deplao);
}

// ─── Delegating to a Deplao assistant ────────────────────────────────────────

/** delegate messages → the shape aiChat accepts (≤ AI_MESSAGES_MAX messages, each ≤ AI_MESSAGE_CHARS characters). */
function cleanMessages(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content)
    .slice(-C.AI_MESSAGES_MAX)
    .map((m) => ({ role: m.role, content: m.content.slice(0, C.AI_MESSAGE_CHARS) }));
}

/** Time left for one step: per the node's deadline (if any), capped at the default, at least 3 s. */
function stepTimeout(deadline, fallback, reserve = 0) {
  return deadline ? Math.max(3000, Math.min(fallback, deadline.remaining() - reserve)) : fallback;
}

async function askDeplao(deplao, messages, maxTokens, { assistantId, deadline }) {
  const params = { messages, max_tokens: maxTokens, raw_system: true };
  if (assistantId) params.assistant_id = String(assistantId);
  // Keep ~8 s for resending to FinTrack after the assistant answers.
  const r = await withTimeout(deplao.ai.aiChat(params), stepTimeout(deadline, C.TIMEOUTS.DEPLAO_AI, 8000), 'Trợ lý AI của Deplao');
  // Tokens Deplao reports for this turn. FinTrack adds them to the assistant's usage shown under
  // "Cài đặt → Trợ lý AI" (Settings → AI assistant).
  const usage = { inputTokens: tokenCount(r?.prompt_tokens), outputTokens: tokenCount(r?.completion_tokens), totalTokens: tokenCount(r?.total_tokens) };
  return { output: String(r?.result ?? ''), usage };
}

const tokenCount = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.min(Math.round(Number(v)), 1e9) : 0);

/** Add up token usage across asks (the retry when the answer is not JSON). */
function addUsage(a, b) {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, totalTokens: a.totalTokens + b.totalTokens };
}

/** 428 delegate → call the Deplao assistant → resend with `delegated`. AI error → a readable 502 for the UI. */
async function delegate(deplao, cfg, req, delegateInfo, opts) {
  const messages = cleanMessages(delegateInfo && delegateInfo.messages);
  if (!messages.length) return { status: 502, json: { error: 'FinTrack gửi yêu cầu trợ lý không hợp lệ.', code: 'bad_delegate' } };
  const maxTokens = Math.min(C.AI_MAX_TOKENS, Math.max(1, Math.floor(Number(delegateInfo.maxTokens) || 4000)));
  const assistant = req.ai && req.ai.assistant;
  // A chosen assistant (set on the node / for the account) → send its id; Deplao's default → no id.
  const ask = { assistantId: assistant && assistant.chosen ? assistant.id : '', deadline: opts.deadline };
  const model = (assistant && assistant.model) || '';
  const resend = (output, usage) => send(deplao, cfg, {
    ...req,
    timeoutMs: stepTimeout(opts.deadline, req.timeoutMs || C.TIMEOUTS.FINTRACK),
    body: { ...(isPlainObject(req.body) ? req.body : {}), delegated: { output: String(output).slice(0, C.AI_OUTPUT_CHARS), ...(model ? { model: model.slice(0, 100) } : {}), usage } },
  });
  let output;
  let usage;
  try {
    ({ output, usage } = await askDeplao(deplao, messages, maxTokens, ask));
  } catch (err) {
    return aiFailure(err);
  }
  let res = await resend(output, usage);
  // Ask once more if the answer is not usable JSON, only when enough time is left (a workflow node gets ≤ 60 s).
  const timeLeft = !opts.deadline || opts.deadline.remaining() > 20_000;
  if (res.status === 502 && res.json && res.json.code === 'bad_output' && timeLeft) {
    try {
      const again = await askDeplao(deplao, [...messages, { role: 'assistant', content: output.slice(0, 20_000) || '(trống)' }, { role: 'user', content: JSON_ONLY }], maxTokens, ask);
      output = again.output;
      usage = addUsage(usage, again.usage);
    } catch (err) {
      return aiFailure(err);
    }
    res = await resend(output, usage);
  }
  return res;
}

function aiFailure(err) {
  const timeout = isTimeoutError(err);
  const why = timeout ? 'trả lời quá lâu' : describeError(err).message;
  return { status: 502, json: { error: `Trợ lý AI của Deplao ${timeout ? why : `lỗi: ${why}`}. Kiểm tra Tích hợp → Trợ lý AI trong Deplao rồi thử lại.`, code: 'deplao_ai' } };
}

// ─── Forwarding ──────────────────────────────────────────────────────────────

/**
 * Forward a UI / node request → { status, body }.
 * opts: { workspaceId (the given account: node, draft command), assistantId, deadline, timeoutMs }.
 * Plugin-side errors (not deployed, network, session…) → throws PluginError.
 */
async function forward(ctx, req, opts = {}) {
  const { deplao, settings } = ctx;
  const { method, path, blocked } = validateRequest(req);
  if (blocked) return { status: 403, body: { error: 'Không được gọi API tích hợp từ giao diện FinTrack.' } };
  const cfg = state.requireDeployed(await state.getFinTrackConfig(deplao, settings));
  const ui = !opts.workspaceId;
  if (ui && method === 'POST' && SIGN_OUT.test(path)) {
    await signOut(ctx);
    return { status: 204, body: null };
  }
  let session = await ensureSession(deplao, cfg, { workspaceId: opts.workspaceId || '' });
  // The assistant only matters for /assistant/* routes; other routes skip the lookup.
  const ai = ASSISTANT_PATH.test(path) ? await aiFor(deplao, session.workspaceId, opts.assistantId) : null;
  const base = { method, path, body: req.body, ai, timeoutMs: opts.timeoutMs };
  let res = await send(deplao, cfg, { ...base, token: session.token });
  if (res.status === 401 && session.token && !NO_RETRY_401.test(path)) {
    const stale = session.token;
    await state.clearSession(deplao, session.workspaceId, { token: stale });
    session = await ensureSession(deplao, cfg, { workspaceId: ui ? '' : session.workspaceId, staleToken: stale });
    if (session.token) res = await send(deplao, cfg, { ...base, token: session.token });
  }
  if (res.cookie) {
    const account = ui && method === 'POST' && SIGN_IN.test(path) && res.status < 300 && res.json ? accountOf(res.json.user) : null;
    if (account && res.cookie.token) {
      // Signed in through FinTrack's own form (not the login command): open the account; a sign-up (the owner's first
      // account) is remembered right away.
      await adoptAccount(deplao, account, res.cookie, { remember: /register/.test(path) ? true : undefined });
    } else if (res.cookie.token && session.workspaceId) {
      await state.setSession(deplao, { ...res.cookie, workspaceId: session.workspaceId });
    } else if (res.cookie.cleared && session.workspaceId) {
      await state.clearSession(deplao, session.workspaceId, { token: session.token || '' });
    }
  }
  if (res.status === 428 && res.json && res.json.code === 'delegate') {
    res = await delegate(deplao, cfg, { ...base, token: session.token }, res.json.delegate, opts);
  }
  return { status: res.status, body: res.json };
}

module.exports = {
  forward, validateRequest, ensureSession, send, accountOf, adoptAccount, signOut,
  aiFor, deplaoAssistant, listAssistantOptions, resetCaches, resetAssistantCache,
};
