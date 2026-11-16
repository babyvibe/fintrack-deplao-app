'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTriggerMessage, chatCommand, quoteRef, looksLikeOwnReply, isVoiceType, isImageType, isZaloMediaUrl, imageUrlsFromContent, imageMime, voiceInfoFromContent, audioMime, messageKey } = require('../backend/lib/message');
const { textTrigger } = require('./helpers/fakes');

test('flat trigger (Zalo trigger.message) → text message', () => {
  const m = extractTriggerMessage(textTrigger(), 'acc1');
  assert.deepEqual(
    { accountId: m.accountId, threadId: m.threadId, msgId: m.msgId, cliMsgId: m.cliMsgId, senderId: m.senderId, senderName: m.senderName, text: m.text, isSelf: m.isSelf, isGroup: m.isGroup },
    { accountId: 'acc1', threadId: 'g1', msgId: 'm100', cliMsgId: 'c100', senderId: 'u2', senderName: 'Lan', text: 'Ăn trưa 50k', isSelf: false, isGroup: true },
  );
  assert.equal(m.timestamp, Date.UTC(2026, 9, 20, 5, 0, 0));
  assert.equal(m.rawContent, null);
});

test('flat trigger of a voice note: empty content, no msgType', () => {
  const m = extractTriggerMessage(textTrigger({ content: '' }), 'acc1');
  assert.equal(m.text, '');
  assert.equal(m.msgType, '');
  assert.equal(m.msgId, 'm100');
});

test('missing zaloId → uses the workflow pageId', () => {
  const m = extractTriggerMessage({ ...textTrigger(), zaloId: '' }, 'pageX');
  assert.equal(m.accountId, 'pageX');
});

test('raw zca-js shape { zaloId, message: { type, threadId, isSelf, data } }', () => {
  const raw = {
    zaloId: 'acc1',
    message: {
      type: 1,
      threadId: 'g1',
      isSelf: true,
      data: { msgId: 'm7', cliMsgId: 'c7', uidFrom: '0', dName: 'Chủ nhà', ts: '1760936400000', msgType: 'chat.voice', content: { href: 'https://voice.zdn.vn/a.m4a', params: '{"duration":4000}' } },
    },
  };
  const m = extractTriggerMessage(raw, '');
  assert.equal(m.accountId, 'acc1');
  assert.equal(m.threadId, 'g1');
  assert.equal(m.msgId, 'm7');
  assert.equal(m.isSelf, true);
  assert.equal(m.isGroup, true);
  assert.equal(m.msgType, 'chat.voice');
  assert.equal(m.text, '');
  assert.equal(m.timestamp, 1760936400000);
  assert.deepEqual(m.rawContent.href, 'https://voice.zdn.vn/a.m4a');
  const text = extractTriggerMessage({ zaloId: 'a', message: { type: 0, threadId: 'u', data: { msgId: '1', content: 'cafe 20k', msgType: 'webchat' } } }, '');
  assert.equal(text.text, 'cafe 20k');
  assert.equal(text.isGroup, false);
});

test('garbage trigger data does not crash', () => {
  for (const t of [null, undefined, 'x', 42, [], { message: 'x' }]) {
    const m = extractTriggerMessage(t, 'p');
    assert.equal(typeof m.text, 'string');
    assert.equal(m.accountId, 'p');
  }
});

test('recognizes replies sent by the app itself', () => {
  for (const s of ['✅ Ăn uống 50.000đ', '❓ Khoản này là gì?', '⚠️ Chưa ghi được', '🎙️ “ăn trưa”\n✅ Ăn uống', '  ✅ có khoảng trắng']) assert.equal(looksLikeOwnReply(s), true, s);
  for (const s of ['Ăn trưa 50k', '', 'ok ✅']) assert.equal(looksLikeOwnReply(s), false, s);
});

test('voiceInfoFromContent: href, params.m4a, duration in ms / seconds', () => {
  assert.deepEqual(voiceInfoFromContent('{"href":"https://v.zdn.vn/x.m4a","params":"{\\"duration\\":5000}"}'), { url: 'https://v.zdn.vn/x.m4a', durationSec: 5 });
  assert.deepEqual(voiceInfoFromContent({ href: '', params: { m4a: 'https://v.zdn.vn/y.m4a', duration: 7 } }), { url: 'https://v.zdn.vn/y.m4a', durationSec: 7 });
  assert.deepEqual(voiceInfoFromContent({ href: 'javascript:alert(1)' }), { url: '', durationSec: 0 });
  assert.deepEqual(voiceInfoFromContent('không phải json'), { url: '', durationSec: 0 });
  assert.deepEqual(voiceInfoFromContent({ href: 'https://evil.example/x.m4a', params: { duration: 3 } }), { url: '', durationSec: 3 }, 'Zalo CDN only');
  assert.equal(isVoiceType('chat.voice'), true);
  assert.equal(isVoiceType('webchat'), false);
});

