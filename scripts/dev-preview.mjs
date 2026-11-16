#!/usr/bin/env node
/**
 * Preview the app UI in a regular browser, without Deplao:
 *  - REAL FinTrack (API + D1 in workerd via Miniflare, data in memory) on a localhost port, presented as if it ran at
 *    a workers.dev address (--public-url): every request to that address is routed to the localhost port;
 *  - the app folders (ui/, vendor/fintrack/app/) are served at http://127.0.0.1:4319 with a fake Deplao SDK
 *    (/__deplao/sdk.js): deplao.backend.call → the app's real backend, running in this process;
 *  - a fake Deplao AI assistant (reads the Context in the prompt, parses "<number>k") and a fake Cloudflare
 *    (connected, Worker already there).
 *
 * Run (needs the FinTrack repo after `npm install`, next to this repo or pointed to by FINTRACK_DIR; see CONTRIBUTING.md):
 *   npm run preview -- [--fresh | --demo | --undeployed] [--port 4319] [--public-url https://fintrack.ten-ban.workers.dev]
 *  --fresh       FinTrack has no accounts yet (shows the first sign-up screen). Default: registered + demo data.
 *  --demo        like the default, plus: two remembered accounts and a few Zalo group messages that went through the
 *                FinTrack node and became drafts awaiting confirmation (used for the docs screenshots: npm run shots).
 *  --undeployed  like a first install: not deployed (no Worker yet), no FinTrack accounts; click "Triển khai FinTrack"
 *                on the Options page to walk through the whole setup flow.
 * Serves only ui/ and vendor/fintrack/app/ on 127.0.0.1, never on an external network. POST /__mock/node runs one of
 * the app's workflow nodes with a trigger you supply (preview only).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fintrackDir } from './lib/fintrack-dir.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fintrackRoot = fintrackDir(pluginRoot);
const require = createRequire(import.meta.url);
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const undeployed = process.argv.includes('--undeployed');
const fresh = undeployed || process.argv.includes('--fresh');
const demo = !fresh && process.argv.includes('--demo');
const port = Number(arg('--port')) || 4319;
const PUBLIC_URL = String(arg('--public-url') || 'https://fintrack.ten-ban.workers.dev').replace(/\/+$/, '');
const workersSubdomain = (/^https:\/\/[^.]+\.([^.]+)\.workers\.dev$/.exec(PUBLIC_URL) || [])[1] || 'ten-ban';
const fromFinTrack = (rel) => import(pathToFileURL(path.join(fintrackRoot, ...rel.split('/'))).href);

process.env.DEPLAO_PLUGIN_DIR = pluginRoot;
const { openDatabase } = await fromFinTrack('apps/api/src/d1-test.ts');
const { createApp } = await fromFinTrack('apps/api/src/app.ts');
const backend = require(path.join(pluginRoot, 'backend', 'index.js'));
const { createFakeDeplao } = require(path.join(pluginRoot, 'test', 'helpers', 'fakes.js'));
const { readBundleInfo } = require(path.join(pluginRoot, 'backend', 'lib', 'cloudflare.js'));

// Demo accounts (only in this preview's memory).
const OWNER = { email: 'chu@example.com', password: 'matkhau12345', displayName: 'Chủ nhà' };
const SECOND = { email: 'em@example.com', password: 'matkhau-em-01', displayName: 'Em gái' };

// ── Fake AI assistant ───────────────────────────────────────────────────────

const ACTION_KEYS = ['type', 'accountId', 'destinationAccountId', 'categoryId', 'instrumentId', 'side', 'amount', 'quantity', 'quantityUnit', 'price', 'currency', 'fee', 'tax', 'date', 'note', 'name', 'annualRate', 'maturityDate', 'unsure'];
const CATEGORY_HINTS = [
  [/xăng|xe|grab|taxi|gửi xe/, /di chuyển|đi lại|xe/i],
  [/ăn|cafe|cà phê|trưa|tối|sáng|trà sữa/, /ăn uống/i],
  [/điện|nước|internet|wifi|gas/, /sinh hoạt|hoá đơn|hóa đơn|nhà/i],
  [/sữa|bỉm|bé|con/, /con cái|gia đình|mua sắm/i],
];

/**
 * A "<text> <number>k" line → an expense like the real assistant makes (category guessed from keywords, note without
 * the amount), or null.
 * No wallet is picked: FinTrack picks one from the message text ("tiền mặt" → the cash wallet) or the default wallet,
 * as with a real AI.
 * As in FinTrack's prompt: a keyword that matches no category of the account → closest guess + unsure; no keyword →
 * empty category + unsure (the user picks one right on the draft).
 */
