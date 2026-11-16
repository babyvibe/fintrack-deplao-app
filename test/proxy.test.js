'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { commands } = require('../backend/index');
const proxy = require('../backend/lib/proxy');
const state = require('../backend/lib/state');
const jobs = require('../backend/lib/jobs');
const { createFakeDeplao, createFakeFinTrack, seedDeployed, SECRET } = require('./helpers/fakes');

console.log = () => {};
console.warn = () => {};

async function setup(opts = {}) {
  proxy.resetCaches();
  jobs._reset();
  const env = createFakeDeplao(opts);
  if (opts.deployed !== false) await seedDeployed(env.deplao);
  const call = (name, params) => commands[name](params, { deplao: env.deplao, settings: opts.settings || {} });
  const normalRequests = () => env.fintrack.state.requests.filter((r) => !r.path.startsWith('/api/integration/'));
  return { ...env, call, normalRequests };
}

test('validateRequest: method, path, blocks /integration', () => {
  assert.deepEqual(proxy.validateRequest({ method: 'get', path: '/transactions?page=2' }), { method: 'GET', path: '/transactions?page=2', blocked: false });
  for (const path of ['/integration/session', '/Integration/x', '//integration/x', '/%69ntegration/x']) {
    let blocked;
    try { blocked = proxy.validateRequest({ method: 'POST', path }).blocked; } catch { blocked = 'invalid'; }
    assert.ok(blocked === true || blocked === 'invalid', path);
  }
  for (const bad of [{ method: 'TRACE', path: '/x' }, { method: 'GET', path: 'x' }, { method: 'GET', path: '/a/../integration' }, { method: 'GET', path: '/a\\b' }, { method: 'GET', path: `/${'a'.repeat(2001)}` }]) {
    assert.throws(() => proxy.validateRequest(bad), (e) => e.code === 'VALIDATION_ERROR', JSON.stringify(bad).slice(0, 60));
  }
});

test('api: one workspace → auto-link, mint a session, send cookie + Deplao headers; no secret on regular routes', async () => {
  const env = await setup({});
  const r = await env.call('api', { method: 'GET', path: '/transactions?page=2' });
  assert.deepEqual(r, { ok: true, status: 200, body: { items: [], page: 2 } });
  assert.equal((await env.deplao.storage.get('workspace')).id, 'ws1');
  assert.deepEqual((await env.deplao.storage.get('accounts')).map((a) => [a.workspaceId, a.email]), [['ws1', 'lan@example.com']], 'opened automatically the first time → remembered');
  const session = (await env.deplao.storage.get('sessions')).ws1;
  assert.ok(session.token);
  const [req] = env.normalRequests();
  assert.equal(req.headers.Cookie, `fintrack_session=${session.token}`);
  assert.equal(req.headers['X-FinTrack-Client'], 'deplao');
  assert.equal(req.headers['X-FinTrack-AI'], undefined, 'assistant header only on /assistant/* routes');
  assert.equal(req.headers.Authorization, undefined);
  // Assistant routes: include the answering assistant (name percent-encoded, headers ASCII only).
  await env.call('api', { method: 'GET', path: '/assistant/settings' });
  const ai = env.normalRequests().find((x) => x.path === '/api/assistant/settings');
  assert.equal(ai.headers['X-FinTrack-AI'], 'deplao');
  assert.equal(ai.headers['X-FinTrack-Assistant'], encodeURIComponent('Trợ lý chính'), 'assistant name is percent-encoded');
  for (const [k, v] of Object.entries(ai.headers)) assert.match(String(v), /^[ -~]*$/, `header ${k} is ASCII only`);
  assert.ok(!JSON.stringify(env.normalRequests()).includes(SECRET));
  // Later calls reuse the session instead of minting another one.
  await env.call('api', { method: 'GET', path: '/auth/session' });
  assert.equal(env.fintrack.state.requests.filter((x) => x.path === '/api/integration/session').length, 1);
});

