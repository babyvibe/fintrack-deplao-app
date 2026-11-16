'use strict';
/**
 * Reads messages from Deplao trigger data.
 *
 * The "Khi nhận tin nhắn" (On message received) trigger (trigger.message, Zalo) puts a flattened object in run.trigger:
 *   { fromId, fromName, content, images, threadId, groupName, isGroup, msgId, cliMsgId, timestamp, isSelf, zaloId, … }
 * with NO msgType: a voice note has empty content, a photo has images (photo links) and content = the caption. So a
 * message without text, or with photos, is looked up again via getMessage (msg_type "chat.voice" / "chat.photo",
 * content JSON with href). The raw zca-js shape ({ zaloId, message: { type, threadId, isSelf, data } }) is still read
 * when the node follows another trigger / a test run with hand-written data.
 */

const { REPLY_MARKERS } = require('./constants');
const { cleanLine, isPlainObject, safeJsonParse } = require('./util');

function str(v) {
  return v === null || v === undefined ? '' : String(v);
}

/** Text of a zca-js content: a string, or an object { msg | title }. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (isPlainObject(content)) return str(content.msg || content.title || '');
  return '';
}

/** Zalo CDN for files / photos / voice notes. Fallback downloads only use these, never other links in a message. */
const ZALO_MEDIA_DOMAINS = ['zdn.vn', 'zadn.vn', 'dlfl.vn'];

