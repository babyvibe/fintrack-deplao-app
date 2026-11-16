'use strict';
/**
 * Short replies in the group (CONTRACTS §3.5). They always start with ✅ / ❓ / ⚠️ / 🎙️ / 📝 / ↩️ so the plugin
 * recognises its own messages and does not process them again. Examples (the text users see is Vietnamese):
 *
 *   📝 Bản nháp: chi 50.000đ (Ăn trưa), chi 25.000đ (Cafe). Trả lời “ok” để ghi, “huỷ” để bỏ.
 *   ✅ Đã ghi: chi 50.000đ (Ăn trưa)
 *   Sai thì trả lời “huỷ”.
 *   ↩️ Đã huỷ: chi 50.000đ (Ăn trưa)
 *   ❓ <the FinTrack assistant's question>
 */

const { formatMoney, amountOf } = require('./money');
const { cleanLine, truncate } = require('./util');

const TYPE_LABEL = { expense: 'chi', income: 'thu', transfer: 'chuyển', trade: 'giao dịch', savings: 'gửi tiết kiệm' };
const MAX_LISTED = 4;

/** One FinTrack assistant action as a label, e.g. "chi 50.000đ (Ăn trưa)" (expense 50,000 VND, lunch). */
function actionLabel(action) {
  const a = action || {};
  const parts = [TYPE_LABEL[a.type] || 'khoản'];
  const amount = amountOf(a);
  if (amount) parts.push(formatMoney(amount, a.currency || 'VND'));
  const note = cleanLine(a.note || a.name || '', 40);
  return note ? `${parts.join(' ')} (${note})` : parts.join(' ');
}

function listLabels(actions) {
  const list = (actions || []).map(actionLabel);
  return list.length > MAX_LISTED ? `${list.slice(0, MAX_LISTED).join(', ')} và ${list.length - MAX_LISTED} khoản khác` : list.join(', ');
}

function head(transcript) {
  return transcript ? `🎙️ “${truncate(cleanLine(transcript, 200), 80)}”\n` : '';
}

/** Draft mode (or auto mode when nothing was recorded). The sender replies “ok” / “huỷ” right in the group. */
function formatDraftReply({ actions, transcript }) {
  if (!actions || !actions.length) return '';
  return `${head(transcript)}📝 Bản nháp: ${listLabels(actions)}. Trả lời “ok” để ghi, “huỷ” để bỏ.`;
}

/**
 * Auto mode: recorded = actions recorded, pending = actions awaiting confirmation. “huỷ” cancels the whole message
 * (recorded entries are reversed).
 */
function formatAutoReply({ recorded, pending, transcript }) {
  if (!recorded || !recorded.length) return formatDraftReply({ actions: pending, transcript });
  const lines = [`✅ Đã ghi: ${listLabels(recorded)}`];
  if (pending && pending.length) {
    lines.push(`📝 Chờ xác nhận: ${listLabels(pending)}`);
    lines.push('Trả lời “ok” để ghi nốt, “huỷ” để huỷ cả tin.');
  } else lines.push('Sai thì trả lời “huỷ”.');
  return `${head(transcript)}${lines.join('\n')}`;
}

/**
 * Result of “ok”: recorded = actions just recorded; failed = [{ action, error }] that could not be recorded (missing
 * category / wallet…).
 */
function formatConfirmReply({ recorded, failed }) {
  const lines = [];
  if (recorded.length) lines.push(`✅ Đã ghi: ${listLabels(recorded)}`);
  for (const f of failed.slice(0, MAX_LISTED)) lines.push(`⚠️ Chưa ghi ${actionLabel(f.action)}: ${cleanLine(f.error, 120)}.`);
  if (failed.length) lines.push('Chọn nốt trong FinTrack: Tổng quan → Chờ xác nhận.');
  return lines.join('\n');
}

/**
 * Result of “huỷ”: undone = recorded entries just reversed; dropped = unrecorded entries dropped;
 * failed = [{ action, error }].
 */
function formatCancelReply({ undone, dropped, failed }) {
  const lines = [];
  if (undone.length) lines.push(`↩️ Đã huỷ: ${listLabels(undone)}`);
  if (dropped.length) lines.push(`↩️ Đã bỏ bản nháp: ${listLabels(dropped)}`);
  for (const f of failed.slice(0, MAX_LISTED)) lines.push(`⚠️ Chưa huỷ ${actionLabel(f.action)}: ${cleanLine(f.error, 120)}.`);
  return lines.join('\n');
}

/** Notes for a repeated command, or one the sender may not use. */
const COMMAND_TEXT = {
  confirmed: '✅ Khoản này đã ghi rồi.',
  cancelled: '↩️ Khoản này đã huỷ rồi.',
  not_allowed: '⚠️ Chỉ người gửi khoản này hoặc chủ sổ mới xác nhận / huỷ được.',
};

function formatCommandNote(kind) {
  return COMMAND_TEXT[kind] || '';
}

/** The assistant created no draft → its question / answer. */
function formatQuestion(question, transcript) {
  const q = truncate(cleanLine(question, 600), 300);
  return q ? `${head(transcript)}❓ ${q}` : '';
}

/** Group error notices by kind. Readers are group members, so only say what they can do (resend, type it instead). */
const ERROR_TEXT = {
  voice: 'Chưa nghe được ghi âm này. Bạn gõ chữ giúp mình nhé.',
  ai: 'Trợ lý AI đang không phản hồi, chưa ghi được. Gửi lại sau ít phút nhé.',
  ai_limit: 'Trợ lý AI đã hết lượt hôm nay hoặc đang bị giới hạn, chưa ghi được. Gửi lại sau nhé.',
  ai_setup: 'Trợ lý AI của sổ chưa sẵn sàng (thiếu API key?), chưa ghi được. Chủ sổ kiểm tra FinTrack → Cài đặt → Trợ lý AI giúp mình nhé.',
  fintrack: 'FinTrack đang không phản hồi, chưa ghi được. Gửi lại sau ít phút nhé.',
  timeout: 'Xử lý quá lâu, chưa ghi được. Gửi lại sau ít phút nhé.',
  image: 'Chưa đọc được ảnh này (cần ảnh JPG / PNG / WebP dưới ~4 MB). Bạn gõ chữ giúp mình nhé.',
  image_ai: 'Trợ lý AI đang chọn chưa đọc được ảnh. Chọn trợ lý của FinTrack (OpenAI / Gemini / DeepSeek Flash) ở FinTrack → Cài đặt → Trợ lý AI, hoặc gõ chữ giúp mình nhé.',
  image_model: 'Model trợ lý FinTrack đang dùng chưa đọc được ảnh (DeepSeek cần model Flash). Đổi model hoặc gõ chữ giúp mình nhé.',
};

function formatError(kind) {
  return `⚠️ ${ERROR_TEXT[kind] || ERROR_TEXT.fintrack}`;
}

module.exports = { formatDraftReply, formatAutoReply, formatConfirmReply, formatCancelReply, formatCommandNote, formatQuestion, formatError, actionLabel };
