'use strict';
/**
 * Custom domain for the FinTrack Worker (CONTRACTS §1.1, §3.4): pick a subdomain + a zone of the Cloudflare account, Deplao
 * attaches it (after its own confirmation dialog), the plugin waits for DNS + certificate before using it as the URL;
 * detached / removed elsewhere / not answering → back to workers.dev; old Deplao → asks to update. deplao.cloudflare is a fake.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { commands } = require('../backend/index');
const proxy = require('../backend/lib/proxy');
const jobs = require('../backend/lib/jobs');
const state = require('../backend/lib/state');
const domain = require('../backend/lib/domain');
const { runDeploy } = require('../backend/lib/deploy');
const { createFakeDeplao, seedDeployed, BASE_URL } = require('./helpers/fakes');

console.log = () => {};
console.warn = () => {};

const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-domain-'));
const bundleDir = path.join(pluginDir, 'vendor', 'fintrack');
fs.mkdirSync(path.join(bundleDir, 'migrations'), { recursive: true });
fs.mkdirSync(path.join(bundleDir, 'app'));
fs.writeFileSync(path.join(bundleDir, 'bundle.json'), JSON.stringify({ mainModule: 'worker.js', modules: [{ name: 'worker.js' }], compatibilityDate: '2026-10-05', migrations: 'migrations', app: 'app', fintrackVersion: '0.1.0' }));
fs.writeFileSync(path.join(bundleDir, 'migrations', '001.sql'), 'select 1;');
fs.writeFileSync(path.join(bundleDir, 'app', 'index.html'), '<!doctype html>');
test.after(() => fs.rmSync(pluginDir, { recursive: true, force: true }));

const HOST = 'fintrack.example.com';

/** Fake deplao.cloudflare with custom domains (new Deplao); withDomains:false = old Deplao (no zones / workers.domains). */
function fakeCloudflare({ withDomains = true, attached = [], declined = false } = {}) {
  const calls = [];
  const domains = [...attached];
  const cf = {
    status: async () => ({ connected: true, accountId: 'cf1', accountName: 'Acme', workersSubdomain: 'example', prefix: 'fintrack', missing: [] }),
    d1: {
      ensure: async (name) => ({ uuid: 'u1', name, created: false }),
      migrate: async () => ({ applied: [], skipped: ['001.sql'] }),
      query: async () => ({ results: [] }),
    },
    workers: {
      get: async () => ({ exists: true, modifiedOn: '2026-10-01T00:00:00Z', url: BASE_URL }),
      deployBundle: async (input) => ({ name: input.name, url: BASE_URL, deployedAt: 1 }),
    },
  };
  if (withDomains) {
    cf.zones = async () => { calls.push(['zones']); return [{ id: 'z1', name: 'example.com' }, { id: 'z2', name: 'shop.vn' }]; };
    cf.workers.domains = {
      list: async (name) => { calls.push(['list', name]); return domains.map((d) => ({ id: d.id, hostname: d.hostname, zoneId: 'z1', zoneName: d.zoneName })); },
      attach: async (name, hostname) => {
        calls.push(['attach', name, hostname]);
        if (declined) throw Object.assign(new Error('Chưa gắn: bạn đã chọn "Không" ở hộp thoại của Deplao'), { code: 'CF_DECLINED', status: 403 });
        const zoneName = hostname.split('.').slice(-2).join('.');
        domains.push({ id: `d${domains.length + 1}`, hostname, zoneName });
        return { id: `d${domains.length}`, hostname, zoneId: 'z1', zoneName, created: true };
      },
      detach: async (name, hostname) => {
        calls.push(['detach', name, hostname]);
        const i = domains.findIndex((d) => d.hostname === hostname);
        if (i < 0) return { removed: false };
        domains.splice(i, 1);
        return { removed: true };
      },
    };
  }
  return { cf, calls, domains };
}

async function setup(opts = {}) {
  proxy.resetCaches();
  jobs._reset();
  process.env.DEPLAO_PLUGIN_DIR = pluginDir;
  const cf = fakeCloudflare(opts.cloudflare);
  const env = createFakeDeplao({ cloudflare: cf.cf, unreachable: opts.unreachable });
  await seedDeployed(env.deplao);
  const ctx = { deplao: env.deplao, settings: opts.settings || {} };
  const call = (name, params) => commands[name](params || {}, ctx);
  return { ...env, cf, ctx, call };
}

async function finished(call, job) {
  let j = job;
  for (let i = 0; i < 200 && j.state === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 5));
    j = (await call('job', { id: j.id })).job;
  }
  return j;
}

