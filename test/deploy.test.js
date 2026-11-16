'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runDeploy } = require('../backend/lib/deploy');
const { createFakeDeplao, createFakeFinTrack, SECRET } = require('./helpers/fakes');

console.log = () => {};
console.warn = () => {};

// Fake plugin directory with vendor/fintrack (bundle.json + migrations).
const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fintrack-plugin-'));
const bundleDir = path.join(pluginDir, 'vendor', 'fintrack');
fs.mkdirSync(path.join(bundleDir, 'worker'), { recursive: true });
fs.mkdirSync(path.join(bundleDir, 'migrations'), { recursive: true });
fs.writeFileSync(path.join(bundleDir, 'bundle.json'), JSON.stringify({ mainModule: 'worker.js', modules: [{ name: 'worker.js', type: 'esm' }], compatibilityDate: '2026-10-05', migrations: 'migrations', fintrackVersion: '0.1.0' }));
fs.writeFileSync(path.join(bundleDir, 'worker', 'worker.js'), 'export default {}');
fs.writeFileSync(path.join(bundleDir, 'migrations', '001_initial.sql'), 'select 1;');
process.env.DEPLAO_PLUGIN_DIR = pluginDir;
test.after(() => fs.rmSync(pluginDir, { recursive: true, force: true }));

function fakeCloudflare({ connected = true, missing = [], workerExists = false, deployFails = false } = {}) {
  const calls = [];
  return {
    calls,
    api: {
      status: async () => { calls.push(['status']); return { connected, accountId: 'cf1', accountName: 'Acme', workersSubdomain: 'acme.workers.dev', prefix: 'fintrack', missing }; },
      d1: {
        ensure: async (name) => { calls.push(['d1.ensure', name]); return { uuid: 'uuid-1', name, created: !workerExists }; },
        migrate: async (name, dir) => { calls.push(['d1.migrate', name, dir]); return workerExists ? { applied: ['035_integration.sql'], skipped: ['001_initial.sql'] } : { applied: ['001_initial.sql'], skipped: [] }; },
        query: async () => ({ results: [] }),
      },
      workers: {
        get: async (name) => { calls.push(['workers.get', name]); return { exists: workerExists, modifiedOn: workerExists ? '2026-10-01T00:00:00Z' : null, url: workerExists ? 'https://fintrack.acme.workers.dev' : null }; },
        deployBundle: async (input) => {
          calls.push(['workers.deployBundle', JSON.parse(JSON.stringify(input))]);
          if (deployFails) throw Object.assign(new Error('Cloudflare lỗi 10021'), { code: 'CF_API' });
          return { name: input.name, url: 'https://fintrack.acme.workers.dev', deployedAt: 123 };
        },
      },
    },
  };
}

const fastHealth = async (client) => client.health();

async function deploy(cf, opts = {}, envOpts = {}) {
  const env = createFakeDeplao({ cloudflare: cf.api, fintrack: createFakeFinTrack({ anySecret: true }), ...envOpts });
  if (envOpts.storedSecret) await env.deplao.storage.set('integration.secret', envOpts.storedSecret);
  const steps = [];
  const progress = (id, status, detail) => steps.push([id, status, detail]);
  let result;
  let error;
  try {
    result = await runDeploy({ deplao: env.deplao, settings: envOpts.settings || {} }, opts, progress, { waitForHealth: fastHealth });
  } catch (err) {
    error = err;
  }
  return { env, steps, result, error };
}

test('fresh deploy: D1 → migrations → Worker with DB/AI bindings + secret; saves the secret and URL', async () => {
  const cf = fakeCloudflare();
  const { env, result, error, steps } = await deploy(cf);
  assert.equal(error, undefined);
  assert.deepEqual(cf.calls.map((c) => c[0]), ['status', 'workers.get', 'd1.ensure', 'd1.migrate', 'workers.deployBundle']);
  assert.deepEqual(cf.calls[3], ['d1.migrate', 'fintrack', 'vendor/fintrack/migrations']);
  const input = cf.calls[4][1];
  const secret = input.secrets.DEPLAO_INTEGRATION_SECRET;
  assert.match(secret, /^[A-Za-z0-9_-]{43,}$/, 'random secret, ≥ 32 bytes base64url');
  assert.deepEqual({ ...input, secrets: undefined }, { name: 'fintrack', bundleDir: 'vendor/fintrack', bindings: { d1: { DB: 'fintrack' }, ai: 'AI' }, secrets: undefined, workersDev: true });
  assert.equal(await env.deplao.storage.get('integration.secret'), secret);
  const saved = await env.deplao.storage.get('deploy');
  assert.equal(saved.url, 'https://fintrack.acme.workers.dev');
  assert.equal(saved.fintrackVersion, '0.1.0');
  assert.deepEqual(saved.migrations, { applied: ['001_initial.sql'], skippedCount: 0 });
  assert.equal(result.healthy, true);
  assert.equal(result.version, '0.1.0');
  assert.deepEqual(steps.filter((s) => s[1] === 'done').map((s) => s[0]), ['check', 'd1', 'migrate', 'worker', 'verify']);
  assert.ok(!JSON.stringify(steps).includes(secret), 'progress does not contain the secret');
});