function isZaloMediaUrl(url) {
  let u;
  try {
    u = new URL(str(url));
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return ZALO_MEDIA_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Photo links on the Zalo CDN (at most 3): Deplao's $trigger.images, or params.hd / href of a photo's content. */
function imageUrls(list) {
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const s = str(v).trim();
    if (s.length <= 2000 && isZaloMediaUrl(s) && !out.includes(s)) out.push(s);
    if (out.length === 3) break;
  }
  return out;
}

/** Quote of a message (the one it replies to) → { msgId, cliMsgId }: zca-js `quote` or Deplao's stored quote_data. */
function quoteRef(q) {
  if (!isPlainObject(q)) return null;
  const msgId = str(q.globalMsgId || q.msgId || '');
  const cliMsgId = str(q.cliMsgId || '');
  return msgId || cliMsgId ? { msgId, cliMsgId } : null;
}

/**
 * “ok” / “huỷ” (cancel) sent to an assistant reply. The whole message is just that word (ignoring punctuation and
 * trailing particles such as “ạ”, “nhé”, “đi”). A reply quoting the assistant's message also accepts short words (“ừ”
 * yeah, “đúng” right, “sai” wrong, 👍…); without a quote only unambiguous words count: “Huy” is a person's name,
 * “có” (yes) / “không” (no) are ordinary chat.
 */
const COMMAND_WORDS = {
  strict: {
    confirm: ['ok', 'oke', 'okie', 'okay', 'oki', 'xác nhận', 'đồng ý', 'ghi'],
    cancel: ['huỷ', 'hủy', 'huỷ bỏ', 'hủy bỏ', 'xoá', 'xóa', 'bỏ'],
  },
  quoted: {
    confirm: ['ừ', 'uh', 'ừm', 'đúng', 'đúng rồi', 'chuẩn', 'có', 'yes', 'xac nhan', 'dong y', '👍', '👌', '✔', '✔️', '✅'],
    cancel: ['huy', 'huy bo', 'xoa', 'sai', 'sai rồi', 'không', 'ko', 'no', '❌', '👎', '✖️'],
  },
};

function chatCommand(text, { quoted = false } = {}) {
  let s = str(text).normalize('NFC').toLowerCase().trim();
  if (!s || s.length > 30) return '';
  for (let i = 0; i < 2; i++) {
    s = s.replace(/[\s.!~,…]+$/u, '').replace(/\s+(ạ|nhé|nhe|nha|nhá|đi|luôn)$/u, '').trim();
  }
  s = s.replace(/\s+/g, ' ');
  for (const kind of ['confirm', 'cancel']) {
    if (COMMAND_WORDS.strict[kind].includes(s) || (quoted && COMMAND_WORDS.quoted[kind].includes(s))) return kind;
  }
  return '';
}

/**
 * run.trigger (+ run.pageId) → normalised message.
 * @returns {{ accountId, threadId, groupName, msgId, cliMsgId, senderId, senderName, text, isSelf, isGroup, timestamp,
 *   msgType, rawContent, hasImage, images, quote }} where quote: { msgId, cliMsgId } | null (not a reply) | undefined
 *   (Deplao's trigger carries no quote → looked up via getMessage when needed)
 */
function extractTriggerMessage(trigger, pageId) {
  const t = isPlainObject(trigger) ? trigger : {};
  const envelope = isPlainObject(t.message) ? t.message : isPlainObject(t.data) && isPlainObject(t.data.data) ? t.data : null;
  if (envelope && isPlainObject(envelope.data)) {
    // Raw zca-js shape.
    const d = envelope.data;
    return {
      accountId: str(t.zaloId || pageId),
      threadId: str(envelope.threadId || d.idTo || ''),
      groupName: cleanLine(t.groupName || '', 80),
      msgId: str(d.msgId || ''),
      cliMsgId: str(d.cliMsgId || ''),
      senderId: str(d.uidFrom || ''),
      senderName: cleanLine(d.dName || '', 60),
      text: contentText(d.content).trim(),
      isSelf: !!(envelope.isSelf || t.isSelf),
      isGroup: envelope.type === 1 || !!envelope.isGroup,
      timestamp: Number(d.ts) || Number(t.timestamp) || Date.now(),
      msgType: str(d.msgType || ''),
      rawContent: d.content ?? null,
      hasImage: false,
      images: [],
      quote: quoteRef(d.quote),
    };
  }
  return {
    accountId: str(t.zaloId || t.accountId || pageId),
    threadId: str(t.threadId || ''),
    groupName: cleanLine(t.groupName || '', 80),
    msgId: str(t.msgId || t.messageId || ''),
    cliMsgId: str(t.cliMsgId || ''),
    senderId: str(t.fromId || ''),
    senderName: cleanLine(t.fromName || '', 60),
    text: (typeof t.content === 'string' ? t.content : contentText(t.content)).trim(),
    isSelf: !!t.isSelf,
    isGroup: !!t.isGroup || Number(t.threadType) === 1,
    timestamp: Number(t.timestamp) || Date.now(),
    msgType: str(t.msgType || ''),
    rawContent: null,
    // Photo message: Deplao passes photo links (HD, thumb…) and content is then the caption (may be empty). hasImage
    // flags a possible photo (its type gets looked up); images keeps only Zalo CDN links, for fallback downloads.
    hasImage: Array.isArray(t.images) && t.images.some((v) => typeof v === 'string' && v.trim() !== ''),
    images: imageUrls(t.images),
    // Deplao's trigger does not carry the quote yet (unless added): undefined = unknown, look it up when needed.
    quote: t.quote === undefined ? undefined : quoteRef(t.quote),
  };
}

const IMAGE_TYPES = new Set(['chat.photo', 'photo', 'image']);

/** Readable still image (excludes chat.gif / stickers). */
function isImageType(msgType) {
  return IMAGE_TYPES.has(str(msgType).toLowerCase());
}

/** Photo links in a photo message's content: href / normalUrl (normal size), params.hd / params.rawUrl / hdUrl. */
function imageUrlsFromContent(content) {
  const obj = typeof content === 'string' ? safeJsonParse(content) : content;
  if (!isPlainObject(obj)) return [];
  const params = typeof obj.params === 'string' ? safeJsonParse(obj.params) || {} : isPlainObject(obj.params) ? obj.params : {};
  return imageUrls([obj.href, obj.normalUrl, params.hd, params.rawUrl, obj.hdUrl]);
}

/** Image type from the first few bytes (FinTrack accepts JPG / PNG / WebP) → mime or ''. */
function imageMime(base64) {
  let head;
  try {
    head = Buffer.from(str(base64).slice(0, 24), 'base64');
  } catch {
    return '';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return '';
}

/**
 * Looks like the plugin's own reply (starts with ✅ ❓ ⚠ 🎙 📝 ↩, REPLY_MARKERS). Prevents loops, since the user's own
 * messages are recorded too.
 */
function looksLikeOwnReply(text) {
  const s = str(text).trimStart();
  return REPLY_MARKERS.some((m) => s.startsWith(m));
}

const VOICE_TYPES = new Set(['chat.voice', 'voice', 'audio']);

function isVoiceType(msgType) {
  return VOICE_TYPES.has(str(msgType).toLowerCase());
}

/**
 * Voice note link + duration from content (JSON string or object), like Deplao's VoiceBubble:
 * href, or params.m4a / params.url (Zalo CDN only); duration in ms or seconds (values over 300 are taken as ms).
 */
function voiceInfoFromContent(content) {
  const obj = typeof content === 'string' ? safeJsonParse(content) : content;
  if (!isPlainObject(obj)) return { url: '', durationSec: 0 };
  const params = typeof obj.params === 'string' ? safeJsonParse(obj.params) || {} : isPlainObject(obj.params) ? obj.params : {};
  const url = str(obj.href || params.m4a || params.url || '').trim();
  const rawDur = Number(params.duration || params.dur || 0) || 0;
  const durationSec = rawDur > 300 ? rawDur / 1000 : rawDur;
  return { url: url.length <= 2000 && isZaloMediaUrl(url) ? url : '', durationSec };
}

/** Mime from the returned content-type, or from the file extension. */
function audioMime(contentType, url) {
  const ct = str(contentType).split(';')[0].trim().toLowerCase();
  if (ct.startsWith('audio/') || ct === 'video/mp4') return ct === 'video/mp4' ? 'audio/mp4' : ct;
  const ext = (/\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(str(url)) || [])[1];
  switch (str(ext).toLowerCase()) {
    case 'aac': return 'audio/aac';
    case 'amr': return 'audio/amr';
    case 'mp3': return 'audio/mpeg';
    case 'ogg': case 'oga': case 'opus': return 'audio/ogg';
    case 'wav': return 'audio/wav';
    case 'webm': return 'audio/webm';
    default: return 'audio/mp4'; // Zalo: m4a
  }
}

/** Key part: safe characters only. */
function idPart(v) {
  return str(v).trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || '_';
}

/**
 * Dedupe key per Zalo message: zalo:<threadId>:<msgId> (CONTRACTS §3.5). Zalo msgIds are globally unique, so when two
 * of your Zalo accounts are in the same group (both receive the message) it is processed only once.
 */
function messageKey({ threadId, msgId, timestamp, senderId }) {
  return `zalo:${idPart(threadId)}:${idPart(msgId || (timestamp ? `t${timestamp}-${senderId || ''}` : ''))}`;
}

module.exports = {
  extractTriggerMessage,
  chatCommand,
  quoteRef,
  looksLikeOwnReply,
  isVoiceType,
  isImageType,
  isZaloMediaUrl,
  imageUrlsFromContent,
  imageMime,
  voiceInfoFromContent,
  audioMime,
  messageKey,
};
