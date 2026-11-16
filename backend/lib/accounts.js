'use strict';
/**
 * FinTrack accounts in Deplao (CONTRACTS §3.2, commands accounts / login / register / switchAccount / forgetAccount /
 * logout): sign in with a password, create a new account (through the integration secret, so it does not depend on
 * FinTrack's public sign-up, which is closed after the first account unless an admin opens it), quick switch between
 * "Ghi nhớ mật khẩu" (remember password) accounts, sign out.
 *
 * "Ghi nhớ mật khẩu" does NOT store the password: for a remembered account Deplao keeps the session and mints a new one
 * with the integration secret when it expires, so switching back and forth needs no password. Once forgotten, the
 * account needs a password sign-in again.
 */

const C = require('./constants');
const state = require('./state');
const proxy = require('./proxy');
const { PluginError } = require('./errors');
const { createFinTrackClient, httpErrorCode } = require('./fintrackClient');
const { cleanLine, createDeadline, bodyError } = require('./util');

// Same as FinTrack's emailInput (packages/domain): trimmed, lowercase, a@b.c, ≤ 254 characters.
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function emailOf(v) {
  const email = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (email.length < 3 || email.length > 254 || !EMAIL.test(email)) throw new PluginError('VALIDATION_ERROR', 'Email không hợp lệ.');
  return email;
}

function passwordOf(v) {
  const password = typeof v === 'string' ? v : '';
  if (password.length < 10) throw new PluginError('VALIDATION_ERROR', 'Mật khẩu tối thiểu 10 ký tự.');
  if (password.length > 200) throw new PluginError('VALIDATION_ERROR', 'Mật khẩu tối đa 200 ký tự.');
  return password;
}

const workspaceIdOf = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');

/** Error response of a regular route ({ error: string }) → PluginError that keeps FinTrack's message as is. */
function httpFailure(res, fallback) {
  return new PluginError(httpErrorCode(res.status), bodyError(res.json) || fallback);
}

const OUTDATED = 'FinTrack đang chạy là bản cũ, chưa tạo được tài khoản từ Deplao. Bấm “Cập nhật FinTrack” ở trang Tuỳ chọn (dữ liệu giữ nguyên).';

/** List for the account picker / account menu: the open account + remembered accounts. No tokens. */
async function accounts(params, ctx) {
  const { deplao } = ctx;
  const [active, list, signedOut] = await Promise.all([state.getActive(deplao), state.listAccounts(deplao), state.isSignedOut(deplao)]);
  return {
    active: active ? { workspaceId: active.id, email: active.email, name: active.name, remembered: list.some((a) => a.workspaceId === active.id) } : null,
    accounts: list.map((a) => ({ workspaceId: a.workspaceId, email: a.email, name: a.name, active: !!active && a.workspaceId === active.id })),
    signedOut,
  };
}

/** Signs in with email + password (FinTrack's POST /api/auth/login, which limits failed attempts). */
async function login(params, ctx) {
  const email = emailOf(params.email);
  const password = passwordOf(params.password);
  const remember = params.remember !== false;
  const cfg = state.requireDeployed(await state.getFinTrackConfig(ctx.deplao, ctx.settings));
  const res = await proxy.send(ctx.deplao, cfg, { method: 'POST', path: '/auth/login', body: { email, password }, timeoutMs: C.TIMEOUTS.LOGIN });
  if (res.status !== 200) throw httpFailure(res, 'Không đăng nhập được FinTrack.');
  const account = proxy.accountOf(res.json && res.json.user);
  if (!account || !res.cookie || !res.cookie.token) throw new PluginError('FT_BAD_RESPONSE', 'FinTrack không trả phiên đăng nhập.');
  await proxy.adoptAccount(ctx.deplao, account, res.cookie, { remember });
  return { account };
}

