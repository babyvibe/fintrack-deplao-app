#!/usr/bin/env node
/**
 * End-to-end test against REAL FinTrack: the FinTrack API (D1 in workerd via Miniflare) runs on a localhost port;
 * the app backend (UI proxy, workflow nodes) calls it through a fake deplao.http.fetch; a fake Deplao AI assistant
 * reads the Context in FinTrack's prompt and returns JSON. No Deplao, Cloudflare or network needed.
 *
 * Run (needs FinTrack's tsx + miniflare; the FinTrack repo next to this repo or pointed to by FINTRACK_DIR):
 *   npm run e2e        (= node scripts/with-fintrack.mjs scripts/e2e-fintrack.mjs, which runs FinTrack's tsx)
 */
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fintrackDir } from './lib/fintrack-dir.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fintrackRoot = fintrackDir(pluginRoot);
const require = createRequire(import.meta.url);
const fromFinTrack = (rel) => import(pathToFileURL(path.join(fintrackRoot, ...rel.split('/'))).href);

const { openDatabase } = await fromFinTrack('apps/api/src/d1-test.ts');
const { createApp } = await fromFinTrack('apps/api/src/app.ts');
const backend = require(path.join(pluginRoot, 'backend', 'index.js'));
const proxy = require(path.join(pluginRoot, 'backend', 'lib', 'proxy.js'));
const { createFakeDeplao, textTrigger } = require(path.join(pluginRoot, 'test', 'helpers', 'fakes.js'));

// Backend logs are not needed in the output.
const log = console.log.bind(console);
console.log = () => {};
console.warn = () => {};

// ── Real FinTrack on localhost ───────────────────────────────────────────────
const SECRET = crypto.randomBytes(32).toString('base64url');
const WHISPER_TEXT = 'ăn sáng ba mươi nghìn';
const db = await openDatabase(':memory:');

// ── Fake OpenAI / Gemini for FinTrack's own assistant (profiles in FinTrack): reads the Context in the system prompt ──
const openaiCalls = [];
const ACTION_KEYS = ['type', 'accountId', 'destinationAccountId', 'categoryId', 'instrumentId', 'side', 'amount', 'quantity', 'quantityUnit', 'price', 'currency', 'fee', 'tax', 'date', 'note', 'name', 'annualRate', 'maturityDate', 'unsure'];
/** The next photo is a bank transfer with no clear purpose: an expense draft, category left to the user (unsure). */
let nextImageUnsure = false;
async function fakeOpenAI(url, init = {}) {
  // Gemini: Interactions API v1, key in x-goog-api-key, content { type: 'text' | 'image' }, returns steps.
  const gemini = String(url).startsWith('https://generativelanguage.googleapis.com/');
  openaiCalls.push({ url: String(url), auth: init.headers && (gemini ? init.headers['x-goog-api-key'] : init.headers.Authorization) });
  if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'gpt-6-luna', created: 1 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const body = JSON.parse(init.body);
  const system = gemini ? body.system_instruction : body.instructions;
  const ctx = JSON.parse(system.slice(system.lastIndexOf('\nContext: ') + '\nContext: '.length));
  const parts = body.input[body.input.length - 1].content;
  const text = parts.find((p) => p.type === (gemini ? 'text' : 'input_text')).text;
  const image = parts.find((p) => p.type === (gemini ? 'image' : 'input_image'));
  openaiCalls[openaiCalls.length - 1].image = !image ? null : gemini ? `data:${image.mime_type};base64,${image.data}` : image.image_url;
  const line = text.split('\n').pop();
  const k = /(\d+)\s*k\b/i.exec(line);
  // Photo: "reads" a receipt for 120,000 VND.
  const amount = k ? Number(k[1]) * 1000 : image ? 120000 : 0;
  const actions = amount ? [Object.fromEntries(ACTION_KEYS.map((key) => [key, null]))] : [];
  if (amount) Object.assign(actions[0], { type: 'expense', accountId: ctx.defaultAccountId, categoryId: ctx.categories.find((c) => c.kind === 'expense').id, amount: String(amount), currency: 'VND', date: ctx.today, note: image ? 'Hoá đơn siêu thị (ảnh)' : line.slice(0, 60), unsure: [] });
  if (image && nextImageUnsure) {
    nextImageUnsure = false;
    Object.assign(actions[0], { amount: '10000000', categoryId: null, note: 'Nguyen Van A chuyển tiền', unsure: ['categoryId'] });
  }
  const answer = { reply: amount ? `${gemini ? 'Gemini' : 'OpenAI'}: đã tạo bản nháp.` : 'Bao nhiêu tiền?', actions };
  if (gemini) return new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'thought', signature: 's' }, { type: 'model_output', content: [{ type: 'text', text: JSON.stringify(answer) }] }], usage: { total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const app = createApp(db, { integrationSecret: SECRET, speechAI: { run: async () => ({ text: WHISPER_TEXT }) }, assistantFetch: fakeOpenAI });
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const payload = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks).toString('utf8');
    const r = await app.inject({ method: req.method, url: req.url, headers: { ...req.headers }, payload });
    const headers = {};
    for (const [k, v] of Object.entries(r.headers)) {
      if (v !== undefined && !['content-length', 'transfer-encoding', 'connection'].includes(k)) headers[k] = v;
    }
    res.writeHead(r.statusCode, headers);
    res.end(r.body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err && err.stack));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

