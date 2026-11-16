'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatDraftReply, formatAutoReply, formatConfirmReply, formatCancelReply, formatCommandNote, formatQuestion, formatError, actionLabel,
} = require('../backend/lib/reply');
const { looksLikeOwnReply } = require('../backend/lib/message');

const lunch = { type: 'expense', amount: '50000', currency: 'VND', note: 'Ăn trưa' };
const salary = { type: 'income', amount: '10000000', note: null };
const move = { type: 'transfer', amount: '1000000', note: 'Rút tiền' };
const ASK = 'Trả lời “ok” để ghi, “huỷ” để bỏ.';

test('actionLabel: type + amount + short note', () => {
  assert.equal(actionLabel(lunch), 'chi 50.000đ (Ăn trưa)');
  assert.equal(actionLabel(salary), 'thu 10.000.000đ');
  assert.equal(actionLabel({ type: 'trade', amount: null, name: 'FPT' }), 'giao dịch (FPT)');
  assert.equal(actionLabel({ type: 'expense', amount: '12.5', currency: 'USD' }), 'chi 12,5 USD');
  assert.equal(actionLabel(null), 'khoản');
});

test('draft: 📝 + list + how to confirm right in the group; long lists are shortened', () => {
  assert.equal(formatDraftReply({ actions: [lunch] }), `📝 Bản nháp: chi 50.000đ (Ăn trưa). ${ASK}`);
  const many = formatDraftReply({ actions: [lunch, lunch, lunch, lunch, salary, move] });
  assert.match(many, /và 2 khoản khác\. Trả lời “ok”/);
  assert.equal(formatDraftReply({ actions: [] }), '');
});

test('auto-record: ✅ recorded items + how to cancel; with pending items, “ok” records the rest; nothing recorded → same as a draft', () => {
  assert.equal(formatAutoReply({ recorded: [lunch], pending: [] }), '✅ Đã ghi: chi 50.000đ (Ăn trưa)\nSai thì trả lời “huỷ”.');
  assert.equal(
    formatAutoReply({ recorded: [lunch], pending: [move] }),
    '✅ Đã ghi: chi 50.000đ (Ăn trưa)\n📝 Chờ xác nhận: chuyển 1.000.000đ (Rút tiền)\nTrả lời “ok” để ghi nốt, “huỷ” để huỷ cả tin.',
  );
  assert.match(formatAutoReply({ recorded: [], pending: [move] }), /^📝 Bản nháp: chuyển/);
});

test('“ok” / “huỷ” results: recorded / cancelled items, failed items with the reason; repeated commands', () => {
  assert.equal(formatConfirmReply({ recorded: [lunch], failed: [] }), '✅ Đã ghi: chi 50.000đ (Ăn trưa)');
  assert.equal(
    formatConfirmReply({ recorded: [], failed: [{ action: move, error: 'chưa có ví nhận' }] }),
    '⚠️ Chưa ghi chuyển 1.000.000đ (Rút tiền): chưa có ví nhận.\nChọn nốt trong FinTrack: Tổng quan → Chờ xác nhận.',
  );
  assert.equal(formatConfirmReply({ recorded: [], failed: [] }), '');
  assert.equal(formatCancelReply({ undone: [lunch], dropped: [move], failed: [] }), '↩️ Đã huỷ: chi 50.000đ (Ăn trưa)\n↩️ Đã bỏ bản nháp: chuyển 1.000.000đ (Rút tiền)');
  assert.equal(formatCancelReply({ undone: [], dropped: [], failed: [{ action: lunch, error: 'đã được sửa hoặc huỷ trong FinTrack' }] }), '⚠️ Chưa huỷ chi 50.000đ (Ăn trưa): đã được sửa hoặc huỷ trong FinTrack.');
  assert.equal(formatCommandNote('confirmed'), '✅ Khoản này đã ghi rồi.');
  assert.equal(formatCommandNote('cancelled'), '↩️ Khoản này đã huỷ rồi.');
  assert.equal(formatCommandNote('???'), '');
});

test('voice note: the 🎙️ transcript line comes first; every reply carries a marker so the app skips its own replies', () => {
  assert.equal(formatDraftReply({ actions: [lunch], transcript: 'ăn trưa năm mươi nghìn' }), `🎙️ “ăn trưa năm mươi nghìn”\n📝 Bản nháp: chi 50.000đ (Ăn trưa). ${ASK}`);
  assert.equal(formatQuestion('Khoản 500k này là chi gì vậy?'), '❓ Khoản 500k này là chi gì vậy?');
  assert.equal(formatQuestion(''), '');
  for (const s of [
    formatDraftReply({ actions: [lunch] }), formatAutoReply({ recorded: [lunch], pending: [] }), formatQuestion('Gì?', 'abc'), formatError('voice'), formatError('???'),
    formatConfirmReply({ recorded: [lunch], failed: [] }), formatConfirmReply({ recorded: [], failed: [{ action: lunch, error: 'x' }] }),
    formatCancelReply({ undone: [lunch], dropped: [], failed: [] }), formatCancelReply({ undone: [], dropped: [lunch], failed: [] }),
    formatCommandNote('confirmed'), formatCommandNote('cancelled'), formatCommandNote('not_allowed'),
  ]) {
    assert.equal(looksLikeOwnReply(s), true, s);
  }
});
