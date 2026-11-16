'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { commands, nodes } = require('../backend/index');
const proxy = require('../backend/lib/proxy');
const jobs = require('../backend/lib/jobs');
const { _internal } = require('../backend/lib/record');
const { createFakeDeplao, seedDeployed, textTrigger, answerJson, BASE_URL } = require('./helpers/fakes');

console.log = () => {};
console.warn = () => {};

// Fake plugin directory, with or without the vendor/fintrack/app UI.
function fakePluginDir(withApp) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-plugin-'));
  const b = path.join(dir, 'vendor', 'fintrack');
  fs.mkdirSync(path.join(b, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(b, 'bundle.json'), JSON.stringify({ mainModule: 'worker.js', modules: [{ name: 'worker.js' }], compatibilityDate: '2026-10-05', migrations: 'migrations', app: 'app', fintrackVersion: '0.1.0' }));
  fs.writeFileSync(path.join(b, 'migrations', '001.sql'), 'select 1;');
  if (withApp) {
    fs.mkdirSync(path.join(b, 'app'));
    fs.writeFileSync(path.join(b, 'app', 'index.html'), '<!doctype html>');
  }
  return dir;
}
const withApp = fakePluginDir(true);
const noApp = fakePluginDir(false);
test.after(() => { fs.rmSync(withApp, { recursive: true, force: true }); fs.rmSync(noApp, { recursive: true, force: true }); });

async function setup(opts = {}) {
  _internal.reset();
  proxy.resetCaches();
  jobs._reset();
  process.env.DEPLAO_PLUGIN_DIR = opts.app === false ? noApp : withApp;
  const env = createFakeDeplao(opts);
  if (opts.deployed !== false) await seedDeployed(env.deplao);
  const call = (name, params) => commands[name](params, { deplao: env.deplao, settings: opts.settings || {} });
  return { ...env, call };
}

async function waitJob(call, job) {
  let j = job;
  for (let i = 0; i < 100 && j.state === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 10));
    j = (await call('job', { id: j.id })).job;
  }
  return j;
}

test('status: ready (FinTrack running, app/ present, one workspace) → the entry page opens FinTrack', async () => {
  const env = await setup({});
  const st = await env.call('status', { quick: true });
  assert.equal(st.ok, true);
  assert.equal(st.ready, true);
  assert.equal(st.reason, '');
  assert.equal(st.appPath, 'vendor/fintrack/app/index.html');
  assert.equal(st.fintrack.workspaceState, 'single');
  assert.equal(st.bundle.hasApp, true);
  assert.ok(!JSON.stringify(st).includes('secret-123'), 'does not leak the secret');
});

test('status: not-ready reasons (not deployed, missing app/); with several FinTrack accounts it is still ready (login screen)', async () => {
  assert.equal((await (await setup({ deployed: false })).call('status')).reason, 'not_deployed');
  const noAppEnv = await setup({ app: false });
  const st = await noAppEnv.call('status');
  assert.equal(st.reason, 'bundle_incomplete');
  assert.equal(st.bundle.hasApp, false);
  const many = await setup({ fintrackOpts: {
    workspaces: [{ id: 'ws1', name: 'A', ownerEmail: 'lan@example.com' }, { id: 'ws2', name: 'B', ownerEmail: 'binh@example.com' }],
    users: [{ id: 'u1', email: 'lan@example.com', password: 'matkhau-lan-1', displayName: 'Lan', workspaceId: 'ws1' }, { id: 'u2', email: 'binh@example.com', password: 'matkhau-binh-1', displayName: 'Bình', workspaceId: 'ws2' }],
  } });
  const st2 = await many.call('status');
  assert.equal(st2.ready, true);
  assert.equal(st2.reason, '');
  assert.equal(st2.fintrack.workspaceState, 'multiple');
  assert.equal(st2.fintrack.workspaceCount, 2);
  assert.ok(!JSON.stringify(st2).includes('binh@example.com'), 'does not list the emails of other accounts');
  assert.equal(st2.account, null);
  assert.equal((await many.call('login', { email: 'binh@example.com', password: 'matkhau-binh-1' })).ok, true);
  const st3 = await many.call('status');
  assert.equal(st3.fintrack.workspaceState, 'linked');
  assert.deepEqual(st3.account, { workspaceId: 'ws2', email: 'binh@example.com', name: 'Bình' });
  assert.equal(st3.session.active, true);
  assert.equal(st3.session.token, undefined, 'does not return the token');
  assert.ok(!JSON.stringify(st3).includes((await many.deplao.storage.get('sessions')).ws2.token), 'does not leak the token');
  const down = await setup({});
  down.fintrack.state.down = true;
  assert.equal((await down.call('status')).reason, 'unreachable');
});

