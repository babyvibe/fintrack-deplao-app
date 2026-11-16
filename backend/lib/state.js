'use strict';
/**
 * Plugin state in deplao.storage (the plugin's own KV, stored in the Deplao workspace database on this machine). See
 * SECURITY.md for the integration secret and session tokens; the key list is in docs/ARCHITECTURE.md.
 *
 * A plain read (`get`) swallows errors → null. Every read-modify-write runs inside one lock (`lock`, not re-entrant)
 * and reads strictly (`read`): a failed read throws, since not writing beats overwriting data with an empty value.
 */

const { KEYS, SEEN_TTL_MS, SEEN_MAX, REPLIES_TTL_MS, REPLIES_MAX, ACCOUNTS_MAX } = require('./constants');
const { PluginError } = require('./errors');
const { normalizeBaseUrl, createMutex, cleanLine, isPlainObject } = require('./util');

const lock = createMutex();

async function get(deplao, key) {
  try {
    return await deplao.storage.get(key);
  } catch {
    return null;
  }
}

const read = (deplao, key) => deplao.storage.get(key);
const set = (deplao, key, value) => deplao.storage.set(key, value);
const del = (deplao, key) => deplao.storage.delete(key);

/** Secret: the app settings value (x-secret, encrypted by Deplao) wins over the one the plugin generated on deploy. */
async function getSecret(deplao, settings) {
  const fromSettings = typeof settings?.integrationSecret === 'string' ? settings.integrationSecret.trim() : '';
  if (fromSettings) return { secret: fromSettings, source: 'settings' };
  const stored = await get(deplao, KEYS.SECRET);
  return typeof stored === 'string' && stored ? { secret: stored, source: 'storage' } : { secret: '', source: 'none' };
}

/** Valid DNS name (lowercase, ≥ 2 labels), the same check Deplao applies to custom domains. */
const HOSTNAME_RE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Custom domain attached to the Worker: { hostname, zoneName, attachedAt, verifiedAt } or null. */
async function getDomain(deplao) {
  const d = await get(deplao, KEYS.DOMAIN);
  if (!isPlainObject(d) || typeof d.hostname !== 'string' || !HOSTNAME_RE.test(d.hostname)) return null;
  return { hostname: d.hostname, zoneName: cleanLine(d.zoneName, 253), attachedAt: Number(d.attachedAt) || 0, verifiedAt: Number(d.verifiedAt) || 0 };
}

function setDomain(deplao, domain) {
  if (!domain) return del(deplao, KEYS.DOMAIN).catch(() => undefined);
  return set(deplao, KEYS.DOMAIN, { hostname: domain.hostname, zoneName: domain.zoneName || '', attachedAt: Number(domain.attachedAt) || Date.now(), verifiedAt: Number(domain.verifiedAt) || 0 });
}

/**
 * FinTrack URL: the URL in the app settings (fintrackUrl) > a custom domain that has answered (verifiedAt) >
 * workers.dev of the latest deploy. `fallbackUrl` = that workers.dev URL when another URL is in use (to fall back /
 * report clearly when the URL in use does not answer). Also returns the secret and the open account.
 */
async function getFinTrackConfig(deplao, settings) {
  const [deploy, active, sec, domain] = await Promise.all([get(deplao, KEYS.DEPLOY), getActive(deplao), getSecret(deplao, settings), getDomain(deplao)]);
  const fromSettings = normalizeBaseUrl(settings?.fintrackUrl);
  const fromDomain = domain && domain.verifiedAt ? `https://${domain.hostname}` : '';
  const fromDeploy = normalizeBaseUrl(deploy?.url);
  const baseUrl = fromSettings || fromDomain || fromDeploy || '';
  return {
    baseUrl,
    urlSource: fromSettings ? 'settings' : fromDomain ? 'domain' : baseUrl ? 'deploy' : 'none',
    fallbackUrl: fromDeploy && fromDeploy !== baseUrl ? fromDeploy : '',
    secret: sec.secret,
    secretSource: sec.source,
    workspaceId: active ? active.id : '',
    workspace: active,
    deploy: deploy || null,
    domain,
  };
}

/** FinTrack config that has both URL and secret, otherwise PluginError NOT_DEPLOYED. */
function requireDeployed(cfg) {
  if (!cfg.baseUrl || !cfg.secret) throw new PluginError('NOT_DEPLOYED', 'FinTrack chưa được triển khai. Mở trang Tuỳ chọn của ứng dụng để triển khai.');
  return cfg;
}