test('existing Worker, not confirmed → stops before touching D1 / Worker', async () => {
  const cf = fakeCloudflare({ workerExists: true });
  const { error } = await deploy(cf, { confirmOverwrite: false });
  assert.equal(error.code, 'NEEDS_CONFIRM');
  assert.deepEqual(cf.calls.map((c) => c[0]), ['status', 'workers.get']);
});

test('existing Worker, confirmed: keeps D1, applies only new migrations, reuses the stored secret', async () => {
  const cf = fakeCloudflare({ workerExists: true });
  const { env, result, steps } = await deploy(cf, { confirmOverwrite: true }, { storedSecret: SECRET });
  assert.equal(cf.calls[4][1].secrets.DEPLAO_INTEGRATION_SECRET, SECRET);
  assert.equal(result.updatedExisting, true);
  assert.match(steps.find((s) => s[0] === 'd1' && s[1] === 'done')[2], /giữ nguyên dữ liệu/);
  assert.match(steps.find((s) => s[0] === 'migrate' && s[1] === 'done')[2], /Áp 1 migration mới \(1 đã có\)/);
  assert.equal(await env.deplao.storage.get('integration.secret'), SECRET);
});

test('rotate creates a new secret; a secret from Settings is used and not saved to storage', async () => {
  const cf1 = fakeCloudflare();
  const r1 = await deploy(cf1, { rotateSecret: true }, { storedSecret: SECRET });
  assert.notEqual(cf1.calls[4][1].secrets.DEPLAO_INTEGRATION_SECRET, SECRET);

  const manual = 'm'.repeat(40);
  const cf2 = fakeCloudflare();
  const r2 = await deploy(cf2, {}, { settings: { integrationSecret: manual } });
  assert.equal(cf2.calls[4][1].secrets.DEPLAO_INTEGRATION_SECRET, manual);
  assert.equal(await r2.env.deplao.storage.get('integration.secret'), null);
  assert.equal(r1.error, undefined);
});

test('Worker deploy rejected → the new secret is not saved', async () => {
  const cf = fakeCloudflare({ deployFails: true });
  const { env, error } = await deploy(cf);
  assert.equal(error.code, 'CF_API');
  assert.equal(await env.deplao.storage.get('integration.secret'), null);
  assert.equal(await env.deplao.storage.get('deploy'), null);
});

test('errors before deploying: not connected, missing permission, old Deplao, missing bundle', async () => {
  assert.equal((await deploy(fakeCloudflare({ connected: false }))).error.code, 'CF_NOT_CONNECTED');
  const perm = await deploy(fakeCloudflare({ missing: ['Account · D1 · Edit'] }));
  assert.equal(perm.error.code, 'CF_PERMISSION');
  assert.match(perm.error.message, /Account · D1 · Edit/);

  const old = createFakeDeplao({});
  // Old SDK: deplao.cloudflare is a Proxy that returns a function for any name, so d1.ensure does not exist.
  old.deplao.cloudflare = new Proxy({}, { get: () => () => Promise.resolve(null) });
  await assert.rejects(runDeploy({ deplao: old.deplao, settings: {} }, {}, () => {}), (e) => e.code === 'CF_UNSUPPORTED');

  const prev = process.env.DEPLAO_PLUGIN_DIR;
  process.env.DEPLAO_PLUGIN_DIR = os.tmpdir();
  try {
    assert.equal((await deploy(fakeCloudflare())).error.code, 'BUNDLE_MISSING');
  } finally {
    process.env.DEPLAO_PLUGIN_DIR = prev;
  }
});