test('attach: subdomain + Cloudflare zone → Deplao attaches it → answers right away, so it becomes the FinTrack URL', async () => {
  const env = await setup();
  const zones = await env.call('domainZones');
  assert.deepEqual(zones.zones, [{ id: 'z1', name: 'example.com' }, { id: 'z2', name: 'shop.vn' }]);
  const res = await env.call('domainAttach', { sub: ' FinTrack ', zone: 'example.com' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.hostname, HOST);
  const job = await finished(env.call, res.job);
  assert.equal(job.state, 'done', JSON.stringify(job));
  assert.deepEqual(job.result, { hostname: HOST, verified: true });
  assert.deepEqual(env.cf.calls.filter((c) => c[0] === 'attach'), [['attach', 'fintrack', HOST]]);
  const cfg = await state.getFinTrackConfig(env.deplao, {});
  assert.equal(cfg.baseUrl, `https://${HOST}`);
  assert.equal(cfg.urlSource, 'domain');
  assert.equal(cfg.fallbackUrl, BASE_URL);
  // Later FinTrack calls go through the custom domain.
  const st = await env.call('status');
  assert.equal(st.fintrack.url, `https://${HOST}`);
  assert.equal(st.fintrack.urlSource, 'domain');
  assert.deepEqual(st.domain, { hostname: HOST, zoneName: 'example.com', verifiedAt: st.domain.verifiedAt });
  assert.ok(st.domain.verifiedAt > 0);
  assert.deepEqual(st.cloudflare.domains, { supported: true, list: [{ hostname: HOST, zoneName: 'example.com' }] });
  assert.equal(st.domainJob.state, 'done');
});

test('attach: invalid subdomain / zone → immediate error, no Cloudflare attach call; user clicks "Không" (No) → clear error', async () => {
  const env = await setup();
  for (const params of [{ sub: '-bad', zone: 'example.com' }, { sub: 'a.b', zone: 'example.com' }, { sub: '', zone: 'example.com' }, { sub: 'fintrack', zone: 'exaample.com' }]) {
    const r = await env.call('domainAttach', params);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION_ERROR', JSON.stringify(params));
  }
  assert.equal(env.cf.calls.filter((c) => c[0] === 'attach').length, 0);

  const no = await setup({ cloudflare: { declined: true } });
  const res = await no.call('domainAttach', { sub: 'fintrack', zone: 'example.com' });
  const job = await finished(no.call, res.job);
  assert.equal(job.state, 'error');
  assert.equal(job.error.code, 'CF_DECLINED');
  assert.match(job.error.message, /Không/);
  assert.equal(await state.getDomain(no.deplao), null);
});

test('waiting for DNS + certificate: stays on workers.dev until the domain answers, then switches; timeout → warning, check again later', async () => {
  const env = await setup({ unreachable: [HOST] });
  const steps = [];
  let waits = 0;
  const run = domain.runAttach(env.ctx, { hostname: HOST, zoneName: 'example.com' }, (id, status, detail) => steps.push([id, status, detail]), {
    pollMs: 1,
    waitMs: 60_000,
    sleep: async () => {
      waits++;
      if (waits === 2) {
        // While waiting, the URL is still workers.dev.
        assert.equal((await state.getFinTrackConfig(env.deplao, {})).baseUrl, BASE_URL);
        env.unreachable.delete(HOST); // Cloudflare has finished DNS + certificate
      }
    },
  });
  assert.deepEqual(await run, { hostname: HOST, verified: true });
  assert.equal(waits, 2);
  assert.equal((await state.getFinTrackConfig(env.deplao, {})).baseUrl, `https://${HOST}`);
  assert.deepEqual(steps.map((s) => s.slice(0, 2)), [['attach', 'running'], ['attach', 'done'], ['dns', 'running'], ['dns', 'done']]);

  const slow = await setup({ unreachable: ['slow.example.com'] });
  const out = await domain.runAttach(slow.ctx, { hostname: 'slow.example.com', zoneName: 'example.com' }, () => undefined, { pollMs: 1, waitMs: 0, sleep: async () => undefined });
  assert.deepEqual(out, { hostname: 'slow.example.com', verified: false });
  const pending = await state.getDomain(slow.deplao);
  assert.equal(pending.verifiedAt, 0);
  assert.equal((await state.getFinTrackConfig(slow.deplao, {})).baseUrl, BASE_URL);
  // "Kiểm tra" (Check): still not answering → error; answering → used.
  const r1 = await slow.call('domainUse', { hostname: 'slow.example.com' });
  assert.equal(r1.ok, false);
  assert.equal(r1.error.code, 'DOMAIN_UNREACHABLE');
  slow.unreachable.clear();
  const r2 = await slow.call('domainUse', { hostname: 'slow.example.com' });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal((await state.getFinTrackConfig(slow.deplao, {})).urlSource, 'domain');
});

test('detach: Deplao removes the Worker hostname and the URL goes back to workers.dev; hostname removed elsewhere → dropped on the next status check', async () => {
  const env = await setup({ cloudflare: { attached: [{ id: 'd1', hostname: HOST, zoneName: 'example.com' }] } });
  await state.setDomain(env.deplao, { hostname: HOST, zoneName: 'example.com', attachedAt: 1, verifiedAt: 2 });
  const res = await env.call('domainDetach', { hostname: HOST });
  assert.deepEqual(res, { ok: true, removed: true });
  assert.deepEqual(env.cf.calls.find((c) => c[0] === 'detach'), ['detach', 'fintrack', HOST]);
  assert.equal(await state.getDomain(env.deplao), null);
  assert.equal((await state.getFinTrackConfig(env.deplao, {})).baseUrl, BASE_URL);

  const gone = await setup();
  await state.setDomain(gone.deplao, { hostname: HOST, zoneName: 'example.com', attachedAt: 1, verifiedAt: 2 });
  const st = await gone.call('status');
  assert.equal(st.domain, null);
  assert.equal(await state.getDomain(gone.deplao), null);
});

test('custom domain in use stops answering while workers.dev still works → status falls back to workers.dev for now and says so', async () => {
  const env = await setup({ cloudflare: { attached: [{ id: 'd1', hostname: HOST, zoneName: 'example.com' }] }, unreachable: [HOST] });
  await state.setDomain(env.deplao, { hostname: HOST, zoneName: 'example.com', attachedAt: 1, verifiedAt: 2 });
  const st = await env.call('status');
  assert.equal(st.ok, true);
  assert.equal(st.ready, true, JSON.stringify(st.fintrack));
  assert.equal(st.fintrack.url, BASE_URL);
  assert.equal(st.fintrack.domainDown, HOST);
  assert.equal(st.domain.verifiedAt, 0);
  assert.equal((await state.getFinTrackConfig(env.deplao, {})).baseUrl, BASE_URL);
});

test('old Deplao (no custom domain support) → the domain row asks to update, commands return UNSUPPORTED; the app still works normally', async () => {
  const env = await setup({ cloudflare: { withDomains: false } });
  const st = await env.call('status');
  assert.deepEqual(st.cloudflare.domains, { supported: false, list: null });
  assert.equal(st.ready, true);
  const r = await env.call('domainZones');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNSUPPORTED');
});

test('deploy: mistyped URL in Settings while workers.dev works → names the field to fix; custom domain not answering → falls back to workers.dev for now', async () => {
  const typo = await setup({ unreachable: ['fintrack.exaample.com'], settings: { fintrackUrl: 'https://fintrack.exaample.com' } });
  const steps = [];
  const out = await runDeploy(typo.ctx, { confirmOverwrite: true }, (id, status, detail) => steps.push([id, status, detail]), { waitForHealth: (client) => client.health() });
  const verify = steps.filter((s) => s[0] === 'verify').pop();
  assert.equal(verify[1], 'warn');
  assert.match(verify[2], /Địa chỉ FinTrack trong Cài đặt ứng dụng \(https:\/\/fintrack\.exaample\.com\)/);
  assert.match(verify[2], /đang chạy ở https:\/\/fintrack\.example\.workers\.dev/);
  assert.equal(out.healthy, false);
  assert.equal(out.settingsUrlBroken, true);

  const down = await setup({ unreachable: [HOST] });
  await state.setDomain(down.deplao, { hostname: HOST, zoneName: 'example.com', attachedAt: 1, verifiedAt: 2 });
  const steps2 = [];
  const out2 = await runDeploy(down.ctx, { confirmOverwrite: true }, (id, status, detail) => steps2.push([id, status, detail]), { waitForHealth: (client) => client.health() });
  assert.equal(out2.healthy, true);
  assert.match(steps2.filter((s) => s[0] === 'verify').pop()[2], /Tên miền fintrack\.example\.com chưa trả lời/);
  assert.equal((await state.getDomain(down.deplao)).verifiedAt, 0);
});