function draftFrom(line, ctx) {
  const k = /(\d+)\s*k\b/i.exec(line);
  if (!k) return null;
  const lower = line.toLowerCase();
  const expense = ctx.categories.filter((c) => c.kind === 'expense');
  const hint = CATEGORY_HINTS.find(([kw]) => kw.test(lower));
  const matched = hint && expense.find((c) => hint[1].test(c.name));
  const category = matched || (hint ? expense[0] : null);
  const note = line.replace(k[0], '').replace(/\s+([,.;])/g, '$1').replace(/\s+/g, ' ').replace(/[\s,.;]+$/, '').trim()
    .replace(/^./, (c) => c.toUpperCase()).slice(0, 60);
  return {
    type: 'expense', accountId: null, categoryId: category ? category.id : null, amount: String(Number(k[1]) * 1000), currency: 'VND', date: ctx.today, note,
    unsure: matched ? [] : ['categoryId'],
  };
}

/** Photo sent without text → like the real assistant reading a transfer screenshot: an expense draft, category and direction unsure. */
const imageDraft = (ctx) => ({
  type: 'expense', accountId: null, categoryId: null, amount: '10000000', currency: null, date: ctx.today, note: 'Nguyen Van A chuyển tiền',
  unsure: ['categoryId', 'type'],
});

// Fake OpenAI / Gemini for FinTrack's own assistant (the preview's "OpenAI" and "Gemini" profiles).
async function fakeOpenAI(url, init = {}) {
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  // Gemini: Interactions API v1, content { type: 'text' | 'image' | 'audio' }, returns steps.
  const gemini = String(url).startsWith('https://generativelanguage.googleapis.com/');
  const steps = (text) => json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }], usage: { total_tokens: 2 } });
  if (gemini && String(url).includes('/models'))
    return json({ models: ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'].map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })) });
  if (String(url).endsWith('/models')) return json({ data: [{ id: 'gpt-6-luna', created: 2 }, { id: 'gpt-5-mini', created: 1 }] });
  if (String(url).endsWith('/audio/transcriptions')) return json({ text: 'ăn sáng ba mươi nghìn' });
  const body = JSON.parse(init.body);
  if (gemini && body.input.some((p) => p.type === 'audio')) return steps('ăn sáng ba mươi nghìn');
  const system = gemini ? body.system_instruction : body.instructions;
  const ctx = JSON.parse(system.slice(system.lastIndexOf('\nContext: ') + '\nContext: '.length));
  const parts = body.input[body.input.length - 1].content;
  const line = String((parts.find((p) => p.type === (gemini ? 'text' : 'input_text')) || {}).text || '').split('\n').pop();
  const image = parts.some((p) => p.type === (gemini ? 'image' : 'input_image'));
  const draft = draftFrom(line, ctx) || (image ? imageDraft(ctx) : null);
  const actions = draft ? [{ ...Object.fromEntries(ACTION_KEYS.map((key) => [key, null])), ...draft }] : [];
  const reply = !draft
    ? 'Bạn chi bao nhiêu tiền?'
    : draft.unsure.length
      ? `Bản nháp chi ${Number(draft.amount).toLocaleString('vi-VN')} ₫: chọn ${draft.unsure.includes('type') ? 'danh mục (đổi sang khoản thu nếu đây là tiền bạn nhận)' : 'danh mục'} rồi xác nhận.`
      : 'Đã tạo bản nháp, kiểm tra rồi xác nhận.';
  const answer = { reply, actions };
  if (gemini) return steps(JSON.stringify(answer));
  return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }], usage: { input_tokens: 1, output_tokens: 1 } });
}