test('images: fallback download only from the Zalo CDN; hasImage detects image messages even with foreign links; format from the first bytes', () => {
  for (const ok of ['https://f21-zpc.zdn.vn/a.jpg', 'https://photo-stal.zadn.vn/b.jpg', 'https://dl.dlfl.vn/c', 'https://zdn.vn/d']) assert.equal(isZaloMediaUrl(ok), true, ok);
  for (const bad of ['http://dl.dlfl.vn/c', 'https://zdn.vn.evil.com/a', 'https://evilzdn.vn/a', 'https://user:pw@f1.zdn.vn/a', 'ftp://f1.zdn.vn/a', 'javascript:alert(1)', 'https://ik.imagekit.io/a.jpg', '', null]) assert.equal(isZaloMediaUrl(bad), false, String(bad));
  const m = extractTriggerMessage(textTrigger({ content: 'Đi chợ 85k', images: ['https://ik.imagekit.io/a.jpg', 'https://f1.zdn.vn/hd.jpg', 'https://f1.zdn.vn/hd.jpg'] }), 'acc1');
  assert.equal(m.hasImage, true);
  assert.deepEqual(m.images, ['https://f1.zdn.vn/hd.jpg']);
  assert.equal(extractTriggerMessage(textTrigger(), 'acc1').hasImage, false);
  assert.deepEqual(imageUrlsFromContent({ href: 'https://f1.zdn.vn/n.jpg', params: JSON.stringify({ hd: 'https://f1.zdn.vn/hd.jpg', rawUrl: 'https://evil.example/r.jpg' }) }), ['https://f1.zdn.vn/n.jpg', 'https://f1.zdn.vn/hd.jpg']);
  assert.equal(isImageType('chat.photo'), true);
  assert.equal(isImageType('chat.gif'), false);
  const b64 = (bytes) => Buffer.from(bytes).toString('base64');
  assert.equal(imageMime(b64([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(imageMime(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(imageMime(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1').toString('base64')), 'image/webp');
  assert.equal(imageMime(Buffer.from('GIF89a', 'latin1').toString('base64')), '');
  assert.equal(imageMime(''), '');
});

test('audioMime from content-type or file extension', () => {
  assert.equal(audioMime('audio/aac; charset=x', ''), 'audio/aac');
  assert.equal(audioMime('application/octet-stream', 'https://a/b.amr?x=1'), 'audio/amr');
  assert.equal(audioMime('', 'https://a/b.m4a'), 'audio/mp4');
  assert.equal(audioMime('video/mp4', ''), 'audio/mp4');
});

test('“ok” / “huỷ”: the whole message must be the command; quoted replies also accept short words; long sentences / names do not count', () => {
  const plain = (t) => chatCommand(t);
  const quoted = (t) => chatCommand(t, { quoted: true });
  for (const t of ['ok', 'OK ạ', 'ok!!', 'Oke nhé', 'Ghi đi', 'xác nhận', 'Đồng ý']) assert.equal(plain(t), 'confirm', t);
  for (const t of ['huỷ', 'hủy nhé', 'Huỷ bỏ', 'xoá', 'bỏ']) assert.equal(plain(t), 'cancel', t);
  // No quote: ordinary chat in the group.
  for (const t of ['ừ', 'có', 'không', 'Huy', 'sai', '👍', 'ok mai đi ăn không', 'ok ok ok ok ok ok ok ok ok ok ok', '']) assert.equal(plain(t), '', t);
  for (const t of ['ừ', 'đúng rồi', 'có', '👍', 'ok']) assert.equal(quoted(t), 'confirm', t);
  for (const t of ['sai', 'không', 'Huy', '❌', 'huỷ']) assert.equal(quoted(t), 'cancel', t);
  assert.equal(quoted('ok cảm ơn'), '');
});

test('message quote: zca-js quote (globalMsgId) or the quote_data stored by Deplao (msgId); flat trigger has none yet → undefined', () => {
  assert.deepEqual(quoteRef({ globalMsgId: 123, cliMsgId: 456, ownerId: 'u1' }), { msgId: '123', cliMsgId: '456' });
  assert.deepEqual(quoteRef({ msgId: 'sent1', cliMsgId: '' }), { msgId: 'sent1', cliMsgId: '' });
  assert.equal(quoteRef({ msg: 'không có id' }), null);
  assert.equal(quoteRef(null), null);
  assert.equal(extractTriggerMessage(textTrigger()).quote, undefined, 'Deplao triggers carry no quote → looked up when needed');
  assert.deepEqual(extractTriggerMessage(textTrigger({ quote: { globalMsgId: 'sent1' } })).quote, { msgId: 'sent1', cliMsgId: '' });
  const raw = extractTriggerMessage({ zaloId: 'acc1', message: { type: 1, threadId: 'g1', data: { msgId: 'm1', uidFrom: 'u2', content: 'ok', quote: { globalMsgId: 'sent1', cliMsgId: 'cli1' } } } });
  assert.deepEqual(raw.quote, { msgId: 'sent1', cliMsgId: 'cli1' });
  assert.equal(extractTriggerMessage({ zaloId: 'acc1', message: { type: 1, threadId: 'g1', data: { msgId: 'm2', content: 'ok' } } }).quote, null);
});

test('dedupe key: zalo:<threadId>:<msgId>, shared by every Zalo account that receives the message', () => {
  assert.equal(messageKey({ accountId: 'acc1', threadId: 'g1', msgId: 'm100' }), 'zalo:g1:m100');
  assert.equal(messageKey({ accountId: 'acc2', threadId: 'g1', msgId: 'm100' }), 'zalo:g1:m100', 'two accounts in the same group → one key');
  assert.equal(messageKey({ threadId: 'g 1', msgId: 'a:b' }), 'zalo:g_1:a_b', 'odd characters do not break the format');
  assert.equal(messageKey({ threadId: 'g', msgId: '', timestamp: 5, senderId: 'u1' }), 'zalo:g:t5-u1', 'no msgId → timestamp + sender');
  assert.equal(messageKey({ threadId: 'g', msgId: '' }), 'zalo:g:_');
});