/** Creates a new account (with its own workspace) and opens it. The first FinTrack account is the admin. */
async function register(params, ctx) {
  const displayName = cleanLine(params.displayName, 80);
  if (!displayName) throw new PluginError('VALIDATION_ERROR', 'Nhập tên hiển thị.');
  const email = emailOf(params.email);
  const password = passwordOf(params.password);
  const remember = params.remember !== false;
  const cfg = state.requireDeployed(await state.getFinTrackConfig(ctx.deplao, ctx.settings));
  const client = createFinTrackClient({ fetch: ctx.deplao.http.fetch, baseUrl: cfg.baseUrl, secret: cfg.secret });
  let res;
  try {
    res = await client.createAccount({ email, displayName, password });
  } catch (err) {
    if (err && err.code === 'FT_NO_INTEGRATION') throw new PluginError('UNSUPPORTED', OUTDATED);
    if (err && err.serverMessage && err.status >= 400 && err.status < 500) throw new PluginError(httpErrorCode(err.status), err.serverMessage);
    throw err;
  }
  const account = proxy.accountOf(res && res.user);
  const token = res && res.session && res.session.token;
  if (!account || typeof token !== 'string' || !token) throw new PluginError('FT_BAD_RESPONSE', 'FinTrack không trả tài khoản / phiên vừa tạo.');
  const expiresAt = Date.parse(res.session.expiresAt) || Date.now() + C.SESSION_DAYS_MS;
  await proxy.adoptAccount(ctx.deplao, account, { token, expiresAt }, { remember });
  return { account };
}

/** Switches to a remembered account (no password prompt). Fits in ~25 s (UI commands are cut off after 30 s). */
async function switchAccount(params, ctx) {
  const { deplao } = ctx;
  const workspaceId = workspaceIdOf(params.workspaceId);
  const account = (await state.listAccounts(deplao)).find((a) => a.workspaceId === workspaceId);
  if (!account) throw new PluginError('NOT_FOUND', 'Tài khoản này chưa được ghi nhớ trên Deplao: đăng nhập bằng mật khẩu.');
  const cfg = state.requireDeployed(await state.getFinTrackConfig(deplao, ctx.settings));
  const deadline = createDeadline(C.COMMAND_BUDGET_MS);
  const left = (cap) => Math.max(3000, Math.min(cap, deadline.remaining() - 1000));
  let session = await proxy.ensureSession(deplao, cfg, { workspaceId, timeout: left(C.TIMEOUTS.INTEGRATION / 2) });
  // The saved session may have been revoked by FinTrack (password changed, account disabled…) → check it, then mint a
  // new session once.
  const check = session.token ? await proxy.send(deplao, cfg, { method: 'GET', path: '/auth/session', token: session.token, timeoutMs: left(C.TIMEOUTS.SESSION_CHECK) }) : null;
  if (!check || check.status === 401 || !(check.json && check.json.user)) {
    const stale = session.token || '';
    await state.clearSession(deplao, workspaceId, { token: stale });
    session = await proxy.ensureSession(deplao, cfg, { workspaceId, staleToken: stale, timeout: left(C.TIMEOUTS.INTEGRATION) });
  }
  if (!session.token) throw new PluginError('FT_UNAUTHORIZED', 'Không mở được tài khoản này: đăng nhập bằng mật khẩu.');
  await state.setActive(deplao, account);
  await state.setSignedOut(deplao, false);
  return { account: { workspaceId: account.workspaceId, email: account.email, name: account.name } };
}

/** Forgets an account (the password is needed next time). Forgetting the open account also signs out. */
async function forgetAccount(params, ctx) {
  const { deplao } = ctx;
  const workspaceId = workspaceIdOf(params.workspaceId);
  if (!workspaceId) throw new PluginError('VALIDATION_ERROR', 'Thiếu tài khoản.');
  const active = await state.getActive(deplao);
  if (active && active.id === workspaceId) await proxy.signOut(ctx);
  await state.forgetAccount(deplao, workspaceId);
  await state.clearSession(deplao, workspaceId);
  return {};
}

async function logout(params, ctx) {
  await proxy.signOut(ctx);
  return {};
}

module.exports = { accounts, login, register, switchAccount, forgetAccount, logout };
