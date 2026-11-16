'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinTrackClient } = require('../backend/lib/fintrackClient');
const { describeError, PluginError } = require('../backend/lib/errors');

const SECRET = 's'.repeat(43);

function client(handler, extra = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    return handler(url, init);
  };
  return { c: createFinTrackClient({ fetch, baseUrl: 'https://fintrack.acme.workers.dev/', secret: SECRET, workspaceId: 'ws1', ...extra }), requests };
}

const json = (status, body) => ({ status, headers: {}, text: JSON.stringify(body) });

test('headers: Bearer + X-FinTrack-Workspace (except health / workspaces), JSON body', async () => {
  const { c, requests } = client(() => json(200, { ok: true }));
  await c.health();
  await c.workspaces();
  await c.session();
  assert.equal(requests[0].url, 'https://fintrack.acme.workers.dev/api/integration/health');
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(requests[0].init.headers['X-FinTrack-Workspace'], undefined);
  assert.equal(requests[1].init.headers['X-FinTrack-Workspace'], undefined);
  assert.equal(requests[2].init.headers['X-FinTrack-Workspace'], 'ws1');
  assert.equal(requests[2].init.headers['Content-Type'], 'application/json');
  assert.equal(requests[2].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[2].init.body), {});
  assert.equal(requests[2].url, 'https://fintrack.acme.workers.dev/api/integration/session');
});

test('errors by HTTP status, with the FinTrack message, never leaking the secret', async () => {
  const cases = [
    [400, 'FT_BAD_REQUEST'], [401, 'FT_UNAUTHORIZED'], [404, 'FT_NOT_FOUND'], [413, 'FT_TOO_LARGE'],
    [422, 'FT_UNPROCESSABLE'], [429, 'FT_RATE_LIMITED'], [503, 'FT_SERVER'],
  ];
  for (const [status, code] of cases) {
    const { c } = client(() => json(status, { error: { code: 'x_y', message: 'Chi tiết từ FinTrack' }, requestId: 'r1' }));
    await assert.rejects(c.session(), (err) => {
      assert.equal(err.code, code, String(status));
      assert.equal(err.status, status);
      assert.equal(err.serverCode, 'x_y');
      assert.ok(!err.message.includes(SECRET));
      return true;
    });
  }
});

test('404 without the error format (old FinTrack / wrong URL) → FT_NO_INTEGRATION', async () => {
  const { c } = client(() => ({ status: 404, headers: {}, text: '<!doctype html>' }));
  await assert.rejects(c.health(), (e) => e.code === 'FT_NO_INTEGRATION' && /bản cũ, chưa có API này/.test(e.message));
});

test('network error / timeout / unexpected data / base64 body', async () => {
  const net = client(() => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'UPSTREAM_ERROR' }); });
  await assert.rejects(net.c.health(), (e) => e.code === 'FT_NETWORK' && e.message.includes('fintrack.acme.workers.dev'));
  const slow = client(() => { throw Object.assign(new Error('x'), { code: 'TIMEOUT' }); });
  await assert.rejects(slow.c.health(), (e) => e.code === 'FT_TIMEOUT');
  const html = client(() => ({ status: 200, headers: {}, text: '<html>' }));
  await assert.rejects(html.c.health(), (e) => e.code === 'FT_BAD_RESPONSE');
  const b64 = client(() => ({ status: 200, headers: {}, base64: Buffer.from('{"ok":true,"version":"0.1.0"}').toString('base64') }));
  assert.deepEqual(await b64.c.health(), { ok: true, version: '0.1.0' });
});

test('missing configuration → clear error, no network call', async () => {
  let called = 0;
  const fetch = async () => { called++; return json(200, {}); };
  await assert.rejects(createFinTrackClient({ fetch, baseUrl: '', secret: SECRET }).health(), (e) => e.code === 'FT_NOT_CONFIGURED');
  await assert.rejects(createFinTrackClient({ fetch, baseUrl: 'http://evil.example.com', secret: SECRET }).health(), (e) => e.code === 'FT_NOT_CONFIGURED', 'https only');
  await assert.rejects(createFinTrackClient({ fetch, baseUrl: 'https://a.example.com', secret: '' }).health(), (e) => e.code === 'FT_NOT_CONFIGURED');
  await assert.rejects(createFinTrackClient({ fetch, baseUrl: 'https://a.example.com', secret: SECRET }).session(), (e) => e.code === 'FT_NO_WORKSPACE');
  assert.equal(called, 0);
});

test('describeError: Vietnamese messages for Deplao error codes', () => {
  assert.match(describeError({ code: 'API_DISABLED', message: 'API đang tắt' }).message, /Công cụ → Ứng dụng, API & Webhook → API/);
  assert.match(describeError({ code: 'CF_PERMISSION', message: 'Thiếu Account · D1 · Edit.' }).message, /^Thiếu Account · D1 · Edit\. Cập nhật token/);
  assert.equal(describeError({ code: 'VALIDATION_ERROR', message: 'body.name: bắt buộc' }).message, 'Dữ liệu không hợp lệ: body.name: bắt buộc');
  assert.equal(describeError({ code: 'NOT_FOUND', message: 'Không tìm thấy workflow wf1' }).message, 'Không tìm thấy workflow wf1');
  assert.match(describeError({ code: 'CONFLICT', message: '' }).message, /Đợi một chút/);
  assert.equal(describeError(new PluginError('X', 'Câu riêng')).message, 'Câu riêng');
  assert.equal(describeError({ code: 'FT_SERVER', message: 'FinTrack lỗi' }).message, 'FinTrack lỗi');
  assert.equal(describeError(null).code, 'UNKNOWN');
});