test('FinTrack accounts: create in Deplao (separate workspace), remember, quick switch without a password, forget, log out', async () => {
  const env = await setup({});
  await env.call('api', { method: 'GET', path: '/auth/session' }); // the first call opens the only account (ws1)
  assert.equal((await env.call('register', { displayName: 'Em', email: 'em@example.com', password: 'ngan' })).error.message, 'Mật khẩu tối thiểu 10 ký tự.');
  assert.equal((await env.call('register', { displayName: 'Em', email: 'khong-phai-email', password: 'matkhau-em-01' })).error.message, 'Email không hợp lệ.');
  const dup = await env.call('register', { displayName: 'Trùng', email: 'lan@example.com', password: 'matkhau-trung-1' });
  assert.equal(dup.error.message, 'Email này đã có tài khoản');

  const reg = await env.call('register', { displayName: 'Em', email: 'Em@Example.com', password: 'matkhau-em-01' });
  assert.deepEqual(reg, { ok: true, account: { workspaceId: 'ws2', email: 'em@example.com', name: 'Em' } });
  const created = env.fintrack.state.requests.find((r) => r.path === '/api/integration/accounts');
  assert.equal(created.headers.Authorization, 'Bearer secret-123', 'account created with the integration secret');
  assert.equal((await env.call('api', { method: 'GET', path: '/auth/session' })).body.user.workspaceId, 'ws2');
  const list = await env.call('accounts', {});
  assert.deepEqual(list.accounts.map((a) => [a.workspaceId, a.active]), [['ws2', true], ['ws1', false]]);
  assert.equal(list.active.workspaceId, 'ws2');

  // Switch back to the previous account: no password, right workspace.
  assert.equal((await env.call('switchAccount', { workspaceId: 'ws1' })).ok, true);
  assert.equal((await env.call('api', { method: 'GET', path: '/auth/session' })).body.user.workspaceId, 'ws1');
  assert.equal((await env.call('switchAccount', { workspaceId: 'ws9' })).error.code, 'NOT_FOUND');

  // Disabled account → cannot be opened, clear error.
  env.fintrack.state.disabled.add('ws2');
  await env.call('logout', {});
  await env.deplao.storage.set('sessions', {});
  const locked = await env.call('switchAccount', { workspaceId: 'ws2' });
  assert.equal(locked.ok, false);
  assert.match(locked.error.message, /khoá/);
  env.fintrack.state.disabled.delete('ws2');

  // Login without "remember" → once the session expires the user must log in again (no session minted with the secret).
  await env.call('forgetAccount', { workspaceId: 'ws2' });
  assert.equal((await env.call('login', { email: 'em@example.com', password: 'matkhau-em-01', remember: false })).ok, true);
  assert.deepEqual((await env.call('accounts', {})).accounts.map((a) => a.workspaceId), ['ws1']);
  const mints = () => env.fintrack.state.requests.filter((r) => r.path === '/api/integration/session' && r.headers['X-FinTrack-Workspace'] === 'ws2').length;
  const before = mints();
  env.fintrack.state.sessions.clear(); // sessions expire on the FinTrack side
  assert.equal((await env.call('api', { method: 'GET', path: '/auth/session' })).status, 401);
  assert.equal(mints(), before);
  assert.equal((await env.call('accounts', {})).signedOut, true);

  // Old FinTrack (no account creation route) → asks to update FinTrack.
  const old = await setup({ fintrackOpts: { noAccountsRoute: true } });
  assert.equal((await old.call('register', { displayName: 'Em', email: 'em@example.com', password: 'matkhau-em-01' })).error.code, 'UNSUPPORTED');
});

test('node records into the open FinTrack account; “ok” in the group records into the account that holds the draft, even after another account is opened', async () => {
  const env = await setup({ aiAnswers: [answerJson([{ type: 'expense', amount: '50000', accountId: 'cash', categoryId: 'food', note: 'Ăn trưa', date: '2026-10-20' }])] });
  await env.call('api', { method: 'GET', path: '/auth/session' }); // ws1
  const ctx = { deplao: env.deplao, settings: {} };
  const run = (trigger) => nodes['fintrack.record']({ account: 'acc1' }, { trigger, pageId: 'acc1' }, ctx);
  const out = await run(textTrigger({ content: 'Ăn trưa 50k', msgId: 'm300' }));
  assert.equal(out.drafts, 1, JSON.stringify(out));
  const chat = env.fintrack.state.requests.filter((r) => r.path === '/api/assistant/chat');
  const wsOf = (r) => env.fintrack.state.sessions.get(decodeURIComponent(/fintrack_session=([^;]+)/.exec(r.headers.Cookie)[1]));
  assert.deepEqual(chat.map(wsOf), ['ws1', 'ws1'], 'message goes to the open workspace ws1 (428, then resend)');
  assert.equal(chat[0].headers['X-FinTrack-AI'], 'deplao', 'assistant of workspace ws1 (Deplao)');
  // Open another account (ws2) in the UI and choose the FinTrack assistant for ws2.
  assert.equal((await env.call('register', { displayName: 'Em', email: 'em@example.com', password: 'matkhau-em-01' })).ok, true);
  assert.equal((await env.call('setAiAssistant', { source: 'fintrack', profileId: 'p1' })).ok, true);
  // Lan sends “ok” right after (no quote) → Lan's draft, recorded into ws1.
  const ok = await run(textTrigger({ content: 'ok', msgId: 'm301' }));
  assert.equal(ok.recorded, 1, JSON.stringify(ok));
  const confirm = env.fintrack.state.requests.filter((r) => /\/api\/assistant\/drafts\/[^/]+\/confirm$/.test(r.path));
  assert.deepEqual(confirm.map(wsOf), ['ws1']);
  // The UI stays on ws2.
  assert.equal((await env.call('api', { method: 'GET', path: '/auth/session' })).body.user.workspaceId, 'ws2');
  // Drafts live in FinTrack (Tổng quan → Chờ xác nhận); the plugin no longer has draft, group-picking or workflow-creation commands.
  for (const name of ['drafts', 'draftCount', 'confirmDraft', 'discardDraft', 'zaloAccounts', 'zaloGroups', 'createGroup', 'useGroup', 'useLedger', 'ensureWorkflow', 'setWorkflowEnabled']) {
    assert.equal(commands[name], undefined, name);
  }
});