// Fake Deplao AI assistant (aiChat raw_system).
function deplaoAssistant(params) {
  const system = params.messages.find((m) => m.role === 'system').content;
  const ctx = JSON.parse(system.slice(system.lastIndexOf('\nContext: ') + '\nContext: '.length));
  const line = params.messages[params.messages.length - 1].content.split('\n').pop();
  const draft = draftFrom(line, ctx);
  if (!draft) return JSON.stringify({ reply: 'Bạn chi bao nhiêu tiền?', actions: [] });
  const reply = draft.unsure.length ? `Bản nháp chi ${Number(draft.amount).toLocaleString('vi-VN')} ₫: chọn danh mục rồi xác nhận.` : 'Đã tạo bản nháp, kiểm tra rồi xác nhận.';
  return JSON.stringify({ reply, actions: [draft] });
}

// ── Real FinTrack ───────────────────────────────────────────────────────────
// The Worker's integration secret: a "deploy" (--undeployed) that sets a new secret → rebuild the app with it, like a real Worker.
let SECRET = crypto.randomBytes(32).toString('base64url');
const db = await openDatabase(':memory:');
const appOptions = (secret) => ({ integrationSecret: secret, speechAI: { run: async () => ({ text: 'ăn sáng ba mươi nghìn' }) }, assistantFetch: fakeOpenAI });
let app = createApp(db, appOptions(SECRET));
if (!fresh) {
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: OWNER });
  const cookie = String([].concat(reg.headers['set-cookie'])[0]).split(';')[0];
  await app.inject({ method: 'POST', url: '/api/demo', headers: { cookie }, payload: {} });
  // Two FinTrack assistant profiles (fake keys, answered by the fake OpenAI / Gemini above) and a second account to try switching.
  await app.inject({ method: 'POST', url: '/api/assistant/profiles', headers: { cookie }, payload: { name: 'OpenAI', provider: 'openai', model: 'gpt-6-luna', apiKey: 'sk-preview-0123456789' } });
  await app.inject({ method: 'POST', url: '/api/assistant/profiles', headers: { cookie }, payload: { name: 'Gemini', provider: 'gemini', model: 'gemini-3.8-flash', apiKey: 'AIza-preview-0123456789' } });
  await app.inject({ method: 'POST', url: '/api/integration/accounts', headers: { authorization: `Bearer ${SECRET}` }, payload: SECOND });
}
const api = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const payload = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks).toString('utf8');
  const r = await app.inject({ method: req.method, url: req.url, headers: { ...req.headers }, payload });
  const headers = {};
  for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !['content-length', 'transfer-encoding', 'connection'].includes(k)) headers[k] = v;
  res.writeHead(r.statusCode, headers);
  res.end(r.body);
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const apiUrl = `http://127.0.0.1:${api.address().port}`;

let workerExists = !undeployed;
let workerModifiedOn = Date.now() - 3 * 86_400_000;

/** Attached custom domains (fake): hostname → when "Cloudflare has finished DNS + certificate" (a few seconds after attaching). */
const customDomains = new Map();

/** Fake deplao.http.fetch: the public address (--public-url) / a ready custom domain → the FinTrack Worker on localhost. */
async function realFetch(url, init = {}) {
  let target = url;
  const host = new URL(url).host;
  if (url.startsWith(PUBLIC_URL)) {
    if (!workerExists) throw Object.assign(new Error(`http.fetch: getaddrinfo ENOTFOUND ${new URL(PUBLIC_URL).host}`), { code: 'UPSTREAM_ERROR' });
    target = apiUrl + url.slice(PUBLIC_URL.length);
  } else if (customDomains.has(host)) {
    if (Date.now() < customDomains.get(host)) throw Object.assign(new Error(`http.fetch: getaddrinfo ENOTFOUND ${host}`), { code: 'UPSTREAM_ERROR' });
    target = apiUrl + url.slice(`https://${host}`.length);
  }
  const r = await fetch(target, { method: init.method || 'GET', headers: init.headers, body: init.body });
  const headers = {};
  r.headers.forEach((v, k) => { headers[k] = v; });
  const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  if (cookies.length) headers['set-cookie'] = cookies;
  return { status: r.status, url, headers, truncated: false, text: await r.text() };
}