/** Fake deplao.http.fetch → real HTTP to FinTrack (keeps set-cookie as an array, like Node http). */
async function realFetch(url, init = {}) {
  const r = await fetch(url, { method: init.method || 'GET', headers: init.headers, body: init.body });
  const headers = {};
  r.headers.forEach((v, k) => { headers[k] = v; });
  const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  if (cookies.length) headers['set-cookie'] = cookies;
  return { status: r.status, url, headers, truncated: false, text: await r.text() };
}

// ── Fake Deplao AI assistant: reads the Context in the system prompt, parses "<number>k" ──
const aiCalls = [];
function deplaoAssistant(params) {
  aiCalls.push(params);
  const system = params.messages.find((m) => m.role === 'system').content;
  const ctx = JSON.parse(system.slice(system.lastIndexOf('\nContext: ') + '\nContext: '.length));
  const user = params.messages[params.messages.length - 1].content;
  const line = user.split('\n').pop();
  const k = /(\d+)\s*k\b/i.exec(line);
  const category = ctx.categories.find((c) => c.kind === 'expense');
  if (!k) return '```json\n{"reply":"Khoản này bao nhiêu tiền?","actions":[]}\n```';
  // Drop the null keys + wrap in ```json to exercise FinTrack's lenient parser.
  return '```json\n' + JSON.stringify({
    reply: 'Đã tạo bản nháp, kiểm tra rồi xác nhận.',
    actions: [{ type: 'expense', accountId: ctx.defaultAccountId, categoryId: category.id, amount: Number(k[1]) * 1000, date: ctx.today, note: line.slice(0, 60) }],
  }) + '\n```';
}

const env = createFakeDeplao({
  fintrack: { handle: realFetch },
  aiDefault: deplaoAssistant,
  messages: {
    v1: {
      msg_id: 'v1', msg_type: 'chat.voice',
      content: JSON.stringify({ href: 'https://voice.example/v1.m4a', params: JSON.stringify({ duration: 3000 }) }),
      media: { name: 'voice_v1.m4a', mime: 'audio/mp4', size: 4, base64: 'AAAAGGZ0eXBNNEEg' },
    },
    // Receipt photo (a tiny JPEG) in the group.
    ph1: {
      msg_id: 'ph1', msg_type: 'chat.photo',
      content: JSON.stringify({ title: '', href: 'https://photo.example/ph1.jpg', params: JSON.stringify({ hd: 'https://photo.example/ph1-hd.jpg' }) }),
      media: { name: 'ph1.jpg', mime: 'image/jpeg', size: 12, base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64') },
    },
  },
});
// ph2 / ph3 / ph4: the ph1 photo sent again (a different message → not blocked as a duplicate).
const samePhoto = (msgId) => (['ph2', 'ph3', 'ph4'].includes(msgId) ? 'ph1' : msgId);
env.deplao.chat.getMessage = ((orig) => async (p) => orig({ ...p, msgId: samePhoto(p.msgId) }))(env.deplao.chat.getMessage);
env.deplao.chat.downloadMessageMedia = ((orig) => async (p) => orig({ ...p, msgId: samePhoto(p.msgId) }))(env.deplao.chat.downloadMessageMedia);
const ctx = { deplao: env.deplao, settings: { fintrackUrl: baseUrl, integrationSecret: SECRET } };
const call = (method, p, body) => proxy.forward(ctx, { method, path: p, body });
const record = backend.nodes['fintrack.record'];
const transcribe = backend.nodes['fintrack.transcribe'];
const integrationCalls = () => env.calls.filter((c) => c.op === 'http.fetch' && c.url.includes('/api/integration/'));

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    log(`✓ ${name}`);
  } catch (err) {
    log(`✗ ${name}\n  ${err && err.stack ? err.stack : err}`);
    server.close();
    await db.close();
    process.exit(1);
  }
}