// ─── FinTrack accounts on this Deplao ────────────────────────────────────────
//
// Each FinTrack account has its own workspace; everything is keyed by workspaceId.
//  - ACTIVE_ACCOUNT: the account open in the UI (absent before sign-in / after sign-out).
//  - ACCOUNTS: accounts with "Ghi nhớ mật khẩu" (remember password): quick switch without a password prompt (sessions
//    are minted again with the integration secret; the password is NOT stored).
//  - SESSIONS: sessions (fintrack_session cookie token) per workspace.

const accountView = (a) => ({ workspaceId: String(a.workspaceId || a.id || ''), email: cleanLine(a.email || a.ownerEmail, 120), name: cleanLine(a.name, 80) });
const normalizeAccounts = (raw) => raw.filter((a) => isPlainObject(a) && a.workspaceId).map((a) => ({ ...accountView(a), rememberedAt: Number(a.rememberedAt) || 0 }));

/** Open account: { id, name, email, linkedAt } or null. */
async function getActive(deplao) {
  const w = await get(deplao, KEYS.ACTIVE_ACCOUNT);
  return isPlainObject(w) && w.id ? { ...w, id: String(w.id), name: cleanLine(w.name, 80), email: cleanLine(w.email || w.ownerEmail, 120) } : null;
}

function setActive(deplao, account) {
  if (!account) return del(deplao, KEYS.ACTIVE_ACCOUNT).catch(() => undefined);
  const a = accountView(account);
  return set(deplao, KEYS.ACTIVE_ACCOUNT, { id: a.workspaceId, name: a.name, email: a.email, linkedAt: Date.now() });
}

const isSignedOut = async (deplao) => (await get(deplao, KEYS.SIGNED_OUT)) === true;
const setSignedOut = (deplao, value) => (value ? set(deplao, KEYS.SIGNED_OUT, true) : del(deplao, KEYS.SIGNED_OUT).catch(() => undefined));

/** Remembered list, strict read: call inside the lock; a failed read throws (never overwrite with an empty list). */
async function loadAccounts(deplao) {
  const raw = await read(deplao, KEYS.ACCOUNTS);
  return Array.isArray(raw) ? normalizeAccounts(raw) : [];
}

async function listAccounts(deplao) {
  const raw = await get(deplao, KEYS.ACCOUNTS);
  return Array.isArray(raw) ? normalizeAccounts(raw) : [];
}

function rememberAccount(deplao, account) {
  const a = accountView(account);
  return lock(async () => {
    const list = (await loadAccounts(deplao)).filter((x) => x.workspaceId !== a.workspaceId);
    await set(deplao, KEYS.ACCOUNTS, [{ ...a, rememberedAt: Date.now() }, ...list].slice(0, ACCOUNTS_MAX));
  });
}

function forgetAccount(deplao, workspaceId) {
  return lock(async () => {
    const list = await loadAccounts(deplao);
    await set(deplao, KEYS.ACCOUNTS, list.filter((x) => x.workspaceId !== String(workspaceId)));
  });
}

// ─── FinTrack sign-in sessions (per workspace) ───────────────────────────────

/** { [workspaceId]: { token, expiresAt, savedAt } }; strict = a failed read throws (use inside the lock). */
async function readSessions(deplao, strict) {
  const raw = strict ? await read(deplao, KEYS.SESSIONS) : await get(deplao, KEYS.SESSIONS);
  return isPlainObject(raw) ? { ...raw } : {};
}

/** { token, expiresAt (ms), workspaceId } or null. */
async function getSession(deplao, workspaceId) {
  if (!workspaceId) return null;
  const s = (await readSessions(deplao, false))[String(workspaceId)];
  if (!isPlainObject(s) || typeof s.token !== 'string' || !s.token) return null;
  return { token: s.token, expiresAt: Number(s.expiresAt) || 0, workspaceId: String(workspaceId) };
}

function setSession(deplao, { token, expiresAt, workspaceId }) {
  if (!workspaceId) return Promise.resolve();
  return lock(async () => {
    const map = await readSessions(deplao, true);
    map[String(workspaceId)] = { token: String(token), expiresAt: Number(expiresAt) || 0, savedAt: Date.now() };
    await set(deplao, KEYS.SESSIONS, map);
  });
}

/**
 * Removes a workspace's session. `token`: only remove it if the stored session is exactly that token, so a slow request
 * that gets a 401 for an old token cannot remove a session that was just minted.
 */
function clearSession(deplao, workspaceId, { token } = {}) {
  if (!workspaceId) return Promise.resolve();
  return lock(async () => {
    const map = await readSessions(deplao, true);
    const cur = map[String(workspaceId)];
    if (!cur || (token && cur.token !== token)) return;
    delete map[String(workspaceId)];
    await set(deplao, KEYS.SESSIONS, map);
  }).catch(() => undefined);
}

// ─── AI assistant per account ────────────────────────────────────────────────