// Migrations of the bundled package: a new D1 (--undeployed) applies them all, an existing D1 reports them as skipped.
let migrationNames = [];
try {
  migrationNames = fs.readdirSync(path.join(pluginRoot, 'vendor', 'fintrack', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
} catch { /* not vendored yet */ }
let d1Exists = !undeployed;
let migrated = !undeployed;
const cloudflare = {
  status: async () => ({ connected: true, accountId: 'acc', accountName: 'Cloudflare của tôi', workersSubdomain, prefix: 'fintrack', missing: [] }),
  zones: async () => [{ id: 'z1', name: 'ten-ban.vn' }, { id: 'z2', name: 'cuahang.vn' }],
  d1: {
    ensure: async () => {
      const created = !d1Exists;
      d1Exists = true;
      return { uuid: 'd1', name: 'fintrack', created };
    },
    migrate: async () => {
      const first = !migrated;
      migrated = true;
      return first ? { applied: migrationNames, skipped: [] } : { applied: [], skipped: migrationNames };
    },
    query: async () => ({ results: [] }),
  },
  workers: {
    get: async () => (workerExists ? { exists: true, modifiedOn: new Date(workerModifiedOn).toISOString(), url: PUBLIC_URL } : { exists: false }),
    deployBundle: async (input) => {
      const secret = input && input.secrets && input.secrets.DEPLAO_INTEGRATION_SECRET;
      if (secret && secret !== SECRET) {
        SECRET = secret;
        app = createApp(db, appOptions(SECRET));
      }
      workerExists = true;
      workerModifiedOn = Date.now();
      return { name: 'fintrack', url: PUBLIC_URL, deployedAt: workerModifiedOn };
    },
    // Custom domains: attached at once (the real Deplao asks in a dialog first), DNS + certificate "ready" after 6 seconds.
    domains: {
      list: async () => [...customDomains.keys()].map((hostname, i) => ({ id: `d${i + 1}`, hostname, zoneId: 'z1', zoneName: hostname.split('.').slice(-2).join('.') })),
      attach: async (name, hostname) => {
        const created = !customDomains.has(hostname);
        if (created) customDomains.set(hostname, Date.now() + 6000);
        return { id: 'd1', hostname, zoneId: 'z1', zoneName: hostname.split('.').slice(-2).join('.'), created };
      },
      detach: async (name, hostname) => ({ removed: customDomains.delete(hostname) }),
    },
  },
};
const env = createFakeDeplao({ fintrack: { handle: realFetch }, aiDefault: deplaoAssistant, cloudflare });

if (!undeployed) {
  await env.deplao.storage.set('integration.secret', SECRET);
  // Deployed with the bundle this preview serves (same build), so the Options page shows an up-to-date Worker.
  const bundle = readBundleInfo(pluginRoot);
  await env.deplao.storage.set('deploy', { workerName: 'fintrack', url: PUBLIC_URL, deployedAt: workerModifiedOn, fintrackVersion: bundle.version || '0.1.0', build: bundle.build || '' });
}
// As in a real install: the secret and address are saved by the deploy, the app settings stay empty.
const ctx = { deplao: env.deplao, settings: {} };

const call = async (name, params) => {
  const r = await backend.commands[name](params, ctx);
  if (!r.ok) throw new Error(`${name}: ${r.error && r.error.message}`);
  return r;
};

if (demo) {
  await call('login', { email: SECOND.email, password: SECOND.password, remember: true });
  await call('login', { email: OWNER.email, password: OWNER.password, remember: true });
  const messages = [['u2', 'Lan', 'Ăn trưa cả nhà 250k'], ['u1', 'Bình', 'Đổ xăng 80k'], ['u3', 'Mai', 'Mua sữa cho bé 320k']];
  for (const [i, [fromId, fromName, content]] of messages.entries()) {
    const trigger = { fromId, fromName, content, images: [], threadId: 'g1', threadType: 1, isGroup: true, groupName: 'Chi tiêu gia đình', msgId: `demo${i}`, cliMsgId: `c${i}`, timestamp: Date.now() - (messages.length - i) * 3_600_000, isSelf: false, zaloId: 'acc1' };
    await backend.nodes['fintrack.record']({ account: 'acc1' }, { trigger, pageId: 'acc1' }, ctx);
  }
}

// ── Fake Deplao SDK for the browser ──────────────────────────────────────────
const SDK = `(function () {
  if (window.deplao) return;
  var PUBLIC_URL = ${JSON.stringify(PUBLIC_URL)}, API_URL = ${JSON.stringify(apiUrl)};
  function post(body) {
    return fetch('/__mock/backend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); });
  }
  var ok = function () { return Promise.resolve({ ok: true }); };
  window.deplao = {
    __sdk: true,
    backend: { call: function (name, params) { return post({ name: name, params: params || {} }); } },
    ready: function (cb) { setTimeout(function () { cb({ pluginId: 'io.github.babyvibe.fintrack', kind: 'page', context: null, theme: { mode: 'light', vars: {} }, settings: {} }); }, 0); return function () {}; },
    ui: {
      toast: function (m, k) { console.log('[toast:' + (k || 'info') + '] ' + m); return ok(); },
      openExternal: function (u) { window.open(u.indexOf(PUBLIC_URL) === 0 ? API_URL + u.slice(PUBLIC_URL.length) : u, '_blank'); return ok(); },
      openConversation: ok, navigate: ok,
      theme: function () { return { mode: 'light', vars: {} }; }, context: function () { return null; },
      onTheme: function () { return function () {}; }, onContext: function () { return function () {}; },
    },
    system: { info: function () { return Promise.resolve({ appVersion: '26.11.0', apiVersion: 1 }); } },
  };
})();`;

function placeholderAvatar(url) {
  const hue = [...url].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 360, 7);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="hsl(${hue},55%,55%)"/><circle cx="20" cy="16" r="7" fill="hsl(${hue},55%,85%)"/><rect x="8" y="26" width="24" height="14" rx="7" fill="hsl(${hue},55%,85%)"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff': 'font/woff', '.woff2': 'font/woff2' };
// CSP close to Deplao's plugin pages (script-src 'self', connect-src 'self', no external frames).
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'";

/** Served folders (as in Deplao: the app pages + the FinTrack UI); backend / test / .git are never exposed. */
const SERVED = ['ui', 'vendor/fintrack/app'].map((d) => path.join(pluginRoot, ...d.split('/')));

function send(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') || {} };
  } catch {
    return { ok: false };
  }
}

function sendJson(res, value) {
  res.writeHead(200, { 'content-type': 'application/json' });
  // Fake avatars (https://*.zadn.vn) → local colored images: the preview never calls Zalo's CDN.
  res.end(JSON.stringify(value ?? null).replace(/https:\/\/[a-z0-9.-]+\.zadn\.vn\/[^"\\]*/g, placeholderAvatar));
}

const site = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && (url.pathname === '/__mock/backend' || url.pathname === '/__mock/node')) {
    const body = await readJson(req);
    if (!body.ok) {
      send(res, 400, 'Invalid JSON');
      return;
    }
    if (url.pathname === '/__mock/node') {
      const { type, config, trigger } = body.value;
      const fn = Object.hasOwn(backend.nodes, type) ? backend.nodes[type] : null;
      if (!fn) {
        send(res, 404, `No such node: ${type}`);
        return;
      }
      sendJson(res, await fn(config || {}, { trigger, pageId: (trigger && trigger.zaloId) || 'acc1' }, ctx));
      return;
    }
    const { name, params } = body.value;
    const fn = Object.hasOwn(backend.commands, name) ? backend.commands[name] : null;
    sendJson(res, typeof fn === 'function' ? await fn(params || {}, ctx) : { ok: false, error: { code: 'NOT_FOUND', message: `No such command: ${name}` } });
    return;
  }
  if (url.pathname === '/__deplao/sdk.js') {
    res.writeHead(200, { 'content-type': MIME['.js'] });
    res.end(SDK);
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    send(res, 400, 'Invalid path');
    return;
  }
  if (!rel) {
    res.writeHead(302, { location: '/ui/index.html' });
    res.end();
    return;
  }
  let file = path.resolve(pluginRoot, ...rel.split('/'));
  if (!SERVED.some((dir) => file === dir || file.startsWith(dir + path.sep))) {
    send(res, 403, 'Only ui/ and vendor/fintrack/app/ are served');
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    send(res, 404, 'Not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP, 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => site.listen(port, '127.0.0.1', resolve));
const accountsNote = undeployed ? ' (not deployed yet: click "Triển khai FinTrack" on the Options page)'
  : fresh ? ' (no accounts yet)'
    : ` (${OWNER.email} / ${OWNER.password}, with demo data${demo ? '; demo drafts from Zalo group messages' : ''})`;
console.log(`FinTrack API: ${apiUrl}, served as ${PUBLIC_URL}${accountsNote}`);
console.log(`Preview: http://127.0.0.1:${port}/ui/index.html  ·  Options: http://127.0.0.1:${port}/ui/index.html#options`);
