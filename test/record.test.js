'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const backend = require('../backend/index');
const proxy = require('../backend/lib/proxy');
const { _internal, autoEligible } = require('../backend/lib/record');
const { uuidFromName } = require('../backend/lib/util');
const { findAmounts } = require('../backend/lib/money');
const { createFakeDeplao, seedDeployed, textTrigger, answerJson } = require('./helpers/fakes');

const RECORD = backend.nodes['fintrack.record'];
const TRANSCRIBE = backend.nodes['fintrack.transcribe'];
const CFG = { account: 'acc1', mode: 'draft', replyInGroup: true, quoteReply: true, voice: true };

console.log = () => {};
console.warn = () => {};

function reset() {
  _internal.reset();
  proxy.resetCaches();
}

async function setup(opts = {}) {
  reset();
  const env = createFakeDeplao(opts);
  if (opts.deployed !== false) await seedDeployed(env.deplao);
  const run = (trigger, cfg = CFG) => RECORD(cfg, { trigger, pageId: 'acc1', workflowId: 'wf1' }, { deplao: env.deplao, settings: {} });
  const chats = () => env.fintrack.state.requests.filter((r) => r.path === '/api/assistant/chat');
  const commits = () => env.fintrack.state.requests.filter((r) => r.path === '/api/assistant/commit');
  return { ...env, run, chats, commits };
}

const lunch = { type: 'expense', amount: '50000', accountId: 'cash', categoryId: 'food', note: 'Ăn trưa', currency: 'VND', date: '2026-10-20' };

test('draft (default): FinTrack assistant (one conversation per group, delegating to a Deplao assistant) → pending draft + 📝', async () => {
  const env = await setup({ aiAnswers: [answerJson([lunch])] });
  const out = await env.run(textTrigger());
  assert.equal(out.skipped, '');
  assert.equal(out.recorded, 0);
  assert.equal(out.drafts, 1);
  assert.equal(out.items[0].status, 'draft');
  assert.equal(out.reply, '📝 Bản nháp: chi 50.000đ (Ăn trưa). Trả lời “ok” để ghi, “huỷ” để bỏ.');
  const [first, resend] = env.chats();
  assert.equal(first.body.conversationId, uuidFromName('zalo:acc1:g1'));
  assert.equal(first.body.text, 'Người gửi: Lan\nĂn trưa 50k');
  assert.deepEqual(first.body.inbox, { channel: 'zalo', group: 'Chi tiêu', sender: 'Lan', text: 'Ăn trưa 50k' });
  assert.deepEqual(resend.body.inbox, first.body.inbox, 'the resend after 428 still carries the source');
  assert.equal(resend.body.delegated.model, 'gpt-4o-mini');
  assert.equal(env.commits().length, 0);
  // Drafts live in FinTrack (Tổng quan → Chờ xác nhận); the plugin only remembers reply message ↔ draft.
  const [messageId] = [...env.fintrack.state.drafts.keys()];
  assert.equal(env.fintrack.state.drafts.get(messageId).status, 'pending');
  assert.equal(await env.deplao.storage.get('drafts'), null);
  const [ref] = await env.deplao.storage.get('replies');
  assert.deepEqual({ ...ref, at: 0 }, { ids: ['sent1', 'cli1'], threadId: 'g1', senderId: 'u2', workspaceId: 'ws1', messageId, pending: true, at: 0 });
  assert.deepEqual(env.sent[0], { accountId: 'acc1', threadId: 'g1', text: out.reply, thread_type: 'group', quote_msg_id: 'm100' });
});

test('conversationId: valid UUID v5, stable per (Zalo account, group)', () => {
  const a = uuidFromName('zalo:acc1:g1');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, uuidFromName('zalo:acc1:g1'));
  assert.notEqual(a, uuidFromName('zalo:acc1:g2'));
  assert.notEqual(a, uuidFromName('zalo:acc2:g1'));
});

