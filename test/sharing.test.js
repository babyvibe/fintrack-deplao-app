'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { commands } = require('../backend/index');
const proxy = require('../backend/lib/proxy');
const jobs = require('../backend/lib/jobs');
const { createFakeDeplao, seedDeployed, SECRET } = require('./helpers/fakes');

console.log = () => {};
console.warn = () => {};

// Lan owns the first account (FinTrack's admin), Bình a regular one.
const USERS = () => ({
  workspaces: [{ id: 'ws1', name: 'Lan', ownerEmail: 'lan@example.com' }, { id: 'ws2', name: 'Bình', ownerEmail: 'binh@example.com' }],
  users: [
    { id: 'u1', email: 'lan@example.com', password: 'matkhau-lan-1', displayName: 'Lan', workspaceId: 'ws1' },
    { id: 'u2', email: 'binh@example.com', password: 'matkhau-binh-1', displayName: 'Bình', workspaceId: 'ws2' },
  ],
});

async function setup(opts = {}) {
  proxy.resetCaches();
  jobs._reset();
  const env = createFakeDeplao({ fintrackOpts: { ...USERS(), ...opts.fintrackOpts } });
  if (opts.deployed !== false) await seedDeployed(env.deplao);
  const call = (name, params) => commands[name](params, { deplao: env.deplao, settings: {} });
  const settingsRequests = () => env.fintrack.state.requests.filter((r) => r.path === '/api/admin/settings');
  if (opts.as) assert.equal((await call('login', { email: `${opts.as}@example.com`, password: `matkhau-${opts.as}-1`, remember: opts.remember })).ok, true);
  return { ...env, call, settingsRequests };
}

test('shareSettings: the admin reads FinTrack’s sign-up settings and the account count with the open account’s session', async () => {
  const env = await setup({ as: 'lan' });
  const res = await env.call('shareSettings', {});
  assert.deepEqual(res, { ok: true, access: 'admin', settings: { registrationOpen: false, maxAccounts: 0, signupsPerIpHour: 5, aiDailyCap: 0, accounts: 2 } });
  const [req] = env.settingsRequests();
  assert.equal(req.method, 'GET');
  assert.match(req.headers.Cookie, /^fintrack_session=/);
  assert.equal(req.headers.Authorization, undefined, 'the integration secret is never sent to a regular route');
  assert.ok(!JSON.stringify(res).includes(SECRET));
});

test('setShareSettings: turns sign-up on and sets the account limit; only the edited field is sent, FinTrack’s answer comes back', async () => {
  const env = await setup({ as: 'lan' });
  const on = await env.call('setShareSettings', { registrationOpen: true });
  assert.equal(on.ok, true);
  assert.equal(on.access, 'admin');
  assert.equal(on.settings.registrationOpen, true);
  const max = await env.call('setShareSettings', { maxAccounts: 10 });
  assert.deepEqual(max.settings, { registrationOpen: true, maxAccounts: 10, signupsPerIpHour: 5, aiDailyCap: 0, accounts: 2 });
  assert.deepEqual(env.settingsRequests().map((r) => [r.method, r.body]), [['PUT', { registrationOpen: true }], ['PUT', { maxAccounts: 10 }]]);
  assert.equal(env.fintrack.state.instance.signupsPerIpHour, 5, 'other limits stay as they are');
  assert.deepEqual((await env.call('shareSettings', {})).settings, max.settings);
  const off = await env.call('setShareSettings', { registrationOpen: false, maxAccounts: 0 });
  assert.equal(off.settings.registrationOpen, false);
  assert.equal(off.settings.maxAccounts, 0);
});

test('setShareSettings: invalid values are refused before reaching FinTrack', async () => {
  const env = await setup({ as: 'lan' });
  for (const bad of [{}, { maxAccounts: -1 }, { maxAccounts: 1.5 }, { maxAccounts: '10' }, { maxAccounts: 1_000_001 }, { registrationOpen: 'yes' }, { accounts: 5 }]) {
    const res = await env.call('setShareSettings', bad);
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.equal(res.error.code, 'VALIDATION_ERROR');
  }
  assert.equal(env.settingsRequests().length, 0);
  assert.equal(env.fintrack.state.instance.registrationOpen, false);
});

test('not admin: reading shows FinTrack’s message instead of the settings; saving is refused with that message', async () => {
  const env = await setup({ as: 'binh' });
  assert.deepEqual(await env.call('shareSettings', {}), { ok: true, access: 'not_admin', message: 'Chỉ quản trị FinTrack mới quản lý tài khoản.' });
  const res = await env.call('setShareSettings', { registrationOpen: true });
  assert.deepEqual(res, { ok: false, error: { code: 'FT_FORBIDDEN', message: 'Chỉ quản trị FinTrack mới quản lý tài khoản.' } });
  assert.equal(env.fintrack.state.instance.registrationOpen, false);
});

test('no account open: signed_out without calling FinTrack (no automatic sign-in); saving asks to sign in', async () => {
  const env = await setup({});
  const res = await env.call('shareSettings', {});
  assert.equal(res.ok, true);
  assert.equal(res.access, 'signed_out');
  assert.match(res.message, /Đăng nhập tài khoản quản trị/);
  assert.equal((await env.call('setShareSettings', { registrationOpen: true })).error.code, 'NOT_SIGNED_IN');
  assert.equal(env.fintrack.state.requests.length, 0);
  assert.equal(await env.deplao.storage.get('workspace'), null, 'no account was opened');
});

test('session of a non-remembered account expired: signed_out, the account stays open', async () => {
  const env = await setup({ as: 'lan', remember: false });
  env.fintrack.state.expireAll = true;
  const res = await env.call('shareSettings', {});
  assert.equal(res.access, 'signed_out');
  assert.match(res.message, /hết hạn/);
  assert.equal(env.fintrack.state.requests.filter((r) => r.path === '/api/integration/session').length, 0, 'no session minted for a forgotten account');
  assert.equal((await env.call('accounts', {})).active.workspaceId, 'ws1');
});

test('not deployed: NOT_DEPLOYED for reading and saving; an old Worker without the route asks for an update', async () => {
  const env = await setup({ deployed: false });
  for (const [name, params] of [['shareSettings', {}], ['setShareSettings', { registrationOpen: true }]]) {
    const res = await env.call(name, params);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'NOT_DEPLOYED', name);
  }
  assert.equal(env.fintrack.state.requests.length, 0);
  const old = await setup({ as: 'lan', fintrackOpts: { noAdminSettings: true } });
  const res = await old.call('shareSettings', {});
  assert.equal(res.error.code, 'FT_OUTDATED');
  assert.match(res.error.message, /Cập nhật FinTrack/);
});