// ── Scenario ────────────────────────────────────────────────────────────────
await step('New FinTrack: no accounts → the UI shows the sign-up screen', async () => {
  const r = await call('GET', '/auth/session');
  assert.equal(r.status, 200);
  assert.equal(r.body.user, null);
  assert.equal(r.body.needsSetup, true);
});

const savedToken = async () => {
  const active = await env.deplao.storage.get('workspace');
  const map = (await env.deplao.storage.get('sessions')) || {};
  return active && map[active.id] ? map[active.id].token : null;
};

await step('Create the first account in Deplao → admin account, the app keeps the session (the cookie never reaches the UI)', async () => {
  const r = await backend.commands.register({ email: 'chu@example.com', password: 'matkhau12345', displayName: 'Chủ nhà' }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  const token = await savedToken();
  assert.ok(token);
  assert.ok(!JSON.stringify(r).includes(token));
  const s = await call('GET', '/auth/session');
  assert.equal(s.body.user.email, 'chu@example.com');
  assert.equal(s.body.user.isAdmin, true);
});

await step('Demo data through the proxy', async () => {
  assert.equal((await call('POST', '/demo', {})).status, 201);
});

let draft;
await step('The FinTrack AI assistant runs on the Deplao assistant (428 → aiChat raw_system → delegated)', async () => {
  const r = await call('POST', '/assistant/chat', { conversationId: crypto.randomUUID(), text: 'Ăn trưa 50k' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.provider, 'deplao');
  assert.equal(r.body.assistantName, 'Trợ lý chính');
  assert.equal(r.body.actions.length, 1);
  assert.equal(r.body.actions[0].amount, '50000');
  assert.equal(r.body.actions[0].quantity, null);
  const last = aiCalls[aiCalls.length - 1];
  assert.equal(last.raw_system, true);
  assert.equal(last.messages[0].role, 'system');
  draft = r.body;
});

await step('Assistant settings in Deplao: provider deplao, no image reading', async () => {
  const r = await call('GET', '/assistant/settings');
  assert.equal(r.status, 200);
  assert.equal(r.body.provider, 'deplao');
  assert.equal(r.body.supportsImages, false);
  assert.equal(r.body.client, 'deplao');
});

await step('Pick another Deplao assistant → chat uses exactly that assistant (assistant_id, name in FinTrack)', async () => {
  const set = await backend.commands.setAiAssistant({ id: 'ai2' }, ctx);
  assert.equal(set.ok, true, JSON.stringify(set));
  const r = await call('POST', '/assistant/chat', { conversationId: crypto.randomUUID(), text: 'Cafe 30k' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.assistantName, 'Kế toán Đào');
  assert.equal(aiCalls[aiCalls.length - 1].assistant_id, 'ai2');
  assert.equal((await call('GET', '/assistant/settings')).body.name, 'Kế toán Đào');
  assert.equal((await backend.commands.setAiAssistant({ id: null }, ctx)).assistant.name, 'Trợ lý chính');
});

await step('Token usage: Deplao assistant turns (delegated.usage) are added under the right assistant name', async () => {
  const r = await call('GET', '/assistant/usage');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const today = (name) => (r.body.assistants.find((a) => a.assistant === `deplao:${name}`) || {}).today;
  // The fake aiChat returns prompt_tokens 7, completion_tokens 3 per turn; each assistant had one turn in the two steps above.
  assert.deepEqual(today('Trợ lý chính'), { calls: 1, inputTokens: 7, outputTokens: 3 }, JSON.stringify(r.body));
  assert.deepEqual(today('Kế toán Đào'), { calls: 1, inputTokens: 7, outputTokens: 3 }, JSON.stringify(r.body));
});

await step('Confirm the draft → a real transaction in FinTrack', async () => {
  const c = await call('POST', '/assistant/commit', { messageId: draft.id, actionIndex: 0, action: draft.actions[0] });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.saved, true);
  const t = await call('GET', '/transactions');
  assert.equal(t.status, 200);
  assert.ok(JSON.stringify(t.body).includes('Ăn trưa 50k'));
});

await step('Session lost / expired (remembered account) → a new session is requested with the secret, no sign-in needed', async () => {
  await env.deplao.storage.delete('sessions');
  const before = integrationCalls().length;
  const s = await call('GET', '/auth/session');
  assert.equal(s.body.user.email, 'chu@example.com');
  assert.ok(integrationCalls().slice(before).some((c) => c.url.endsWith('/api/integration/session')));
});

await step('Sign out in Deplao → sign-in screen (no automatic sign-in); pick a remembered account → back in without a password', async () => {
  assert.equal((await call('POST', '/auth/logout', {})).status, 204);
  assert.equal(await savedToken(), null);
  const out = await call('GET', '/auth/session');
  assert.equal(out.body.user, null);
  const list = await backend.commands.accounts({}, ctx);
  assert.equal(list.signedOut, true);
  assert.deepEqual(list.accounts.map((a) => [a.email, a.active]), [['chu@example.com', false]]);
  assert.equal((await backend.commands.switchAccount({ workspaceId: list.accounts[0].workspaceId }, ctx)).ok, true);
  assert.equal((await call('GET', '/auth/session')).body.user.email, 'chu@example.com');
  assert.equal((await backend.commands.login({ email: 'chu@example.com', password: 'sai-mat-khau-1' }, ctx)).error.message, 'Email hoặc mật khẩu không đúng');
});

await step('The /integration routes are blocked from the UI; the secret is never sent on regular routes', async () => {
  assert.equal((await call('GET', '/integration/workspaces')).status, 403);
  const normal = env.calls.filter((c) => c.op === 'http.fetch' && !c.url.includes('/api/integration/'));
  assert.ok(normal.length > 5);
  assert.ok(normal.every((c) => !JSON.stringify(c.init.headers || {}).includes(SECRET)));
});

await step('Node fintrack.record, draft mode: waits for confirmation + replies 📝 in the group', async () => {
  const out = await record({ mode: 'draft' }, { trigger: textTrigger({ content: 'Cafe 25k', msgId: 'z1' }), pageId: 'acc1' }, ctx);
  assert.equal(out.skipped, '', JSON.stringify(out));
  assert.equal(out.drafts, 1);
  assert.equal(out.recorded, 0);
  assert.match(env.sent[env.sent.length - 1].text, /^📝 .*Trả lời “ok” để ghi, “huỷ” để bỏ\.$/);
  // Drafts live in FinTrack: the Overview counts them, Chờ xác nhận (pending drafts) lists them with group / sender / message.
  const list = (await call('GET', '/assistant/drafts')).body.drafts;
  const mine = list.find((d) => d.text === 'Cafe 25k');
  assert.ok(mine, JSON.stringify(list));
  assert.deepEqual([mine.source.group, mine.source.sender, mine.actions[0].action.amount], ['Chi tiêu', 'Lan', '25000']);
  assert.equal((await call('GET', '/dashboard')).body.assistantDrafts, list.length);
  assert.equal(await env.deplao.storage.get('drafts'), null, 'the plugin keeps no drafts');
});

await step('Node fintrack.record, auto mode: records items with an amount in the message right away', async () => {
  const out = await record({ mode: 'auto' }, { trigger: textTrigger({ content: 'Ăn tối 120k', msgId: 'z2' }), pageId: 'acc1' }, ctx);
  assert.equal(out.recorded, 1, JSON.stringify(out));
  assert.match(env.sent[env.sent.length - 1].text, /^✅/);
  const t = await call('GET', '/transactions');
  assert.ok(JSON.stringify(t.body).includes('Ăn tối 120k'));
});

await step('The same Zalo message arriving twice → not recorded twice', async () => {
  const out = await record({ mode: 'auto' }, { trigger: textTrigger({ content: 'Ăn tối 120k', msgId: 'z2' }), pageId: 'acc1' }, ctx);
  assert.equal(out.skipped, 'duplicate');
});

await step('Sender writes “ok” in the group → FinTrack records the draft; “huỷ” in reply to the ✅ message → reverses the item just recorded', async () => {
  const before = (await call('GET', '/dashboard')).body;
  const ok = await record({ mode: 'draft' }, { trigger: textTrigger({ content: 'ok', msgId: 'z1-ok' }), pageId: 'acc1' }, ctx);
  assert.equal(ok.recorded, 1, JSON.stringify(ok));
  assert.equal(env.sent.at(-1).text, '✅ Đã ghi: chi 25.000đ (Cafe 25k)');
  const t = await call('GET', '/transactions');
  assert.ok(JSON.stringify(t.body).includes('Cafe 25k'));
  const after = (await call('GET', '/dashboard')).body;
  assert.equal(Number(after.expense), Number(before.expense) + 25000);
  assert.equal(after.assistantDrafts, before.assistantDrafts - 1);
  // “huỷ” replying to (quoting) the assistant's “✅ Đã ghi” message → FinTrack reverses the entry.
  env.messages.set('z1-huy', { msg_id: 'z1-huy', msg_type: 'webchat', content: 'huỷ', quote: { msgId: `sent${env.sent.length}`, cliMsgId: '' } });
  const cancel = await record({ mode: 'draft' }, { trigger: textTrigger({ content: 'huỷ', msgId: 'z1-huy' }), pageId: 'acc1' }, ctx);
  assert.equal(cancel.reply, '↩️ Đã huỷ: chi 25.000đ (Cafe 25k)', JSON.stringify(cancel));
  assert.equal((await call('GET', '/dashboard')).body.expense, before.expense);
});

await step('Node fintrack.transcribe: voice note in the group → text (Whisper on the Worker)', async () => {
  const out = await transcribe({}, { trigger: textTrigger({ content: '', msgId: 'v1' }), pageId: 'acc1' }, ctx);
  assert.equal(out.text, WHISPER_TEXT, JSON.stringify(out));
  assert.equal(out.durationSec, 3);
});

await step('The UI api command (background job) returns the { status, body } shape', async () => {
  const r = await backend.commands.api({ method: 'GET', path: '/bootstrap' }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.accounts));
  const blocked = await backend.commands.api({ method: 'GET', path: '/%69ntegration/health' }, ctx);
  assert.equal(blocked.status, 403);
});

let profileId;
await step('The assistant built into FinTrack, in Deplao: add an OpenAI profile, select it → FinTrack calls OpenAI, not the Deplao assistant', async () => {
  const p = await call('POST', '/assistant/profiles', { name: 'OpenAI riêng', provider: 'openai', model: 'gpt-6-luna', apiKey: 'sk-test-0123456789abcdef' });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  profileId = p.body.profiles.find((x) => x.name === 'OpenAI riêng').id;
  const list = await backend.commands.aiAssistants({}, ctx);
  assert.ok(list.fintrack.profiles.some((x) => x.id === profileId && x.configured), JSON.stringify(list.fintrack));
  const set = await backend.commands.setAiAssistant({ source: 'fintrack', profileId }, ctx);
  assert.equal(set.ok, true, JSON.stringify(set));
  const s = await call('GET', '/assistant/settings');
  assert.equal(s.body.aiSource, 'fintrack');
  assert.equal(s.body.provider, 'openai');
  const before = aiCalls.length;
  const r = await call('POST', '/assistant/chat', { conversationId: crypto.randomUUID(), text: 'Cafe 40k' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.provider, 'openai');
  assert.equal(r.body.assistantName, 'OpenAI riêng');
  assert.equal(r.body.actions[0].amount, '40000');
  assert.equal(aiCalls.length, before, 'the Deplao assistant is not called');
  assert.equal(openaiCalls.at(-1).auth, 'Bearer sk-test-0123456789abcdef');
  // Switch back to the Deplao assistant.
  assert.equal((await backend.commands.setAiAssistant({ source: 'deplao', id: '' }, ctx)).ok, true);
  assert.equal((await call('POST', '/assistant/chat', { conversationId: crypto.randomUUID(), text: 'Cafe 20k' })).body.provider, 'deplao');
  assert.equal(aiCalls.length, before + 1);
});

let member;
let ownerWorkspace;
let tempPassword;
await step('Multiple accounts: the owner (admin) creates an account in FinTrack → its own workspace; Deplao keeps the owner workspace open', async () => {
  const me = (await call('GET', '/auth/session')).body.user;
  assert.equal(me.isAdmin, true);
  ownerWorkspace = me.workspaceId;
  const r = await call('POST', '/admin/accounts', { email: 'em@example.com', displayName: 'Em gái' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.tempPassword, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  tempPassword = r.body.tempPassword;
  member = r.body.account;
  assert.equal(member.mustChangePassword, true);
  assert.notEqual(member.workspaceId, ownerWorkspace);
  assert.equal((await call('POST', '/auth/register', { email: 'la@example.com', password: 'matkhau12345', displayName: 'Lạ' })).status, 409, 'no public sign-up');
  const st = await backend.commands.status({}, ctx);
  assert.equal(st.fintrack.workspaceState, 'linked', JSON.stringify(st.fintrack));
  assert.equal(st.account.email, 'chu@example.com');
  assert.ok(!JSON.stringify(st).includes('em@example.com'), 'other accounts are not listed');
});

await step('Sign in to another account with its password (remembered) → the workspace of that account; switching back and forth needs no password', async () => {
  const login = await backend.commands.login({ email: 'em@example.com', password: tempPassword, remember: true }, ctx);
  assert.equal(login.ok, true, JSON.stringify(login));
  const s = (await call('GET', '/auth/session')).body.user;
  assert.equal(s.email, 'em@example.com');
  assert.equal(s.isAdmin, false);
  assert.equal((await call('GET', '/admin/accounts')).status, 403);
  const t = await call('GET', '/transactions');
  assert.equal(t.status, 200);
  assert.ok(!JSON.stringify(t.body).includes('Ăn trưa 50k'), 'separate workspace');
  assert.equal((await backend.commands.switchAccount({ workspaceId: ownerWorkspace }, ctx)).ok, true);
  assert.equal((await call('GET', '/auth/session')).body.user.email, 'chu@example.com');
  assert.equal((await backend.commands.switchAccount({ workspaceId: member.workspaceId }, ctx)).ok, true);
  assert.equal((await call('GET', '/auth/session')).body.user.email, 'em@example.com');
  assert.deepEqual((await backend.commands.accounts({}, ctx)).accounts.map((a) => a.email).sort(), ['chu@example.com', 'em@example.com']);
});

await step('Create a new account right in Deplao (sign out → create account) → own workspace, opened at once, remembered', async () => {
  assert.equal((await backend.commands.logout({}, ctx)).ok, true);
  const out = await call('GET', '/auth/session');
  assert.equal(out.body.user, null, 'signed out, no automatic sign-in');
  assert.equal(out.body.needsSetup, false);
  const reg = await backend.commands.register({ displayName: 'Bố', email: 'bo@example.com', password: 'matkhau-bo-123', remember: true }, ctx);
  assert.equal(reg.ok, true, JSON.stringify(reg));
  const u = (await call('GET', '/auth/session')).body.user;
  assert.equal(u.email, 'bo@example.com');
  assert.equal(u.isAdmin, false);
  assert.equal(u.mustChangePassword, false);
  assert.equal((await backend.commands.register({ displayName: 'Trùng', email: 'bo@example.com', password: 'matkhau-bo-123' }, ctx)).error.message, 'Email này đã có tài khoản FinTrack.');
  assert.equal((await backend.commands.accounts({}, ctx)).accounts.length, 3);
});

await step('Zalo group messages are recorded into the account open in Deplao (no group selection step)', async () => {
  assert.equal((await backend.commands.switchAccount({ workspaceId: ownerWorkspace }, ctx)).ok, true);
  const out = await record({ mode: 'auto' }, { trigger: textTrigger({ content: 'Ăn khuya 70k', msgId: 'z9' }), pageId: 'acc1' }, ctx);
  assert.equal(out.recorded, 1, JSON.stringify(out));
  assert.ok(JSON.stringify((await call('GET', '/transactions')).body).includes('Ăn khuya 70k'), 'into the open workspace (owner)');
  assert.equal(env.sent.at(-1).text, '✅ Đã ghi: chi 70.000đ (Ăn khuya 70k)\nSai thì trả lời “huỷ”.');
});

await step('Receipt photo in the group: Deplao assistant → asks to pick a FinTrack assistant; FinTrack assistant (OpenAI) reads the photo → draft', async () => {
  const photo = () => textTrigger({ content: '', msgId: 'ph1', images: ['https://photo.example/ph1-hd.jpg'] });
  // The group's workspace (owner) uses the Deplao assistant → cannot read photos, says so in the group, no AI call.
  assert.equal((await backend.commands.setAiAssistant({ source: 'deplao', id: '' }, ctx)).ok, true);
  const before = openaiCalls.length;
  const skipped = await record({ mode: 'draft' }, { trigger: photo(), pageId: 'acc1' }, ctx);
  assert.equal(skipped.skipped, 'image_unsupported_ai', JSON.stringify(skipped));
  assert.match(env.sent[env.sent.length - 1].text, /chưa đọc được ảnh/);
  // Pick a FinTrack assistant → the photo message (sent again) is read.
  assert.equal((await backend.commands.setAiAssistant({ source: 'fintrack', profileId }, ctx)).ok, true);
  const out = await record({ mode: 'draft' }, { trigger: textTrigger({ content: '', msgId: 'ph2', images: ['https://photo.example/ph1-hd.jpg'] }), pageId: 'acc1' }, ctx);
  assert.equal(out.drafts, 1, JSON.stringify(out));
  const call = openaiCalls.at(-1);
  assert.equal(openaiCalls.length, before + 1);
  assert.match(call.image, /^data:image\/jpeg;base64,\/9j\//, 'the photo reaches OpenAI as a data URL');
  const drafts = (await proxy.forward(ctx, { method: 'GET', path: '/assistant/drafts' })).body.drafts;
  assert.ok(drafts.some((d) => d.text === '[Ảnh]' && d.actions[0].action.amount === '120000'), JSON.stringify(drafts.map((d) => [d.text, d.actions.map((a) => a.action.amount)])));
});

await step('Transfer screenshot without text: assistant unsure of the category → “ok” reports the missing category → pick it in FinTrack (Chờ xác nhận), then record', async () => {
  nextImageUnsure = true;
  const out = await record({ mode: 'auto' }, { trigger: textTrigger({ content: '', msgId: 'ph3', images: ['https://photo.example/ph1-hd.jpg'] }), pageId: 'acc1' }, ctx);
  assert.deepEqual([out.recorded, out.drafts], [0, 1], `unsure items are not auto-recorded: ${JSON.stringify(out)}`);
  const ok = await record({ mode: 'auto' }, { trigger: textTrigger({ content: 'ok', msgId: 'ph3-ok' }), pageId: 'acc1' }, ctx);
  assert.equal(ok.recorded, 0, JSON.stringify(ok));
  assert.match(env.sent.at(-1).text, /^⚠️ Chưa ghi chi 10\.000\.000đ .*: chưa có danh mục\.\nChọn nốt trong FinTrack: Tổng quan → Chờ xác nhận\.$/);
  // Card in Chờ xác nhận (pending drafts): pick a category, then Xác nhận (POST /assistant/commit with the choice).
  const listed = (await call('GET', '/assistant/drafts')).body.drafts;
  const draft = listed.find((d) => d.actions.some((a) => a.action.amount === '10000000'));
  assert.ok(draft, JSON.stringify(listed.map((d) => d.actions.map((a) => a.action.amount))));
  const item = draft.actions[0];
  assert.deepEqual(item.action.unsure, ['categoryId']);
  const living = (await call('GET', '/bootstrap')).body.categories.find((c) => c.kind === 'expense' && c.name === 'Sinh hoạt');
  assert.ok(living);
  const done = await call('POST', '/assistant/commit', { messageId: draft.id, actionIndex: item.index, action: { ...item.action, categoryId: living.id } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const tx = (await call('GET', '/transactions?limit=20')).body.items.find((t) => t.note === 'Nguyen Van A chuyển tiền');
  assert.deepEqual([tx.kind, tx.category, tx.amount], ['expense', 'Sinh hoạt', '-10000000']);
  assert.ok(!(await call('GET', '/assistant/drafts')).body.drafts.some((d) => d.id === draft.id), 'once recorded, it leaves the pending drafts');
});

await step('A FinTrack Gemini assistant reads a receipt photo in the group (Interactions API v1) → draft', async () => {
  const key = 'AIzaSyE2E-gemini-0123456789abcdef';
  const added = await call('POST', '/assistant/profiles', { name: 'Gemini riêng', provider: 'gemini', model: 'gemini-3.8-flash', apiKey: key });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const geminiId = added.body.profiles.find((x) => x.name === 'Gemini riêng').id;
  const list = await backend.commands.aiAssistants({}, ctx);
  assert.ok(list.fintrack.profiles.some((x) => x.id === geminiId && x.provider === 'gemini' && x.configured), JSON.stringify(list.fintrack));
  assert.equal((await backend.commands.setAiAssistant({ source: 'fintrack', profileId: geminiId }, ctx)).ok, true);
  const s = await call('GET', '/assistant/settings');
  assert.deepEqual([s.body.provider, s.body.supportsImages], ['gemini', true]);
  const photoDrafts = async () => (await call('GET', '/assistant/drafts')).body.drafts.filter((d) => d.text === '[Ảnh]' && d.actions[0].action.amount === '120000').length;
  const draftsBefore = await photoDrafts();
  const before = openaiCalls.length;
  const out = await record({ mode: 'draft' }, { trigger: textTrigger({ content: '', msgId: 'ph4', images: ['https://photo.example/ph1-hd.jpg'] }), pageId: 'acc1' }, ctx);
  assert.equal(out.drafts, 1, JSON.stringify(out));
  assert.equal(openaiCalls.length, before + 1);
  const last = openaiCalls.at(-1);
  assert.equal(last.url, 'https://generativelanguage.googleapis.com/v1/interactions');
  assert.equal(last.auth, key);
  assert.match(last.image, /^data:image\/jpeg;base64,\/9j\//, 'the photo reaches Gemini inline');
  assert.equal(await photoDrafts(), draftsBefore + 1);
  // Restore the OpenAI profile for the next steps.
  assert.equal((await backend.commands.setAiAssistant({ source: 'fintrack', profileId }, ctx)).ok, true);
});

await step('Disable an account → Deplao cannot open it (account_disabled), the owner account keeps working', async () => {
  const r = await call('POST', `/admin/accounts/${member.id}/disable`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.disabled, true);
  const sw = await backend.commands.switchAccount({ workspaceId: member.workspaceId }, ctx);
  assert.equal(sw.ok, false);
  assert.match(sw.error.message, /khoá/);
  assert.equal((await call('GET', '/auth/session')).body.user.email, 'chu@example.com');
});

server.close();
await db.close();
log(`\n${passed} steps passed: the app and FinTrack match the contract (docs/CONTRACTS.md).`);