test('auto: records items whose amount is in the message and whose wallets are set; other items wait for confirmation', async () => {
  const transfer = { type: 'transfer', amount: '200000', accountId: 'vcb', destinationAccountId: null, note: 'Chuyển' };
  const wrong = { type: 'expense', amount: '500000', accountId: 'cash', note: 'Cafe' };
  const env = await setup({ aiAnswers: [answerJson([lunch, transfer, wrong])] });
  const out = await env.run(textTrigger({ content: 'Ăn trưa 50k, chuyển 200k, cafe 25k' }), { ...CFG, mode: 'auto' });
  assert.equal(out.recorded, 1);
  assert.equal(out.drafts, 2);
  assert.deepEqual(out.items.map((i) => i.status), ['recorded', 'draft', 'draft']);
  assert.equal(env.commits().length, 1);
  assert.deepEqual(env.commits()[0].body.actionIndex, 0);
  assert.equal(out.reply, '✅ Đã ghi: chi 50.000đ (Ăn trưa)\n📝 Chờ xác nhận: chuyển 200.000đ (Chuyển), chi 500.000đ (Cafe)\nTrả lời “ok” để ghi nốt, “huỷ” để huỷ cả tin.');
  const [[messageId, draft]] = [...env.fintrack.state.drafts.entries()];
  assert.equal(draft.status, 'pending', 'two items still pending');
  assert.deepEqual([0, 1, 2].map((i) => env.fintrack.state.receipts.has(`${messageId}:${i}`)), [true, false, false]);
});

test('autoEligible: only income / expense / transfer, amount present in the message, wallets set', () => {
  const c = findAmounts('Ăn trưa 50k');
  assert.equal(autoEligible(lunch, c), true);
  assert.equal(autoEligible({ ...lunch, accountId: null }, c), false);
  assert.equal(autoEligible({ ...lunch, amount: '60000' }, c), false);
  assert.equal(autoEligible({ ...lunch, type: 'trade' }, c), false);
  assert.equal(autoEligible({ ...lunch, amount: null }, c), false);
  assert.equal(autoEligible(lunch, findAmounts('ăn trưa')), false, 'no number in the message → no auto-record');
  assert.equal(autoEligible({ type: 'transfer', amount: '50000', accountId: 'a' }, c), false);
  assert.equal(autoEligible({ type: 'transfer', amount: '50000', accountId: 'a', destinationAccountId: 'b' }, c), true);
});

test('autoEligible: assistant unsure about a field, or income / expense without a category → waits for the user to choose', () => {
  const c = findAmounts('Ăn trưa 50k');
  assert.equal(autoEligible({ ...lunch, unsure: [] }, c), true);
  assert.equal(autoEligible({ ...lunch, unsure: null }, c), true);
  assert.equal(autoEligible({ ...lunch, unsure: ['categoryId'] }, c), false);
  assert.equal(autoEligible({ ...lunch, unsure: ['type'] }, c), false);
  assert.equal(autoEligible({ ...lunch, categoryId: null }, c), false);
  assert.equal(autoEligible({ type: 'transfer', amount: '50000', accountId: 'a', destinationAccountId: 'b', categoryId: null }, c), true, 'transfers need no category');
});

test('auto: commit error (missing wallet on the FinTrack side) → kept as a draft with the error', async () => {
  const env = await setup({ aiAnswers: [answerJson([lunch])] });
  const orig = env.fintrack.handle;
  env.deplao.http.fetch = async (url, init) => {
    if (url.endsWith('/api/assistant/commit')) return { status: 400, headers: {}, text: JSON.stringify({ error: 'Danh mục không còn' }) };
    return orig(url, init);
  };
  const out = await env.run(textTrigger(), { ...CFG, mode: 'auto' });
  assert.equal(out.recorded, 0);
  assert.equal(out.drafts, 1);
  assert.equal(out.items[0].error, 'Danh mục không còn');
  assert.match(out.reply, /^📝 Bản nháp/);
});

test('assistant asks a question (no draft, contains "?") → ❓; ordinary answer → silent', async () => {
  const env = await setup({ aiAnswers: [answerJson([], 'Khoản 500k này là chi gì vậy?'), answerJson([], 'Chào bạn!')] });
  const ask = await env.run(textTrigger({ content: 'chuyển 500k nhé' }));
  assert.equal(ask.skipped, 'unclear');
  assert.equal(ask.reply, '❓ Khoản 500k này là chi gì vậy?');
  const quiet = await env.run(textTrigger({ content: 'mai 7h nhé', msgId: 'm101' }));
  assert.equal(quiet.skipped, 'not_transaction');
  assert.equal(env.sent.length, 1);
});

test('no amount → no FinTrack / AI call, nothing written to storage', async () => {
  const env = await setup({});
  const out = await env.run(textTrigger({ content: 'ok cảm ơn cả nhà' }));
  assert.equal(out.skipped, 'no_amount');
  assert.equal(out.text, 'ok cảm ơn cả nhà');
  assert.equal(env.chats().length, 0);
  assert.equal(env.calls.filter((c) => c.op === 'aiChat').length, 0);
  assert.equal(await env.deplao.storage.get('seen'), null, 'filtered before being marked as processed');
});