/** { source: 'deplao' | 'fintrack', id }; nothing chosen yet = Deplao's default assistant. */
async function getAiChoice(deplao, workspaceId) {
  const map = await get(deplao, KEYS.AI_CHOICE);
  const c = isPlainObject(map) && workspaceId ? map[String(workspaceId)] : null;
  if (isPlainObject(c) && (c.source === 'deplao' || c.source === 'fintrack')) return { source: c.source, id: String(c.id || '') };
  return { source: 'deplao', id: '' };
}

function setAiChoice(deplao, workspaceId, choice) {
  return lock(async () => {
    const raw = await read(deplao, KEYS.AI_CHOICE);
    const map = isPlainObject(raw) ? raw : {};
    map[String(workspaceId)] = { source: choice.source === 'fintrack' ? 'fintrack' : 'deplao', id: String(choice.id || ''), savedAt: Date.now() };
    await set(deplao, KEYS.AI_CHOICE, map);
  });
}

// ─── Dedupe by Zalo message (7 days) ─────────────────────────────────────────

/**
 * Marks a key as processed. Returns false if the key is already there (duplicate). One storage key holds a map
 * key → timestamp; entries older than 7 days are dropped, at most SEEN_MAX entries are kept.
 */
function markSeen(deplao, key, now = Date.now()) {
  return lock(async () => {
    const raw = await read(deplao, KEYS.SEEN);
    const map = isPlainObject(raw) ? raw : {};
    for (const [k, at] of Object.entries(map)) if (!(now - Number(at) < SEEN_TTL_MS)) delete map[k];
    if (map[key]) return false;
    map[key] = now;
    const keys = Object.keys(map);
    if (keys.length > SEEN_MAX) {
      keys.sort((a, b) => map[a] - map[b]).slice(0, keys.length - SEEN_MAX).forEach((k) => delete map[k]);
    }
    await set(deplao, KEYS.SEEN, map);
    return true;
  });
}

function unmarkSeen(deplao, key) {
  return lock(async () => {
    const raw = await read(deplao, KEYS.SEEN);
    if (!isPlainObject(raw) || !raw[key]) return;
    delete raw[key];
    await set(deplao, KEYS.SEEN, raw);
  }).catch(() => undefined);
}

// ─── Assistant replies in the group → FinTrack drafts ────────────────────────
//
// Drafts live in FinTrack ("Tổng quan → Chờ xác nhận", Overview → awaiting confirmation). The plugin only remembers
// which group reply belongs to which draft, so that "ok" / "huỷ" (cancel) quoting that reply, or sent right after the
// sender's own message, finds the right entries.

const replyView = (r) => ({
  ids: [...new Set((Array.isArray(r.ids) ? r.ids : []).map(String).filter(Boolean))].slice(0, 8),
  threadId: String(r.threadId || ''),
  senderId: String(r.senderId || ''),
  workspaceId: String(r.workspaceId || ''),
  messageId: String(r.messageId || ''),
  /** Entries still await confirmation (as of the latest reply); an unquoted "ok" only targets pending drafts. */
  pending: r.pending !== false,
  at: Number(r.at) || 0,
});
const liveReplies = (raw, now) => (Array.isArray(raw) ? raw : [])
  .filter((r) => isPlainObject(r) && r.messageId && now - Number(r.at) < REPLIES_TTL_MS)
  .map(replyView);

/**
 * Remembers a reply: { ids (msg_id, cli_msg_id of the sent message), threadId, senderId (sender of the original
 * message), workspaceId, messageId (FinTrack assistant message holding the draft), pending }. Replies for the same
 * draft (e.g. "✅ Đã ghi" (Recorded) after "ok") merge their ids, so quoting any of them finds the draft.
 */
function rememberReply(deplao, ref, now = Date.now()) {
  return lock(async () => {
    const list = liveReplies(await read(deplao, KEYS.REPLIES), now);
    const same = list.find((r) => r.messageId === String(ref.messageId || ''));
    const entry = replyView({ ...(same || {}), ...ref, ids: [...(ref.ids || []), ...(same ? same.ids : [])], at: now });
    await set(deplao, KEYS.REPLIES, [entry, ...list.filter((r) => r !== same)].slice(0, REPLIES_MAX));
  });
}

/** Unexpired replies, newest first (read error → empty). */
async function listReplies(deplao, now = Date.now()) {
  return liveReplies(await get(deplao, KEYS.REPLIES), now);
}

module.exports = {
  KEYS, get, set, getSecret, getFinTrackConfig, requireDeployed, getDomain, setDomain, HOSTNAME_RE,
  getActive, setActive, isSignedOut, setSignedOut, listAccounts, rememberAccount, forgetAccount,
  getSession, setSession, clearSession,
  getAiChoice, setAiChoice,
  markSeen, unmarkSeen,
  rememberReply, listReplies,
};