test('api: /integration blocked with 403, invalid path → ok:false, not deployed → ok:false', async () => {
  const env = await setup({});
  assert.deepEqual(await env.call('api', { method: 'POST', path: '/integration/session' }), { ok: true, status: 403, body: { error: 'Không được gọi API tích hợp từ giao diện FinTrack.' } });
  assert.equal((await env.call('api', { method: 'GET', path: 'transactions' })).error.code, 'VALIDATION_ERROR');
  const none = await setup({ deployed: false });
  const r = await none.call('api', { method: 'GET', path: '/auth/session' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NOT_DEPLOYED');
});

test('no account yet → no cookie sent (FinTrack shows sign-up); first registration → opened + remembered; log out → no automatic re-login', async () => {
  const env = await setup({ fintrackOpts: { workspaces: [] } });
  const first = await env.call('api', { method: 'GET', path: '/auth/session' });
  assert.equal(first.status, 401);
  assert.equal(env.normalRequests()[0].headers.Cookie, undefined);
  env.fintrack.state.workspaces.push({ id: 'ws1', name: 'Nhà mình', currency: 'VND' });
  const reg = await env.call('api', { method: 'POST', path: '/auth/register', body: { email: 'lan@example.com', password: 'x', displayName: 'Lan' } });
  assert.equal(reg.status, 201);
  const s = (await env.deplao.storage.get('sessions')).ws1;
  assert.ok(s.token && s.expiresAt > Date.now() + 29 * 86_400_000);
  assert.equal((await env.deplao.storage.get('workspace')).id, 'ws1');
  assert.deepEqual((await env.deplao.storage.get('accounts')).map((a) => a.workspaceId), ['ws1']);
  assert.equal((await env.call('api', { method: 'GET', path: '/auth/session' })).status, 200);

  const mintsBefore = env.fintrack.state.requests.filter((x) => x.path === '/api/integration/session').length;
  assert.deepEqual(await env.call('api', { method: 'POST', path: '/auth/logout' }), { ok: true, status: 204, body: null });
  assert.equal(env.fintrack.state.sessions.has(s.token), false, 'session revoked in FinTrack');
  assert.equal((await env.deplao.storage.get('sessions')).ws1, undefined);
  assert.equal(await env.deplao.storage.get('workspace'), null);
  assert.equal(await env.deplao.storage.get('signedOut'), true);
  // Logging out in Deplao → NO automatic re-login; the account stays in the remembered list to pick again.
  assert.equal((await env.call('api', { method: 'GET', path: '/auth/session' })).status, 401);
  assert.equal(env.fintrack.state.requests.filter((x) => x.path === '/api/integration/session').length, mintsBefore);
  assert.deepEqual((await env.call('accounts', {})).accounts.map((a) => [a.workspaceId, a.active]), [['ws1', false]]);
});

test('several FinTrack accounts, none open → login screen (no cookie); logging in opens the right account', async () => {
  const env = await setup({ fintrackOpts: {
    workspaces: [{ id: 'ws1', name: 'A' }, { id: 'ws2', name: 'B' }],
    users: [{ id: 'u1', email: 'lan@example.com', password: 'matkhau-lan-1', displayName: 'Lan', workspaceId: 'ws1' }, { id: 'u2', email: 'binh@example.com', password: 'matkhau-binh-1', displayName: 'Bình', workspaceId: 'ws2' }],
  } });
  const r = await env.call('api', { method: 'GET', path: '/auth/session' });
  assert.equal(r.status, 401);
  assert.equal(env.fintrack.state.requests.filter((x) => x.path === '/api/integration/session').length, 0, 'no account is opened automatically');
  assert.equal((await env.call('login', { email: 'binh@example.com', password: 'sai-mat-khau-1' })).error.message, 'Email hoặc mật khẩu không đúng');
  const ok = await env.call('login', { email: ' Binh@Example.com ', password: 'matkhau-binh-1', remember: true });
  assert.deepEqual(ok, { ok: true, account: { workspaceId: 'ws2', email: 'binh@example.com', name: 'Bình' } });
  assert.equal((await env.call('api', { method: 'GET', path: '/auth/session' })).body.user.workspaceId, 'ws2');
  assert.ok(!JSON.stringify([...env.storage.values()]).includes('matkhau-binh-1'), 'password is not stored');
});

test('401 on an active session → mint a new session once, then retry', async () => {
  const env = await setup({});
  await env.call('api', { method: 'GET', path: '/auth/session' });
  const old = (await env.deplao.storage.get('sessions')).ws1.token;
  env.fintrack.state.sessions.delete(old); // session revoked on the FinTrack side
  const r = await env.call('api', { method: 'GET', path: '/auth/session' });
  assert.equal(r.status, 200);
  assert.notEqual((await env.deplao.storage.get('sessions')).ws1.token, old);
  env.fintrack.state.expireAll = true; // still 401 → no endless loop
  assert.equal((await env.call('api', { method: 'GET', path: '/auth/session' })).status, 401);
});

test('failed login (401) does not trigger a new session', async () => {
  const env = await setup({});
  await env.call('api', { method: 'GET', path: '/auth/session' });
  const before = env.fintrack.state.requests.filter((x) => x.path === '/api/integration/session').length;
  const r = await env.call('api', { method: 'POST', path: '/auth/login', body: { email: 'a', password: 'sai' } });
  assert.equal(r.status, 401);
  assert.equal(env.fintrack.state.requests.filter((x) => x.path === '/api/integration/session').length, before);
});

test('428 delegate → aiChat(raw_system) with the messages from FinTrack → resend with delegated', async () => {
  const env = await setup({ aiAnswers: [JSON.stringify({ reply: 'Bản nháp chi 50.000 ₫', actions: [{ type: 'expense', amount: '50000', accountId: 'cash' }] })] });
  const body = { conversationId: '5d62cafd-5215-59cf-be79-b2beb4cb1d2c', text: 'Ăn trưa 50k' };
  const r = await env.call('api', { method: 'POST', path: '/assistant/chat', body });
  assert.equal(r.status, 200);
  assert.equal(r.body.reply, 'Bản nháp chi 50.000 ₫');
  const ai = env.calls.find((c) => c.op === 'aiChat').params;
  assert.equal(ai.raw_system, true);
  assert.equal(ai.max_tokens, 4000);
  assert.deepEqual(ai.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(ai.messages[1].content, 'Ăn trưa 50k');
  const resend = env.normalRequests().filter((x) => x.path === '/api/assistant/chat')[1];
  assert.equal(resend.body.conversationId, body.conversationId);
  assert.equal(resend.body.text, body.text);
  assert.deepEqual(resend.body.delegated.model, 'gpt-4o-mini');
  assert.match(resend.body.delegated.output, /Bản nháp chi 50\.000/);
  // Token counts reported by Deplao → FinTrack adds them to the assistant's usage.
  assert.deepEqual(resend.body.delegated.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
});

test('502 bad_output → ask the assistant once more (reminder: JSON only); still wrong → error returned to the UI', async () => {
  const good = JSON.stringify({ reply: 'OK', actions: [] });
  const env = await setup({ aiAnswers: ['Dạ em ghi rồi ạ', `\`\`\`json\n${good}\n\`\`\``] });
  const r = await env.call('api', { method: 'POST', path: '/assistant/chat', body: { conversationId: '5d62cafd-5215-59cf-be79-b2beb4cb1d2c', text: 'x' } });
  assert.equal(r.status, 200);
  const calls = env.calls.filter((c) => c.op === 'aiChat');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.match(calls[1].params.messages[3].content, /JSON/);
  // The retry costs tokens too: send the total of both calls.
  const resends = env.normalRequests().filter((x) => x.path === '/api/assistant/chat' && x.body.delegated);
  assert.deepEqual(resends.at(-1).body.delegated.usage, { inputTokens: 14, outputTokens: 6, totalTokens: 20 });

  const bad = await setup({ aiAnswers: ['không', 'vẫn không'] });
  const r2 = await bad.call('api', { method: 'POST', path: '/assistant/chat', body: { conversationId: '5d62cafd-5215-59cf-be79-b2beb4cb1d2c', text: 'x' } });
  assert.equal(r2.status, 502);
  assert.equal(r2.body.code, 'bad_output');
  assert.equal(bad.calls.filter((c) => c.op === 'aiChat').length, 2);
});

test('Deplao assistant fails → 502 deplao_ai with a readable message', async () => {
  const env = await setup({ noAssistant: true });
  const r = await env.call('api', { method: 'POST', path: '/assistant/chat', body: { conversationId: '5d62cafd-5215-59cf-be79-b2beb4cb1d2c', text: 'x' } });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'deplao_ai');
  assert.match(r.body.error, /Trợ lý AI của Deplao/);
  assert.equal(env.normalRequests()[0].headers['X-FinTrack-Assistant'], undefined, 'no assistant → header not sent');
});

test('response > 5 MB (truncated) → clear error; 204 → null body', async () => {
  const env = await setup({});
  const big = await env.call('api', { method: 'GET', path: '/big' });
  assert.equal(big.ok, false);
  assert.equal(big.error.code, 'TOO_LARGE');
  assert.match(big.error.message, /5 MB.*trình duyệt/);
  assert.deepEqual(await env.call('api', { method: 'DELETE', path: '/transactions/t1' }), { ok: true, status: 204, body: null });
});

test('not finished → pending; apiResult returns the result once done (kept for 5 minutes)', async () => {
  const env = await setup({});
  let release;
  const gate = new Promise((r) => { release = r; });
  const original = env.deplao.http.fetch;
  env.deplao.http.fetch = async (url, init) => { if (url.endsWith('/api/transactions')) await gate; return original(url, init); };
  // An api job still running (like the api command after waiting ~20 s).
  const j = jobs.startJob('api', () => proxy.forward({ deplao: env.deplao, settings: {} }, { method: 'GET', path: '/transactions' }));
  const pending = await env.call('apiResult', { id: j.id });
  assert.deepEqual(pending, { ok: true, pending: j.id });
  release();
  await jobs.waitJob(j.id, 1000);
  assert.deepEqual(await env.call('apiResult', { id: j.id }), { ok: true, status: 200, body: { items: [], page: 1 } });
  assert.equal((await env.call('apiResult', { id: 'không-có' })).error.code, 'NOT_FOUND');
});

test('choosing a Deplao AI assistant: list, pick another one (sends assistant_id + name), clear the choice → default', async () => {
  const answer = JSON.stringify({ reply: 'OK', actions: [] });
  const env = await setup({ aiAnswers: [answer, answer] });
  assert.equal((await env.call('setAiAssistant', { id: 'ai2' })).error.code, 'NOT_CONFIGURED', 'no account open yet');
  await env.call('api', { method: 'GET', path: '/auth/session' }); // open the account (opened automatically the first time)
  const list = await env.call('aiAssistants', {});
  assert.equal(list.ok, true);
  assert.equal(list.supported, true);
  assert.deepEqual(list.assistants.map((a) => a.id), ['ai1', 'ai2', 'ai3']);
  assert.equal(list.selectedId, '');
  assert.deepEqual(list.choice, { source: 'deplao', id: '' });
  assert.equal(list.defaultAssistant.name, 'Trợ lý chính');
  assert.deepEqual(list.fintrack.profiles.map((p) => [p.id, p.configured]), [['p1', true], ['p2', false]]);
  assert.equal(list.fintrack.defaultProfileId, 'p1');

  // Disabled / unknown assistant → cannot be chosen.
  assert.equal((await env.call('setAiAssistant', { id: 'ai3' })).error.code, 'VALIDATION_ERROR');
  assert.equal((await env.call('setAiAssistant', { id: 'khong-co' })).error.code, 'NOT_FOUND');

  const picked = await env.call('setAiAssistant', { id: 'ai2' });
  assert.equal(picked.ok, true);
  assert.deepEqual(picked.assistant, { source: 'deplao', id: 'ai2', name: 'Kế toán Đào', model: 'gemini-2.5-flash', chosen: true });
  assert.equal((await env.call('aiAssistants', {})).selectedId, 'ai2');

  const body = { conversationId: '5d62cafd-5215-59cf-be79-b2beb4cb1d2c', text: 'Ăn trưa 50k' };
  assert.equal((await env.call('api', { method: 'POST', path: '/assistant/chat', body })).status, 200);
  const first = env.calls.filter((c) => c.op === 'aiChat')[0].params;
  assert.equal(first.assistant_id, 'ai2');
  const chatReqs = env.normalRequests().filter((x) => x.path === '/api/assistant/chat');
  assert.equal(chatReqs[0].headers['X-FinTrack-Assistant'], encodeURIComponent('Kế toán Đào'));
  assert.equal(chatReqs[1].body.delegated.model, 'gemini-2.5-flash');

  // Clear the choice → Deplao's default assistant, no assistant_id sent.
  const reset = await env.call('setAiAssistant', { id: null });
  assert.deepEqual(reset.assistant, { source: 'deplao', id: 'ai1', name: 'Trợ lý chính', model: 'gpt-4o-mini', chosen: false });
  await env.call('api', { method: 'POST', path: '/assistant/chat', body });
  const second = env.calls.filter((c) => c.op === 'aiChat')[1].params;
  assert.equal(second.assistant_id, undefined);
});

test('chosen assistant deleted from Deplao → default is used (nothing selected in the FinTrack list); old Deplao (no list) → default only', async () => {
  const env = await setup({ assistants: [{ id: 'ai1', name: 'Trợ lý chính', platform: 'openai', model: 'gpt-4o-mini', enabled: true, is_default: true }] });
  await env.call('api', { method: 'GET', path: '/auth/session' }); // open account ws1
  await env.deplao.storage.set('ai.choice', { ws1: { source: 'deplao', id: 'ai2' } }); // ai2 has been deleted from Deplao
  const choices = await env.call('aiAssistants', {});
  assert.equal(choices.selectedId, '');
  assert.deepEqual(choices.choice, { source: 'deplao', id: '' });
  assert.equal(choices.defaultAssistant.id, 'ai1');
  const body = { conversationId: '5d62cafd-5215-59cf-be79-b2beb4cb1d2c', text: 'Cafe 30k' };
  await env.call('api', { method: 'POST', path: '/assistant/chat', body });
  assert.equal(env.calls.filter((c) => c.op === 'aiChat')[0].params.assistant_id, undefined, 'Deplao default assistant');

  const old = await setup({ assistants: null });
  await old.call('api', { method: 'GET', path: '/auth/session' });
  const list = await old.call('aiAssistants', {});
  assert.equal(list.ok, true);
  assert.equal(list.supported, false);
  assert.equal((await old.call('setAiAssistant', { id: 'ai2' })).error.code, 'UNSUPPORTED');
  assert.equal((await old.call('setAiAssistant', { id: null })).ok, true);
});

test('choosing the FinTrack assistant (configured OpenAI / Gemini / DeepSeek) → FinTrack answers by itself without the Deplao assistant; switching back to Deplao works', async () => {
  const answer = JSON.stringify({ reply: 'OK', actions: [] });
  const env = await setup({ aiAnswers: [answer] });
  await env.call('api', { method: 'GET', path: '/auth/session' });
  // Profile without an API key → FinTrack refuses and the previous choice is kept.
  const noKey = await env.call('setAiAssistant', { source: 'fintrack', profileId: 'p2' });
  assert.equal(noKey.ok, false);
  assert.match(noKey.error.message, /API key/);
  assert.equal((await env.call('aiAssistants', {})).choice.source, 'deplao');

  const pick = await env.call('setAiAssistant', { source: 'fintrack', profileId: 'p1' });
  assert.equal(pick.ok, true, JSON.stringify(pick));
  assert.deepEqual(pick.choice, { source: 'fintrack', id: 'p1' });
  assert.equal(pick.assistant.name, 'OpenAI');
  const list = await env.call('aiAssistants', {});
  assert.deepEqual(list.choice, { source: 'fintrack', id: 'p1' });
  assert.equal(list.selectedId, '');

  const body = { conversationId: '5d62cafd-5215-59cf-be79-b2beb4cb1d2c', text: 'Cafe 30k' };
  const r = await env.call('api', { method: 'POST', path: '/assistant/chat', body });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.body.provider, 'openai');
  assert.equal(r.body.actions[0].amount, '30000');
  assert.equal(env.calls.filter((c) => c.op === 'aiChat').length, 0, 'Deplao assistant not called');
  const req = env.normalRequests().filter((x) => x.path === '/api/assistant/chat').pop();
  assert.equal(req.headers['X-FinTrack-AI'], 'fintrack');
  assert.equal(req.headers['X-FinTrack-Assistant'], undefined);
  assert.equal((await env.call('aiAssistants', {})).choice.source, 'fintrack');

  // Back to the Deplao assistant → 428 → aiChat as before.
  assert.equal((await env.call('setAiAssistant', { source: 'deplao', id: 'ai2' })).ok, true);
  assert.equal((await env.call('api', { method: 'POST', path: '/assistant/chat', body })).status, 200);
  assert.equal(env.calls.filter((c) => c.op === 'aiChat')[0].params.assistant_id, 'ai2');
  assert.equal(env.normalRequests().filter((x) => x.path === '/api/assistant/chat').pop().headers['X-FinTrack-AI'], 'deplao');
});

test('clearSession by token: a slow request that gets 401 for the old session does not clear the new one', async () => {
  const env = await setup({});
  await state.setSession(env.deplao, { token: 'moi', expiresAt: Date.now() + 1e6, workspaceId: 'ws1' });
  await state.clearSession(env.deplao, 'ws1', { token: 'cu' });
  assert.equal((await state.getSession(env.deplao, 'ws1')).token, 'moi');
  await state.clearSession(env.deplao, 'ws1', { token: 'moi' });
  assert.equal(await state.getSession(env.deplao, 'ws1'), null);
  await state.clearSession(env.deplao, '', {}); // no workspace → no-op
});

test('minting a session: workspace gone (workspace_not_found) → forgotten; old Worker (404 not_found) → account kept, asks to update', async () => {
  const env = await setup({});
  await state.rememberAccount(env.deplao, { workspaceId: 'ws9', email: 'cu@example.com', name: 'Cũ' });
  await state.setActive(env.deplao, { workspaceId: 'ws9', email: 'cu@example.com', name: 'Cũ' });
  const gone = await env.call('api', { method: 'GET', path: '/auth/session' });
  assert.equal(gone.error.code, 'WORKSPACE_GONE');
  assert.deepEqual((await env.call('accounts', {})).accounts, []);
  assert.equal(await state.getActive(env.deplao), null);

  const old = await setup({ fintrackOpts: { noSessionRoute: true } });
  await state.rememberAccount(old.deplao, { workspaceId: 'ws1', email: 'lan@example.com', name: 'Lan' });
  await state.setActive(old.deplao, { workspaceId: 'ws1', email: 'lan@example.com', name: 'Lan' });
  const outdated = await old.call('api', { method: 'GET', path: '/auth/session' });
  assert.equal(outdated.error.code, 'FT_NO_INTEGRATION');
  assert.match(outdated.error.message, /Cập nhật FinTrack/);
  assert.deepEqual((await old.call('accounts', {})).accounts.map((a) => a.workspaceId), ['ws1'], 'not forgotten because of an old Worker');
});