test('dedupe per Zalo message, persisted in storage (survives a restart)', async () => {
  const env = await setup({ aiAnswers: [answerJson([lunch]), answerJson([lunch])] });
  await env.run(textTrigger());
  assert.equal((await env.run(textTrigger())).skipped, 'duplicate');
  reset(); // process restart: memory is empty but storage is kept
  assert.equal((await env.run(textTrigger())).skipped, 'duplicate');
  const seen = await env.deplao.storage.get('seen');
  assert.ok(seen['zalo:g1:m100'] > 0);
  assert.equal(env.chats().length, 2, 'only one round (428 + resend)');
});

test('same message run in parallel → handled once', async () => {
  const env = await setup({ aiAnswers: [answerJson([lunch]), answerJson([lunch])] });
  const [a, b] = await Promise.all([env.run(textTrigger()), env.run(textTrigger())]);
  assert.deepEqual([a.skipped, b.skipped].sort(), ['', 'duplicate']);
  assert.equal(env.sent.length, 1);
});

test('replies sent by the app itself (✅ ❓ ⚠ 🎙 📝 / just-sent id) → skipped', async () => {
  const env = await setup({ aiAnswers: [answerJson([lunch])] });
  await env.run(textTrigger());
  for (const content of ['📝 Bản nháp: chi 50.000đ', '✅ Đã ghi', '❓ Gì?', '⚠️ Lỗi', '🎙️ “x”']) {
    assert.equal((await env.run(textTrigger({ isSelf: true, content, msgId: `x${content.length}` }))).skipped, 'own_reply', content);
  }
  assert.equal((await env.run(textTrigger({ isSelf: true, content: 'không dấu', msgId: 'sent1' }))).skipped, 'own_reply');
});

test('infrastructure error → the message can be processed again later (seen mark removed)', async () => {
  const env = await setup({ aiAnswers: [new Error('401 invalid api key'), answerJson([lunch])] });
  const first = await env.run(textTrigger());
  assert.equal(first.skipped, 'ai_error');
  assert.match(first.reply, /^⚠️ Trợ lý AI/);
  const again = await env.run(textTrigger());
  assert.equal(again.skipped, '');
  assert.equal(again.drafts, 1);
});

test('not deployed → not_configured, no reply', async () => {
  const env = await setup({ deployed: false });
  const out = await env.run(textTrigger());
  assert.equal(out.skipped, 'not_configured');
  assert.equal(env.sent.length, 0);
});

test('voice note: getMessage → downloadMessageMedia → /integration/transcribe → assistant; the reply has a 🎙️ line', async () => {
  const audio = Buffer.from('fake-audio').toString('base64');
  const env = await setup({
    aiAnswers: [answerJson([lunch])],
    messages: { m200: { msg_type: 'chat.voice', content: JSON.stringify({ href: 'https://voice.zdn.vn/a.m4a', params: JSON.stringify({ duration: 3000 }) }), media: { name: 'voice.m4a', mime: 'audio/x-m4a', size: 10, base64: audio } } },
  });
  const out = await env.run(textTrigger({ content: '', msgId: 'm200' }));
  assert.equal(out.drafts, 1);
  assert.equal(out.text, 'ăn trưa năm mươi nghìn');
  assert.match(out.reply, /^🎙️ “ăn trưa năm mươi nghìn”\n📝 Bản nháp/);
  const tr = env.fintrack.state.requests.find((r) => r.path === '/api/integration/transcribe');
  assert.deepEqual(tr.body, { audio, mime: 'audio/x-m4a' });
  assert.equal(tr.headers['X-FinTrack-Workspace'], 'ws1');
  assert.equal(env.chats()[0].body.text, 'Người gửi: Lan\năn trưa năm mươi nghìn');
});