test('deploy command: runs in the background, deployStatus reads it back; an interrupted deploy is reported clearly', async () => {
  const env = await setup({});
  const r = await env.call('deployStart', {});
  const j = await waitJob(env.call, r.job);
  assert.equal(j.state, 'error');
  assert.equal(j.error.code, 'CF_UNSUPPORTED', 'the fake has no deplao.cloudflare');
  await new Promise((res) => setTimeout(res, 20));
  assert.equal((await env.call('deployStatus')).job.id, r.job.id);
  const stored = await env.deplao.storage.get('deploy.job');
  jobs._reset();
  await env.deplao.storage.set('deploy.job', { ...stored, state: 'running', error: null, steps: [{ id: 'worker', status: 'running' }] });
  const st = await env.call('deployStatus');
  assert.equal(st.job.error.code, 'INTERRUPTED');
});

test('status: Worker older than the shipped bundle → updateAvailable; no group / workflow / assistant / draft sections anymore', async () => {
  const old = await setup({ fintrackOpts: { version: '0.0.9' } });
  const st = await old.call('status', {});
  assert.equal(st.fintrack.health.version, '0.0.9');
  assert.equal(st.fintrack.updateAvailable, true);
  const env = await setup({});
  await env.call('api', { method: 'GET', path: '/auth/session' });
  const now = await env.call('status', {});
  assert.equal(now.fintrack.updateAvailable, false);
  for (const key of ['group', 'workflow', 'ai', 'drafts']) assert.equal(key in now, false, key);
});

test('status: same version but the shipped bundle differs from the deployed one (sha256 fingerprint) → updateAvailable', async (t) => {
  const dir = fakePluginDir(true);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'vendor', 'fintrack.vendor.json'), JSON.stringify({ fintrackVersion: '0.1.0', sha256: 'ab'.repeat(32) }));
  const env = await setup({});
  process.env.DEPLAO_PLUGIN_DIR = dir;
  const before = await env.call('status', { quick: true });
  assert.equal(before.bundle.build, 'ab'.repeat(8));
  assert.equal(before.fintrack.health.version, '0.1.0');
  assert.equal(before.fintrack.updateAvailable, true, 'a deploy without a recorded fingerprint = old bundle');
  assert.equal(before.ready, true, 'still opens FinTrack, only suggests an update');
  const deployed = await env.deplao.storage.get('deploy');
  await env.deplao.storage.set('deploy', { ...deployed, build: 'cd'.repeat(8) });
  assert.equal((await env.call('status', { quick: true })).fintrack.updateAvailable, true, 'different bundle');
  await env.deplao.storage.set('deploy', { ...deployed, build: 'ab'.repeat(8) });
  assert.equal((await env.call('status', { quick: true })).fintrack.updateAvailable, false, 'matches the shipped bundle');
  // A URL typed into Settings may point to another FinTrack: fingerprints are not compared.
  await env.deplao.storage.set('deploy', deployed);
  const manual = await commands.status({ quick: true }, { deplao: env.deplao, settings: { fintrackUrl: BASE_URL } });
  assert.equal(manual.fintrack.updateAvailable, false);
  // A Worker newer than the bundled FinTrack (deployed by a newer app elsewhere) is never offered a downgrade.
  const newer = await setup({ fintrackOpts: { version: '0.2.0' } });
  process.env.DEPLAO_PLUGIN_DIR = dir;
  const ahead = await newer.call('status', { quick: true });
  assert.equal(ahead.fintrack.health.version, '0.2.0');
  assert.equal(ahead.fintrack.updateAvailable, false);
});
