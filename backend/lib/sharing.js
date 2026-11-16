'use strict';
/**
 * "Chia sẻ FinTrack" (Share FinTrack) on the Options page (CONTRACTS §3.4): public sign-up of this FinTrack, i.e. the
 * same instance settings as FinTrack → Settings → Accounts → "Đăng ký tài khoản" (GET / PUT /api/admin/settings, admins
 * only). Requests go through the proxy with the session of the account open in Deplao; FinTrack decides whether that
 * account is an admin. The public address itself comes from `status` (fintrack.url).
 *
 *  - shareSettings: {} → { access: 'admin', settings } | { access: 'signed_out' | 'not_admin', message }.
 *  - setShareSettings: { registrationOpen?, maxAccounts? } → { access: 'admin', settings }; FinTrack's error message is
 *    passed through unchanged.
 * Not deployed → NOT_DEPLOYED, like the other commands.
 */

const C = require('./constants');
const state = require('./state');
const proxy = require('./proxy');
const { PluginError } = require('./errors');
const { httpErrorCode } = require('./fintrackClient');
const { bodyError, isPlainObject } = require('./util');

const PATH = '/admin/settings';
/** FinTrack's own bound for maxAccounts (instanceSettingsInput in apps/api/src/instance-settings.ts). */
const MAX_ACCOUNTS_LIMIT = 1_000_000;
const SIGNED_OUT = 'Đăng nhập tài khoản quản trị FinTrack trong Deplao (mục Tài khoản FinTrack) để bật đăng ký cho người khác.';
const SESSION_LOST = 'Phiên đăng nhập của tài khoản đang mở đã hết hạn. Mở FinTrack để đăng nhập lại.';
const NOT_ADMIN = 'Chỉ quản trị FinTrack mới quản lý tài khoản.';
const OUTDATED = 'FinTrack đang chạy là bản cũ, chưa có cài đặt đăng ký. Bấm “Cập nhật FinTrack” ở mục FinTrack trên Cloudflare (dữ liệu giữ nguyên).';

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/** FinTrack's settings body → what the Options page shows (accounts = current number of accounts). */
function settingsView(body) {
  return {
    registrationOpen: body.registrationOpen === true,
    maxAccounts: count(body.maxAccounts) ?? 0,
    signupsPerIpHour: count(body.signupsPerIpHour) ?? 0,
    aiDailyCap: count(body.aiDailyCap) ?? 0,
    accounts: count(body.accounts),
  };
}

/** Only the fields this page edits, checked with FinTrack's own bounds so a typo never reaches FinTrack. */
function patchOf(params) {
  const patch = {};
  if (params.registrationOpen !== undefined) {
    if (typeof params.registrationOpen !== 'boolean') throw new PluginError('VALIDATION_ERROR', 'Giá trị bật / tắt đăng ký không hợp lệ.');
    patch.registrationOpen = params.registrationOpen;
  }
  if (params.maxAccounts !== undefined) {
    const n = params.maxAccounts;
    if (!Number.isInteger(n) || n < 0 || n > MAX_ACCOUNTS_LIMIT) {
      throw new PluginError('VALIDATION_ERROR', 'Tối đa tài khoản là số nguyên từ 0 đến 1.000.000 (0 = không giới hạn).');
    }
    patch.maxAccounts = n;
  }
  if (!Object.keys(patch).length) throw new PluginError('VALIDATION_ERROR', 'Không có thay đổi nào để lưu.');
  return patch;
}

/** /admin/settings as the account open in Deplao → { status, body }, or null when no account is open. */
async function askFinTrack(ctx, method, body) {
  state.requireDeployed(await state.getFinTrackConfig(ctx.deplao, ctx.settings));
  const active = await state.getActive(ctx.deplao);
  if (!active) return null;
  // The open account's own session (no automatic sign-in, no sign-out side effects on the Options page).
  return proxy.forward(ctx, { method, path: PATH, body }, { workspaceId: active.id, timeoutMs: C.TIMEOUTS.SETTINGS });
}

function failure(res) {
  if (res.status === 404) return new PluginError('FT_OUTDATED', OUTDATED);
  return new PluginError(httpErrorCode(res.status), bodyError(res.body) || `FinTrack trả lỗi ${res.status}.`);
}

function adminView(res) {
  if (res.status >= 200 && res.status < 300 && isPlainObject(res.body)) return { access: 'admin', settings: settingsView(res.body) };
  if (res.status < 400) throw new PluginError('FT_BAD_RESPONSE', 'FinTrack trả dữ liệu không đọc được.');
  throw failure(res);
}

async function shareSettings(params, ctx) {
  const res = await askFinTrack(ctx, 'GET');
  if (!res) return { access: 'signed_out', message: SIGNED_OUT };
  if (res.status === 401) return { access: 'signed_out', message: SESSION_LOST };
  if (res.status === 403) return { access: 'not_admin', message: bodyError(res.body) || NOT_ADMIN };
  return adminView(res);
}

async function setShareSettings(params, ctx) {
  const patch = patchOf(params);
  const res = await askFinTrack(ctx, 'PUT', patch);
  if (!res) throw new PluginError('NOT_SIGNED_IN', SIGNED_OUT);
  if (res.status === 401) throw new PluginError('NOT_SIGNED_IN', SESSION_LOST);
  return adminView(res);
}

module.exports = { shareSettings, setShareSettings, MAX_ACCOUNTS_LIMIT };