test('voice note: Deplao cannot download it → fetch the href link; voice notes disabled / not a voice note', async () => {
  const VOICE = 'https://voice.zdn.vn/b.m4a';
  const env = await setup({
    aiAnswers: [answerJson([lunch])],
    messages: { m1: { msg_type: 'chat.voice', content: JSON.stringify({ href: VOICE }) }, m2: { msg_type: 'chat.sticker', content: '{}' }, m3: { msg_type: 'chat.voice', content: '{}' } },
    media: { [VOICE]: { status: 200, base64: Buffer.from('a').toString('base64') } },
  });
  assert.equal((await env.run(textTrigger({ content: '', msgId: 'm1' }))).drafts, 1);
  assert.equal(env.calls.find((c) => c.url === VOICE).init.responseType, 'base64');
  assert.equal((await env.run(textTrigger({ content: '', msgId: 'm3' }), { ...CFG, voice: false })).skipped, 'voice_disabled');
  assert.equal((await env.run(textTrigger({ content: '', msgId: 'm2' }))).skipped, 'unsupported_message');
});

test('fintrack.transcribe: voice note → text + durationSec; text message → not_voice', async () => {
  const env = await setup({
    messages: { m3: { msg_type: 'chat.voice', content: JSON.stringify({ params: JSON.stringify({ duration: 4200 }) }), media: { mime: 'audio/mp4', base64: Buffer.from('x').toString('base64') } } },
  });
  const ctx = { deplao: env.deplao, settings: {} };
  assert.deepEqual(await TRANSCRIBE({}, { trigger: textTrigger({ content: '', msgId: 'm3' }), pageId: 'acc1' }, ctx), { text: 'ăn trưa năm mươi nghìn', durationSec: 4, skipped: '' });
  assert.deepEqual(await TRANSCRIBE({}, { trigger: textTrigger(), pageId: 'acc1' }, ctx), { text: 'Ăn trưa 50k', durationSec: 0, skipped: 'not_voice' });
});

// Tiny JPEG (FF D8 FF …) and GIF (not read).
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64');
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1').toString('base64');
const PHOTO_URL = 'https://photo-stal.zadn.vn/1/a.jpg';
const photo = (extra = {}) => ({ msg_type: 'chat.photo', content: JSON.stringify({ title: '', href: PHOTO_URL, thumb: 'https://photo-stal.zadn.vn/t/a.jpg', params: JSON.stringify({ hd: 'https://photo-stal.zadn.vn/hd/a.jpg' }) }), ...extra });
const photoTrigger = (o = {}) => textTrigger({ content: '', images: ['https://photo-stal.zadn.vn/hd/a.jpg', 'https://photo-stal.zadn.vn/t/a.jpg'], ...o });

test('image + FinTrack assistant: download (downloadMessageMedia) → chat with image → 📝 draft; caption with an amount + auto-record → recorded right away', async () => {
  const env = await setup({ messages: { p1: photo({ media: { name: 'a.jpg', mime: 'image/jpeg', size: 12, base64: JPEG } }), p2: photo({ media: { name: 'b.jpg', mime: 'image/jpeg', size: 12, base64: JPEG } }) } });
  const ctx = { deplao: env.deplao, settings: {} };
  await backend.commands.api({ method: 'GET', path: '/auth/session' }, ctx); // open the account (ws1)
  assert.equal((await backend.commands.setAiAssistant({ source: 'fintrack', profileId: 'p1' }, ctx)).ok, true);

  const out = await env.run(photoTrigger({ msgId: 'p1' }));
  assert.equal(out.drafts, 1, JSON.stringify(out));
  assert.equal(out.skipped, '');
  const chat = env.chats().pop();
  assert.equal(chat.body.image, `data:image/jpeg;base64,${JPEG}`);
  assert.equal(chat.body.text, 'Người gửi: Lan\n[Ảnh]');
  assert.equal(chat.headers['X-FinTrack-AI'], 'fintrack');
  assert.ok(env.calls.some((c) => c.op === 'downloadMessageMedia' && c.params.msgId === 'p1'));
  assert.match(env.sent.at(-1).text, /^📝 Bản nháp: chi 120\.000đ \(Hoá đơn \(ảnh\)\)/);
  const [draft] = [...env.fintrack.state.drafts.values()];
  assert.equal(draft.source.text, '[Ảnh]');

  // Caption with the matching amount + auto-record mode → recorded immediately.
  const auto = await env.run(photoTrigger({ msgId: 'p2', content: 'Đi chợ 85k' }), { ...CFG, mode: 'auto' });
  assert.equal(auto.recorded, 1, JSON.stringify(auto));
  assert.equal(env.chats().pop().body.text, 'Người gửi: Lan\n[Ảnh] Đi chợ 85k');
});

test('image + Deplao assistant (or a model that cannot read images): skipped with one reminder in the group; images disabled; GIF / broken image', async () => {
  const env = await setup({
    messages: { p1: photo({ media: { base64: JPEG } }), p2: photo({ media: { base64: JPEG } }), g1: { msg_type: 'chat.gif', content: '{}' }, p3: photo({ media: { base64: GIF } }), p9: photo({ media: { base64: JPEG } }) },
    fintrackOpts: { profiles: [{ id: 'p1', name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-chat', configured: true }], defaultProfileId: 'p1' },
  });
  const ctx = { deplao: env.deplao, settings: {} };
  await backend.commands.api({ method: 'GET', path: '/auth/session' }, ctx);
  // Deplao assistant (default): no FinTrack chat call, a reminder to choose the FinTrack assistant.
  const a = await env.run(photoTrigger({ msgId: 'p1' }));
  assert.equal(a.skipped, 'image_unsupported_ai');
  assert.match(a.reply, /^⚠️ Trợ lý AI đang chọn chưa đọc được ảnh/);
  assert.equal(env.chats().length, 0);
  assert.equal(env.calls.filter((c) => c.op === 'downloadMessageMedia').length, 0, 'image not downloaded when it cannot be read');
  // DeepSeek without Flash → the model cannot read images (at most 1 reminder / 10 minutes / group → silent this time).
  assert.equal((await backend.commands.setAiAssistant({ source: 'fintrack', profileId: 'p1' }, ctx)).ok, true);
  const b = await env.run(photoTrigger({ msgId: 'p2' }));
  assert.equal(b.skipped, 'image_unsupported_ai');
  assert.equal(b.reply, '');
  // Images disabled.
  assert.equal((await env.run(photoTrigger({ msgId: 'p9' }), { ...CFG, images: false })).skipped, 'images_disabled');
  // GIF message → not a still image; GIF data in a photo message → unsupported format.
  assert.equal((await env.run(photoTrigger({ msgId: 'g1' }))).skipped, 'unsupported_message');
  env.fintrack.state.profiles[0].model = 'deepseek-flash';
  const c = await env.run(photoTrigger({ msgId: 'p3' }));
  assert.equal(c.skipped, 'image_failed');
});

test('image: Deplao cannot download it → fetch the image link from the message (Zalo Referer); a text message with a link (thumb) stays a text message', async () => {
  const env = await setup({
    messages: { p1: photo(), l1: { msg_type: 'chat.recommended', content: JSON.stringify({ title: 'Ăn trưa 50k', thumb: 'https://x.zadn.vn/t.jpg', action: 'recommened.link' }) } },
    media: { [PHOTO_URL]: { status: 200, headers: { 'content-type': 'image/jpeg' }, base64: JPEG } },
    aiAnswers: [answerJson([lunch])],
  });
  const ctx = { deplao: env.deplao, settings: {} };
  await backend.commands.api({ method: 'GET', path: '/auth/session' }, ctx);
  assert.equal((await backend.commands.setAiAssistant({ source: 'fintrack', profileId: 'p1' }, ctx)).ok, true);
  const out = await env.run(photoTrigger({ msgId: 'p1' }));
  assert.equal(out.drafts, 1, JSON.stringify(out));
  const fetched = env.calls.find((c) => c.op === 'http.fetch' && c.url === PHOTO_URL);
  assert.equal(fetched.init.headers.Referer, 'https://chat.zalo.me/');
  assert.equal(fetched.init.responseType, 'base64');
  // Link with a thumbnail: the text still takes the text-message path (no image sent).
  await backend.commands.setAiAssistant({ source: 'deplao', id: '' }, ctx);
  const link = await env.run(textTrigger({ content: 'Ăn trưa 50k', msgId: 'l1', images: ['https://x.zadn.vn/t.jpg'] }));
  assert.equal(link.drafts, 1, JSON.stringify(link));
  assert.equal(env.chats().pop().body.image, undefined);
});

test('broken trigger data does not make the node throw', async () => {
  const env = await setup({});
  for (const trigger of [null, {}, { content: '' }, 'abc']) {
    const out = await RECORD({}, { trigger }, { deplao: env.deplao, settings: {} });
    assert.equal(typeof out.skipped, 'string');
    assert.equal(out.recorded, 0);
  }
});

test('own reply echoed back through your other Zalo account → skipped; a member typing ✅ is still processed; one message received by two accounts → handled once', async () => {
  const env = await setup({ aiAnswers: [answerJson([lunch]), answerJson([lunch])] });
  const ACC2 = { ...CFG, account: 'acc2' };
  const first = await env.run(textTrigger());
  assert.equal(first.drafts, 1);
  // acc2 (also in the group) receives the reply just sent (msg_id sent1); for acc2 it is not an isSelf message.
  const echo = textTrigger({ zaloId: 'acc2', isSelf: false, fromId: 'acc1', fromName: 'Chủ nhà', content: first.reply, msgId: 'sent1' });
  assert.equal((await env.run(echo, ACC2)).skipped, 'own_reply');
  // After a restart (sent ids forgotten) it is still recognized: 📝 marker + the sender is a Zalo account on this Deplao.
  _internal.reset();
  assert.equal((await env.run({ ...echo, msgId: 'sent9' }, ACC2)).skipped, 'own_reply');
  // A member typing ✅ → still an expense message.
  assert.equal((await env.run(textTrigger({ content: '✅ ăn trưa 50k', msgId: 'm150' }))).drafts, 1);
  // The same message arriving through acc2 → already processed.
  assert.equal((await env.run(textTrigger({ zaloId: 'acc2', content: '✅ ăn trưa 50k', msgId: 'm150' }), ACC2)).skipped, 'duplicate');
  assert.equal(env.chats().length, 4, 'two messages, each 428 + resend');
});

test('assistant errors: no API key (400) / quota used up (429) → matching message, can be retried; wrong secret → skipped silently', async () => {
  const env = await setup({});
  const ctx = { deplao: env.deplao, settings: {} };
  await backend.commands.api({ method: 'GET', path: '/auth/session' }, ctx);
  assert.equal((await backend.commands.setAiAssistant({ source: 'fintrack', profileId: 'p1' }, ctx)).ok, true);
  env.fintrack.state.profiles[0].configured = false;
  const noKey = await env.run(textTrigger({ msgId: 'e1' }));
  assert.equal(noKey.skipped, 'ai_error');
  assert.match(noKey.reply, /^⚠️ Trợ lý AI của sổ chưa sẵn sàng/);
  _internal.reset(); // errors are reported at most once / 10 minutes / group
  const orig = env.fintrack.handle;
  env.deplao.http.fetch = async (url, init) => (url.endsWith('/api/assistant/chat')
    ? { status: 429, headers: {}, text: JSON.stringify({ error: 'Đã đạt giới hạn lượt AI hôm nay.' }) }
    : orig(url, init));
  const limit = await env.run(textTrigger({ msgId: 'e2' }));
  assert.equal(limit.skipped, 'ai_error');
  assert.match(limit.reply, /hết lượt/);
  assert.equal((await env.deplao.storage.get('seen'))['zalo:g1:e2'], undefined, 'temporary error → mark removed');

  const bad = await setup({});
  await bad.deplao.storage.set('integration.secret', 'secret-sai-'.padEnd(40, 'x'));
  assert.equal((await bad.run(textTrigger({ msgId: 'e3' }))).skipped, 'not_configured');
  assert.equal(bad.sent.length, 0);
});

test('auto: network error on commit → item stays pending, items carry the error', async () => {
  const env = await setup({ aiAnswers: [answerJson([lunch])] });
  const orig = env.fintrack.handle;
  env.deplao.http.fetch = async (url, init) => {
    if (url.endsWith('/api/assistant/commit')) throw Object.assign(new Error('http.fetch: connect ECONNRESET'), { code: 'UPSTREAM_ERROR' });
    return orig(url, init);
  };
  const out = await env.run(textTrigger(), { ...CFG, mode: 'auto' });
  assert.equal(out.recorded, 0);
  assert.equal(out.items[0].status, 'draft');
  assert.match(out.items[0].error, /Không kết nối được FinTrack/);
  assert.equal([...env.fintrack.state.drafts.values()][0].status, 'pending', 'item still pending in FinTrack');
});

test('no group selection needed: messages go to the open FinTrack account; the draft keeps the group name from the trigger', async () => {
  const env = await setup({ aiAnswers: [answerJson([lunch])] });
  const out = await env.run(textTrigger({ groupName: 'Chi tiêu gia đình' }));
  assert.equal(out.drafts, 1, JSON.stringify(out));
  assert.equal(env.fintrack.state.requests.find((r) => r.path === '/api/integration/session').headers['X-FinTrack-Workspace'], 'ws1');
  const [[messageId, draft]] = [...env.fintrack.state.drafts.entries()];
  assert.deepEqual([env.fintrack.state.messages.get(messageId).workspaceId, draft.source.group], ['ws1', 'Chi tiêu gia đình']);
});

// ─── “ok” / “huỷ” in the group ───────────────────────────────────────────────

/** A message replying to (quoting) an assistant message: Deplao does not pass quotes in the trigger yet → the plugin looks the message up (quote_data). */
const replyTo = (env, sentId, content, o = {}) => {
  const msgId = o.msgId || `r${Math.random().toString(36).slice(2, 8)}`;
  env.messages.set(msgId, { msg_type: 'webchat', content, quote: { msgId: sentId, cliMsgId: '', ownerId: 'acc1', msg: '📝' } });
  return textTrigger({ content, msgId, ...o });
};

test('“ok” replying to the draft message → FinTrack records it; “huỷ” replying to the “✅ Đã ghi” message → reverses the recorded transaction', async () => {
  const env = await setup({ aiAnswers: [answerJson([lunch])] });
  await env.run(textTrigger());
  const [[messageId]] = [...env.fintrack.state.drafts.entries()];
  const okTrigger = replyTo(env, 'sent1', 'Ok ạ');
  const ok = await env.run(okTrigger);
  assert.equal(ok.skipped, '', JSON.stringify(ok));
  assert.equal(ok.recorded, 1);
  assert.equal(ok.reply, '✅ Đã ghi: chi 50.000đ (Ăn trưa)');
  assert.equal(env.sent.at(-1).quote_msg_id, okTrigger.msgId, 'the reply quotes the “ok” message');
  assert.equal(env.fintrack.state.drafts.get(messageId).status, 'done');
  assert.equal(env.chats().length, 2, '“ok” does not call the assistant');
  const confirm = env.fintrack.state.requests.filter((r) => r.path === `/api/assistant/drafts/${messageId}/confirm`);
  assert.equal(confirm.length, 1);
  // The “✅ Đã ghi” message (sent2) also points to the draft: replying “huỷ” to it → reverses the transaction.
  const [ref] = await env.deplao.storage.get('replies');
  assert.deepEqual(ref.ids, ['sent2', 'cli2', 'sent1', 'cli1']);
  const cancel = await env.run(replyTo(env, 'sent2', 'huỷ'));
  assert.equal(cancel.reply, '↩️ Đã huỷ: chi 50.000đ (Ăn trưa)');
  assert.equal(env.fintrack.state.reversed.size, 1);
  // Repeated: with a quote → says it is already cancelled; without a quote → silent.
  assert.equal((await env.run(replyTo(env, 'sent2', 'huỷ'))).reply, '↩️ Khoản này đã huỷ rồi.');
  assert.equal((await env.run(textTrigger({ content: 'huỷ', msgId: 'm190' }))).reply, '');
  assert.equal((await env.run(replyTo(env, 'sent1', 'ok'))).reply, '↩️ Khoản này đã huỷ rồi.', 'once cancelled, “ok” does not record it again');
  assert.equal(env.fintrack.state.reversed.size, 1);
});

test('“ok” without a quote: applies to the latest pending draft of the same sender within 30 minutes; “ok” from someone else → ordinary chat', async () => {
  const dinner = { ...lunch, amount: '120000', note: 'Ăn tối' };
  const env = await setup({ aiAnswers: [answerJson([lunch]), answerJson([dinner])] });
  await env.run(textTrigger());
  // Then Lan sends another expense, which auto-record mode records right away (nothing left pending).
  assert.equal((await env.run(textTrigger({ content: 'Ăn tối 120k', msgId: 'm150' }), { ...CFG, mode: 'auto' })).recorded, 1);
  // Bình (u3) says “ok” in the group: not Bình's draft → skipped like an ordinary message.
  const other = await env.run(textTrigger({ fromId: 'u3', fromName: 'Bình', content: 'ok', msgId: 'm201' }));
  assert.equal(other.skipped, 'no_amount');
  assert.equal(env.fintrack.state.requests.filter((r) => r.path.includes('/drafts/')).length, 0);
  // “có” without a quote is ordinary chat; Lan's “ok” → the pending draft (lunch), skipping the auto-recorded item.
  assert.equal((await env.run(textTrigger({ content: 'có', msgId: 'm202' }))).skipped, 'no_amount');
  const ok = await env.run(textTrigger({ content: 'ok', msgId: 'm203' }));
  assert.equal(ok.recorded, 1, JSON.stringify(ok));
  assert.equal(ok.reply, '✅ Đã ghi: chi 50.000đ (Ăn trưa)');
  // No pending draft left → another “ok” is ordinary chat; “huỷ” right after → cancels the item just confirmed.
  assert.equal((await env.run(textTrigger({ content: 'ok', msgId: 'm204' }))).skipped, 'no_amount');
  assert.equal((await env.run(textTrigger({ content: 'huỷ', msgId: 'm205' }))).reply, '↩️ Đã huỷ: chi 50.000đ (Ăn trưa)');
  // After 30 minutes → no longer applies.
  const replies = await env.deplao.storage.get('replies');
  await env.deplao.storage.set('replies', replies.map((r) => ({ ...r, at: Date.now() - 31 * 60_000 })));
  assert.equal((await env.run(textTrigger({ content: 'huỷ', msgId: 'm206' }))).skipped, 'no_amount');
});

test('replying to an assistant message: only the sender or the account owner; missing category → explained; quoting another message → ordinary chat', async () => {
  const noCategory = { ...lunch, categoryId: null, unsure: ['categoryId'] };
  const env = await setup({ aiAnswers: [answerJson([noCategory])] });
  await env.run(textTrigger());
  const bob = await env.run(replyTo(env, 'sent1', 'đúng rồi', { fromId: 'u3', fromName: 'Bình' }));
  assert.equal(bob.skipped, 'not_allowed');
  assert.equal(bob.reply, '⚠️ Chỉ người gửi khoản này hoặc chủ sổ mới xác nhận / huỷ được.');
  // The account owner (a Zalo account on this Deplao) confirms instead: missing category → not recorded, points to where to choose it.
  const owner = await env.run(replyTo(env, 'sent1', '👍', { fromId: 'acc1', fromName: 'Chủ nhà', isSelf: true }));
  assert.equal(owner.recorded, 0);
  assert.equal(owner.drafts, 1);
  assert.equal(owner.reply, '⚠️ Chưa ghi chi 50.000đ (Ăn trưa): chưa có danh mục.\nChọn nốt trong FinTrack: Tổng quan → Chờ xác nhận.');
  // “ok” replying to another member's message (not the assistant's) → the draft is untouched.
  env.messages.set('m9', { msg_type: 'webchat', content: 'ok', quote: { msgId: 'm-khac', cliMsgId: '' } });
  assert.equal((await env.run(textTrigger({ content: 'ok', msgId: 'm9' }))).skipped, 'no_amount');
  // “huỷ” → drops the draft (nothing was recorded).
  const drop = await env.run(replyTo(env, 'sent1', 'sai'));
  assert.equal(drop.reply, '↩️ Đã bỏ bản nháp: chi 50.000đ (Ăn trưa)');
  assert.equal([...env.fintrack.state.drafts.values()][0].status, 'dismissed');
});

test('“ok” with an outdated FinTrack (old Worker without pending drafts) → silent; a trigger that already carries the quote is not looked up again', async () => {
  const env = await setup({ aiAnswers: [answerJson([lunch])], fintrackOpts: { noDrafts: true } });
  const out = await env.run(textTrigger());
  assert.equal(out.drafts, 1);
  const ok = await env.run(textTrigger({ content: 'ok', msgId: 'm300', quote: { globalMsgId: 'sent1', cliMsgId: 'cli1' } }));
  assert.equal(ok.skipped, 'draft_gone');
  assert.equal(ok.reply, '');
  assert.equal(env.calls.filter((c) => c.op === 'getMessage' && c.params.msgId === 'm300').length, 0);
});

test('node pins a Deplao assistant (assistantId): still in Deplao → uses it; deleted → uses the assistant of the FinTrack account', async () => {
  const env = await setup({ aiAnswers: [answerJson([lunch]), answerJson([lunch])] });
  await env.run(textTrigger({ msgId: 'a1' }), { ...CFG, assistantId: 'ai2' });
  await env.run(textTrigger({ msgId: 'a2' }), { ...CFG, assistantId: 'gone' });
  const asks = env.calls.filter((c) => c.op === 'aiChat');
  assert.equal(asks[0].params.assistant_id, 'ai2');
  assert.equal(asks[1].params.assistant_id, undefined, 'Deplao default assistant → no id sent');
  const [first, , second] = env.chats();
  assert.equal(first.headers['X-FinTrack-Assistant'], encodeURIComponent('Kế toán Đào'));
  assert.equal(second.headers['X-FinTrack-Assistant'], encodeURIComponent('Trợ lý chính'));
});
