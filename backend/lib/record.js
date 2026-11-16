'use strict';
/**
 * Workflow nodes (CONTRACTS §3.5):
 *  - fintrack.record: a text / voice / photo message (receipt, bank transfer screenshot) in a Zalo group → FinTrack's
 *    AI assistant (one conversation per group, recording into the FinTrack account currently open; FinTrack's own
 *    assistant or a Deplao one, see lib/proxy) → a draft awaiting confirmation (default; kept in FinTrack's
 *    "Chờ xác nhận" (Awaiting confirmation) inbox under "Tổng quan" (Overview)) or confident entries auto-recorded via
 *    /api/assistant/commit → a short reply in the group. The sender replies “ok” (record) / “huỷ” (dismiss, or undo
 *    what was recorded).
 *  - fintrack.transcribe: voice note → text (/api/integration/transcribe).
 *
 * How a message flows (recordMessage → processMessage / runCommand):
 *   1. filter: the app's own replies and text messages that do not mention money are skipped (no storage write, no AI
 *      call); “ok” / “huỷ” to an assistant reply → runCommand;
 *   2. dedupe per Zalo message (kept 7 days: if two of your Zalo accounts are in the group, it is processed once);
 *   3. input: text, voice note → text, or photo (only if the account's assistant can read images);
 *   4. assistant → entries (actions); FinTrack keeps the draft (sent with `inbox`: group, sender, message text);
 *   5. auto-record eligible entries (auto mode), the rest await confirmation;
 *   6. reply in the group (✅ / 📝 / ❓ / ⚠️) and remember reply ↔ draft (state.rememberReply).
 *
 * Bad input never throws: returns { skipped: '<reason>' }. Transient errors (FinTrack / AI not responding) or an
 * unfinished setup → unmark the message as processed, so a rerun (e.g. "Chạy thử" (Test run) in the workflow) can still
 * process it.
 */

const C = require('./constants');
const { PluginError, describeError } = require('./errors');
const { createFinTrackClient } = require('./fintrackClient');
const proxy = require('./proxy');
const state = require('./state');
const { hasMoneyMention, findAmounts, amountMatchesText, amountOf } = require('./money');
const {
  extractTriggerMessage, looksLikeOwnReply, isVoiceType, isImageType, imageUrlsFromContent, imageMime,
  voiceInfoFromContent, audioMime, messageKey, chatCommand, quoteRef,
} = require('./message');
const {
  formatDraftReply, formatAutoReply, formatConfirmReply, formatCancelReply, formatCommandNote, formatQuestion, formatError,
} = require('./reply');
const { createDeadline, withTimeout, cleanLine, uuidFromName, isTimeoutError, isPlainObject, bodyError } = require('./util');

/** Entry types that may be auto-recorded (auto mode); other types (trades, savings…) always await confirmation. */
const AUTO_TYPES = new Set(['expense', 'income', 'transfer']);

const recentSent = new Map(); // msg_id / cli_msg_id the plugin just sent → time
const inFlight = new Set(); // keys of messages being processed in this process
const errorReplyAt = new Map(); // threadId → last time an error was reported in the group
const ownAccounts = { at: 0, names: new Map() }; // Zalo accounts on this Deplao: id → display name

const nodeOutput = () => ({ recorded: 0, drafts: 0, items: [], text: '', reply: '', skipped: '' });

/** Clear the in-process caches (storage data is kept). For tests. */
function resetMemory() {
  recentSent.clear();
  inFlight.clear();
  errorReplyAt.clear();
  ownAccounts.at = 0;
  ownAccounts.names = new Map();
}

/**
 * Setup not finished: not deployed, no account open, account gone, wrong secret, outdated FinTrack, account owner
 * disabled. Group members cannot fix these → skip silently (the Options page ("Tuỳ chọn") shows the error to the
 * account owner).
 */
function isSetupError(err) {
  const code = err && err.code;
  if (['NOT_DEPLOYED', 'NOT_CONFIGURED', 'WORKSPACE_GONE', 'FT_NOT_CONFIGURED', 'FT_NO_INTEGRATION', 'FT_UNAUTHORIZED'].includes(code)) return true;
  return code === 'FT_FORBIDDEN' && err.serverCode === 'account_disabled';
}

// ─── The app's own messages ──────────────────────────────────────────────────

function prune(map, ttl, now = Date.now()) {
  for (const [k, at] of map) if (now - at > ttl) map.delete(k);
}

function rememberSent(sent) {
  const now = Date.now();
  for (const s of Array.isArray(sent) ? sent : []) {
    if (s && s.msg_id) recentSent.set(String(s.msg_id), now);
    if (s && s.cli_msg_id) recentSent.set(String(s.cli_msg_id), now);
  }
  prune(recentSent, C.SENT_TTL_MS, now);
}

/** Zalo accounts on this Deplao: id → display name (cached 5 minutes; read error → the cached copy). */
async function zaloAccounts(deplao) {
  if (ownAccounts.at && Date.now() - ownAccounts.at < C.OWN_ACCOUNTS_TTL_MS) return ownAccounts.names;
  try {
    const list = await withTimeout(deplao.accounts.listAccounts({ channel: 'zalo' }), C.TIMEOUTS.SYSTEM_INFO, 'Tài khoản Zalo');
    const rows = Array.isArray(list) ? list : [];
    ownAccounts.names = new Map(rows.filter((a) => a && a.channel === 'zalo').map((a) => [String(a.id), cleanLine(a.display_name, 60)]));
    ownAccounts.at = Date.now();
  } catch {
    /* read failed: messages from your other accounts count as members' messages */
  }
  return ownAccounts.names;
}

/**
 * The app's own replies are not processed (avoids loops): the id of a message we just sent (also when another of your
 * Zalo accounts in the group receives it), or a message starting with ✅ ❓ ⚠ 🎙 📝 ↩ (REPLY_MARKERS) from a Zalo
 * account on this Deplao. Other members typing those signs are processed as usual.
 */
async function isOwnReply(deplao, msg) {
  if ((msg.msgId && recentSent.has(msg.msgId)) || (msg.cliMsgId && recentSent.has(msg.cliMsgId))) return true;
  if (!looksLikeOwnReply(msg.text)) return false;
  return msg.isSelf || (!!msg.senderId && (await zaloAccounts(deplao)).has(msg.senderId));
}

/** Plain text message (no photo, no voice note): recognised from the trigger alone, no type lookup needed. */
function isPlainText(msg) {
  return !!msg.text && !msg.hasImage && (!msg.msgType || msg.msgType === 'webchat');
}

// ─── Receiving account ───────────────────────────────────────────────────────

/**
 * FinTrack account (workspace) that receives the message → { workspaceId }: the account currently open in FinTrack on
 * this Deplao (there is no group selection step: the workflow decides which messages reach the node). No account open
 * yet → on first use (FinTrack has exactly one account) open that account automatically, as the UI does.
 */
async function ledgerOf(ctx) {
  const { deplao, settings } = ctx;
  let active = await state.getActive(deplao);
  if (!active) {
    await proxy.ensureSession(deplao, state.requireDeployed(await state.getFinTrackConfig(deplao, settings)));
    active = await state.getActive(deplao);
  }
  if (!active) throw new PluginError('NOT_CONFIGURED', 'Chưa mở tài khoản FinTrack nào: mở ứng dụng FinTrack trong Deplao để đăng nhập / tạo tài khoản.');
  return { workspaceId: active.id };
}

// ─── Message type, file download ─────────────────────────────────────────────

/**
 * Message type. The flattened trigger has no msgType → a message without text, or with photo links (a photo with a
 * caption), is looked up again via getMessage (msg_type + content). Plain text messages are not looked up.
 * → { kind: 'text' | 'voice' | 'image' | 'other' | 'unknown', content }
 */
async function resolveMessage(ctx, msg) {
  let msgType = msg.msgType;
  let content = msg.rawContent;
  if ((!msgType || content === null) && (!msg.text || msg.hasImage)) {
    if (!msg.msgId || !msg.threadId) return { kind: msg.text ? 'text' : 'other', content };
    let row;
    try {
      row = await withTimeout(ctx.deplao.chat.getMessage({ accountId: msg.accountId, threadId: msg.threadId, msgId: msg.msgId }), C.TIMEOUTS.GET_MESSAGE, 'Đọc tin nhắn');
    } catch {
      // Lookup failed: with text, treat it as a text message; otherwise the type is unknown (retry later).
      return { kind: msg.text ? 'text' : 'unknown', content };
    }
    msgType = (row && row.msg_type) || '';
    content = row && row.content !== undefined ? row.content : null;
  }
  if (isVoiceType(msgType)) return { kind: 'voice', content };
  if (isImageType(msgType)) return { kind: 'image', content };
  return { kind: msg.text ? 'text' : 'other', content };
}

/** The message's file via Deplao (downloaded with the Zalo account's session) → { base64, mime } (empty if no file). */
async function downloadMedia(ctx, msg, label) {
  const media = await withTimeout(ctx.deplao.chat.downloadMessageMedia({ accountId: msg.accountId, threadId: msg.threadId, msgId: msg.msgId }), C.TIMEOUTS.DOWNLOAD_MEDIA, label);
  return media && typeof media.base64 === 'string' ? { base64: media.base64, mime: String(media.mime || '') } : { base64: '', mime: '' };
}

/** Fallback download from the Zalo CDN (links filtered by lib/message) → { base64, mime } or null. Never throws. */
async function fetchZaloMedia(ctx, url) {
  try {
    const res = await ctx.deplao.http.fetch(url, { method: 'GET', headers: { Referer: 'https://chat.zalo.me/' }, timeoutMs: C.TIMEOUTS.MEDIA_FETCH, responseType: 'base64' });
    if (!res || res.status < 200 || res.status >= 300 || res.truncated || !res.base64) return null;
    return { base64: res.base64, mime: String((res.headers && res.headers['content-type']) || '') };
  } catch {
    return null;
  }
}

// ─── Voice notes ─────────────────────────────────────────────────────────────

/**
 * Voice note → text: downloadMessageMedia (fallback: the voice note link on the Zalo CDN) → /api/integration/transcribe
 * of the account receiving the group messages. `reserveMs`: time to leave for the next step (the assistant's answer).
 * → { text, durationSec }
 */
async function transcribeVoice(ctx, msg, content, { workspaceId, deadline, reserveMs }) {
  const info = voiceInfoFromContent(content);
  if (info.durationSec > C.MAX_VOICE_SECONDS) throw new PluginError('VOICE_TOO_LONG', `Ghi âm dài hơn ${Math.round(C.MAX_VOICE_SECONDS / 60)} phút.`);
  let audio = { base64: '', mime: '' };
  let downloadError = null;
  try {
    audio = await downloadMedia(ctx, msg, 'Tải ghi âm');
  } catch (err) {
    downloadError = err;
  }
  if (!audio.base64 && info.url) audio = (await fetchZaloMedia(ctx, info.url)) || audio;
  if (!audio.base64) throw new PluginError('VOICE_DOWNLOAD', `Không tải được ghi âm${downloadError ? `: ${downloadError.message}` : ''}.`);
  if (Math.floor((audio.base64.length * 3) / 4) > C.MAX_AUDIO_BYTES) throw new PluginError('VOICE_TOO_LARGE', 'Ghi âm lớn hơn 5 MB.');
  const cfg = state.requireDeployed(await state.getFinTrackConfig(ctx.deplao, ctx.settings));
  const client = createFinTrackClient({ fetch: ctx.deplao.http.fetch, baseUrl: cfg.baseUrl, secret: cfg.secret, workspaceId });
  const timeout = Math.max(5000, Math.min(C.TIMEOUTS.TRANSCRIBE, deadline.remaining() - reserveMs));
  const tr = await client.transcribe({ audio: audio.base64, mime: audioMime(audio.mime, info.url) }, { timeout });
  return { text: cleanLine((tr && tr.text) || '', C.MAX_TEXT_CHARS), durationSec: info.durationSec };
}

// ─── Photos ──────────────────────────────────────────────────────────────────

/**
 * Can the account's assistant (or the one set on the node) read images? Picks the assistant like lib/proxy (aiFor):
 * a Deplao assistant → no (Deplao only takes text); FinTrack's own assistant → per supportsImages (OpenAI, Gemini;
 * DeepSeek only with Flash).
 * → 'ok' | 'deplao' | 'model' | 'unknown'
 */
async function imageSupport(turn, workspaceId) {
  const ai = await proxy.aiFor(turn.deplao, workspaceId, turn.assistantId);
  if (ai.source !== 'fintrack') return 'deplao';
  const r = await proxy.forward(turn.ctx, { method: 'GET', path: '/assistant/settings' }, { workspaceId, timeoutMs: C.TIMEOUTS.SETTINGS });
  if (r.status !== 200 || !isPlainObject(r.body)) return 'unknown';
  return r.body.supportsImages ? 'ok' : 'model';
}

/**
 * Photo → data URL (FinTrack accepts JPG / PNG / WebP, base64 ≤ MAX_IMAGE_BASE64 ≈ 4 MB). downloadMessageMedia first;
 * too large, another format or download failed → the photo links on the Zalo CDN in the message (the normal size is
 * smaller than the HD one).
 */
async function loadImage(ctx, msg, content, deadline) {
  const usable = (b64) => typeof b64 === 'string' && b64.length > 0 && b64.length <= C.MAX_IMAGE_BASE64 && !!imageMime(b64);
  let b64 = '';
  let downloadError = null;
  try {
    b64 = (await downloadMedia(ctx, msg, 'Tải ảnh')).base64;
  } catch (err) {
    downloadError = err;
  }
  if (!usable(b64)) {
    for (const url of [...new Set([...imageUrlsFromContent(content), ...msg.images])].slice(0, 3)) {
      if (deadline.remaining() < C.ASSISTANT_RESERVE_MS) break;
      const got = await fetchZaloMedia(ctx, url);
      if (got && usable(got.base64)) {
        b64 = got.base64;
        break;
      }
    }
  }
  if (!b64) throw new PluginError('IMAGE_DOWNLOAD', `Không tải được ảnh${downloadError ? `: ${downloadError.message}` : ''}.`);
  const mime = imageMime(b64);
  if (!mime) throw new PluginError('IMAGE_UNSUPPORTED', 'Ảnh không phải JPG / PNG / WebP.');
  if (b64.length > C.MAX_IMAGE_BASE64) throw new PluginError('IMAGE_TOO_LARGE', 'Ảnh lớn hơn ~4 MB.');
  return `data:${mime};base64,${b64}`;
}

// ─── fintrack.record ─────────────────────────────────────────────────────────

/**
 * Can this entry be auto-recorded: income / expense / transfer, the amount appears in the message (guards against
 * made-up AI numbers), wallets set (plus a category for income / expense), and the assistant flagged no field as
 * unsure (`unsure` → the user picks on the draft).
 */
function autoEligible(action, candidates) {
  if (!action || !AUTO_TYPES.has(action.type)) return false;
  if (Array.isArray(action.unsure) && action.unsure.length) return false;
  const amount = amountOf(action);
  if (!amount || !candidates.length || !amountMatchesText(amount, candidates)) return false;
  if (!action.accountId) return false;
  if ((action.type === 'expense' || action.type === 'income') && !action.categoryId) return false;
  if (action.type === 'transfer' && !action.destinationAccountId) return false;
  return true;
}

/** One entry of the node's `items` output. */
function itemOf(action, index, status, error) {
  const a = action || {};
  return {
    index,
    type: a.type || '',
    amount: amountOf(a),
    currency: a.currency || 'VND',
    accountId: a.accountId || null,
    destinationAccountId: a.destinationAccountId || null,
    categoryId: a.categoryId || null,
    note: a.note || '',
    date: a.date || null,
    status,
    ...(error ? { error } : {}),
  };
}

/** Assistant error (FinTrack HTTP status) → kind of group notice (lib/reply ERROR_TEXT). */
function assistantErrorKind(status, code) {
  if (status === 429) return 'ai_limit';
  if (code === 'deplao_ai' || code === 'bad_output' || (status === 502 && code !== 'bad_response')) return 'ai';
  if (status === 400) return 'ai_setup';
  return 'fintrack';
}

/** A turn of processing one message: node config, message, deadline (Deplao stops nodes after 60 s), group replies. */
class Turn {
  constructor(nodeCfg, msg, accountId, ctx) {
    this.ctx = ctx;
    this.deplao = ctx.deplao;
    this.nodeCfg = nodeCfg;
    this.msg = msg;
    this.accountId = accountId;
    this.deadline = createDeadline(C.NODE_BUDGET_MS);
    this.mode = nodeCfg.mode === 'auto' ? 'auto' : 'draft';
    this.assistantId = cleanLine(nodeCfg.assistantId, 100);
    this.replyOn = nodeCfg.replyInGroup !== false;
    this.quoteMsgId = nodeCfg.quoteReply !== false ? msg.msgId : '';
    /** Text that was read (voice note: the transcript), the node's `text` output. */
    this.text = msg.text;
    /** msg_id / cli_msg_id of the replies sent in this turn (so a quoted “ok” / “huỷ” can find the draft). */
    this.sentIds = [];
  }

  /** End the turn → { out: node output, retry: unmark as processed so the message can be processed again later }. */
  end(skipped, { retry = false, ...fields } = {}) {
    return { out: { ...nodeOutput(), text: this.text, ...fields, skipped }, retry };
  }

  /**
   * Error: setup not finished → skip silently; other errors → log and notify the group (at most once per 10 minutes
   * per group). By default the message may be processed again later.
   */
  async fail(err, skipped, kind, { retry = true } = {}) {
    if (isSetupError(err)) {
      console.warn(`[fintrack] Bỏ qua tin (chưa thiết lập xong): ${err.message}`);
      return this.end('not_configured', { retry: true });
    }
    console.warn(`[fintrack] ${skipped} (${(err && err.code) || 'ERR'}): ${err && err.message}`);
    const timedOut = !!err && (err.code === 'FT_TIMEOUT' || isTimeoutError(err));
    return this.end(skipped, { retry, reply: await this.warn(kind === 'fintrack' && timedOut ? 'timeout' : kind) });
  }

  /**
   * Reply in the group (quoting the original message if possible) → the text sent; '' if replies are off or sending
   * failed (only logged).
   */
  async say(text) {
    if (!this.replyOn || !text) return '';
    const base = { accountId: this.accountId, threadId: this.msg.threadId, text, ...(this.msg.isGroup ? { thread_type: 'group' } : {}) };
    const send = (params) => withTimeout(this.deplao.chat.sendMessage(params), C.TIMEOUTS.SEND_MESSAGE, 'Gửi tin');
    try {
      let res;
      try {
        res = await send(this.quoteMsgId ? { ...base, quote_msg_id: this.quoteMsgId } : base);
      } catch (err) {
        // The original message cannot be quoted (recalled…) → send without the quote.
        if (!this.quoteMsgId || !['NOT_FOUND', 'VALIDATION_ERROR'].includes(err && err.code)) throw err;
        res = await send(base);
      }
      rememberSent(res && res.sent);
      for (const s of Array.isArray(res && res.sent) ? res.sent : []) {
        if (s && s.msg_id) this.sentIds.push(String(s.msg_id));
        if (s && s.cli_msg_id) this.sentIds.push(String(s.cli_msg_id));
      }
      return text;
    } catch (err) {
      console.warn(`[fintrack] Không gửi được tin trả lời: ${err && err.message}`);
      return '';
    }
  }

  /** Report an error in the group, at most once per ERROR_REPLY_GAP_MS per group. */
  async warn(kind) {
    if (!this.replyOn) return '';
    const now = Date.now();
    if (now - (errorReplyAt.get(this.msg.threadId) || 0) < C.ERROR_REPLY_GAP_MS) return '';
    prune(errorReplyAt, C.ERROR_REPLY_GAP_MS, now);
    errorReplyAt.set(this.msg.threadId, now);
    return this.say(formatError(kind));
  }
}

/**
 * Input for the assistant → { input: { text, transcript, image } } or { end } (turn finished).
 * Photo: the caption is the text part; the photo is only downloaded if the account's assistant can read images.
 */
async function readInput(turn, resolved, workspaceId) {
  const { ctx, msg } = turn;
  if (resolved.kind === 'voice') {
    let v;
    try {
      v = await transcribeVoice(ctx, msg, resolved.content, { workspaceId, deadline: turn.deadline, reserveMs: C.ASSISTANT_RESERVE_MS });
    } catch (err) {
      return { end: await turn.fail(err, 'voice_failed', 'voice') };
    }
    turn.text = v.text;
    if (!v.text) return { end: turn.end('empty_transcript') };
    return { input: { text: v.text, transcript: v.text, image: '' } };
  }
  if (resolved.kind === 'image') {
    let support;
    try {
      support = await imageSupport(turn, workspaceId);
    } catch (err) {
      return { end: await turn.fail(err, 'fintrack_error', 'fintrack') };
    }
    if (support === 'unknown') return { end: turn.end('fintrack_error', { retry: true }) };
    if (support !== 'ok') {
      console.warn(`[fintrack] Bỏ qua ảnh: trợ lý đang chọn không đọc được ảnh (${support})`);
      return { end: turn.end('image_unsupported_ai', { reply: await turn.warn(support === 'model' ? 'image_model' : 'image_ai') }) };
    }
    try {
      return { input: { text: msg.text, transcript: '', image: await loadImage(ctx, msg, resolved.content, turn.deadline) } };
    } catch (err) {
      // An unreadable photo (format / too large) stays unreadable next time → no retry.
      const permanent = err.code === 'IMAGE_UNSUPPORTED' || err.code === 'IMAGE_TOO_LARGE';
      return { end: await turn.fail(err, 'image_failed', 'image', { retry: !permanent }) };
    }
  }
  return { input: { text: msg.text, transcript: '', image: '' } };
}

/**
 * Ask the account's assistant (one conversation per replying Zalo account and group)
 * → { answer: { messageId, actions, reply, kept, sender, userText } } or { end }.
 */
async function askAssistant(turn, workspaceId, input) {
  const { msg } = turn;
  const own = msg.isSelf ? (await zaloAccounts(turn.deplao)).get(turn.accountId) : '';
  const sender = msg.senderName || own || 'Thành viên';
  const userText = input.image ? `[Ảnh]${input.text ? ` ${input.text}` : ''}` : input.text;
  const body = {
    conversationId: uuidFromName(`zalo:${turn.accountId}:${msg.threadId}`),
    text: `Người gửi: ${sender}\n${userText}`.slice(0, C.MAX_CHAT_TEXT),
    ...(input.image ? { image: input.image } : {}),
    // If there are entries, FinTrack keeps a draft (the "Chờ xác nhận" inbox) with this source.
    inbox: { channel: 'zalo', group: cleanLine(msg.groupName || '', 120), sender: cleanLine(sender, 80), text: cleanLine(userText, 600) },
  };
  let res;
  try {
    const timeoutMs = Math.max(10_000, Math.min(C.TIMEOUTS.CHAT, turn.deadline.remaining() - 4000));
    res = await proxy.forward(turn.ctx, { method: 'POST', path: '/assistant/chat', body }, { workspaceId, assistantId: turn.assistantId, deadline: turn.deadline, timeoutMs });
  } catch (err) {
    return { end: await turn.fail(err, 'fintrack_error', 'fintrack') };
  }
  // The account's session cannot be re-minted (e.g. the account is no longer remembered) → treat as not set up.
  if (res.status === 401) return { end: turn.end('not_configured', { retry: true }) };
  if (res.status >= 400) {
    console.warn(`[fintrack] Trợ lý FinTrack trả ${res.status}: ${bodyError(res.body)}`);
    // Photo rejected by FinTrack (400: format / model cannot read images) → "could not read the photo", no retry.
    if (input.image && res.status === 400) return { end: turn.end('image_failed', { reply: await turn.warn('image') }) };
    const kind = assistantErrorKind(res.status, res.body && res.body.code);
    return { end: turn.end(kind === 'fintrack' ? 'fintrack_error' : 'ai_error', { retry: true, reply: await turn.warn(kind) }) };
  }
  const a = isPlainObject(res.body) ? res.body : {};
  return {
    answer: {
      messageId: String(a.id || ''),
      actions: Array.isArray(a.actions) ? a.actions : [],
      reply: typeof a.reply === 'string' ? a.reply : '',
      /** false / undefined: FinTrack kept no draft (an older Worker without the "Chờ xác nhận" inbox). */
      kept: a.draft === true,
      sender,
      userText,
    },
  };
}

/** Record one entry via /api/assistant/commit (FinTrack dedupes by messageId + actionIndex) → '' or an error text. */
async function commitAction(turn, workspaceId, messageId, index, action) {
  try {
    const timeoutMs = Math.max(3000, Math.min(C.TIMEOUTS.COMMIT, turn.deadline.remaining() - 3000));
    const r = await proxy.forward(turn.ctx, { method: 'POST', path: '/assistant/commit', body: { messageId, actionIndex: index, action } }, { workspaceId, deadline: turn.deadline, timeoutMs });
    if (r.status >= 200 && r.status < 300) return '';
    return bodyError(r.body, 200) || `FinTrack trả ${r.status}`;
  } catch (err) {
    return cleanLine(describeError(err).message, 200);
  }
}

/**
 * Auto mode: auto-record eligible entries (autoEligible) while time allows; the rest, and every entry in draft mode,
 * await confirmation (FinTrack already keeps the draft with the assistant's message).
 * → { items, recorded: action[], pending: [{ index, action, error? }] }
 */
async function recordActions(turn, ledger, input, answer) {
  const { messageId, actions } = answer;
  const items = actions.map((a, i) => itemOf(a, i, 'draft'));
  const recorded = [];
  const pending = [];
  const auto = turn.mode === 'auto' && !!messageId;
  const candidates = auto ? findAmounts(input.text) : [];
  for (const [i, action] of actions.entries()) {
    // Under 8 s left: stop recording (a node stopped midway cannot reply) → leave it awaiting confirmation.
    if (!auto || !autoEligible(action, candidates) || turn.deadline.remaining() < 8000) {
      pending.push({ index: i, action });
      continue;
    }
    const error = await commitAction(turn, ledger.workspaceId, messageId, i, action);
    if (error) {
      pending.push({ index: i, action, error });
      items[i] = itemOf(action, i, 'draft', error);
    } else {
      recorded.push(action);
      items[i] = itemOf(action, i, 'recorded');
    }
  }
  if (pending.length && !answer.kept) {
    console.warn('[fintrack] FinTrack chưa giữ bản nháp (Worker bản cũ): trang Tuỳ chọn → Cập nhật FinTrack.');
  }
  return { items, recorded, pending };
}

async function processMessage(turn) {
  const { ctx, msg, nodeCfg } = turn;
  // 1) Message type.
  const resolved = await resolveMessage(ctx, msg);
  if (resolved.kind === 'unknown') return turn.end('unsupported_message', { retry: true });
  if (resolved.kind === 'other') return turn.end('unsupported_message');
  if (resolved.kind === 'voice' && nodeCfg.voice === false) return turn.end('voice_disabled');
  if (resolved.kind === 'image' && nodeCfg.images === false) return turn.end('images_disabled');

  // 2) Account receiving the group messages, input for the assistant.
  let ledger;
  try {
    ledger = await ledgerOf(ctx);
  } catch (err) {
    return turn.fail(err, 'fintrack_error', 'fintrack');
  }
  const read = await readInput(turn, resolved, ledger.workspaceId);
  if (read.end) return read.end;
  const { input } = read;
  // A transcribed voice note must mention money too; photos always go to the assistant (the amount is in the photo).
  if (!input.image && !hasMoneyMention(input.text)) return turn.end('no_amount');

  // 3) The account's assistant.
  const asked = await askAssistant(turn, ledger.workspaceId, input);
  if (asked.end) return asked.end;
  const { answer } = asked;
  if (!answer.actions.length) {
    // The assistant asks back (reply has a "?") → reply in the group; otherwise (not income / expense) → stay silent.
    if (!/[?？]/.test(answer.reply)) return turn.end('not_transaction');
    return turn.end('unclear', { reply: await turn.say(formatQuestion(answer.reply, input.transcript)) });
  }

  // 4) Auto-record / draft, 5) reply in the group.
  const { items, recorded, pending } = await recordActions(turn, ledger, input, answer);
  const reply = await turn.say(turn.mode === 'auto'
    ? formatAutoReply({ recorded, pending: pending.map((p) => p.action), transcript: input.transcript })
    : formatDraftReply({ actions: answer.actions, transcript: input.transcript }));
  // A later “ok” / “huỷ” (quoting the reply, or sent right after) finds this draft again.
  if (answer.messageId) {
    await state.rememberReply(turn.deplao, {
      ids: turn.sentIds, threadId: msg.threadId, senderId: msg.senderId, workspaceId: ledger.workspaceId, messageId: answer.messageId,
      pending: pending.length > 0,
    }).catch((err) => console.warn(`[fintrack] Không nhớ được tin trả lời: ${err.message}`));
  }
  console.log(`[fintrack] Tin …${String(msg.msgId).slice(-6)}: ${recorded.length} khoản đã ghi, ${pending.length} chờ xác nhận`);
  return turn.end('', { recorded: recorded.length, drafts: pending.length, items, reply });
}

// ─── “ok” / “huỷ” in the group ───────────────────────────────────────────────

/** The message being replied to (quoted): from the trigger, else looked up in Deplao (quote_data). */
async function quoteOf(ctx, msg) {
  if (msg.quote !== undefined) return msg.quote;
  if (!msg.msgId || !msg.threadId) return null;
  try {
    const row = await withTimeout(ctx.deplao.chat.getMessage({ accountId: msg.accountId, threadId: msg.threadId, msgId: msg.msgId }), C.TIMEOUTS.GET_MESSAGE, 'Đọc tin nhắn');
    return quoteRef(row && row.quote);
  } catch {
    return null;
  }
}

/**
 * Which draft an “ok” / “huỷ” message targets → { command: 'confirm' | 'cancel', ref, quoted } or null (ordinary chat).
 * Quoting an assistant reply → that reply's draft (quoting any other message: ordinary chat). Not quoted → within
 * COMMAND_WINDOW_MS, the sender's own drafts in this group: “ok” = latest draft still pending, “huỷ” = latest draft
 * (pending or not).
 */
async function commandTarget(ctx, msg) {
  if (!chatCommand(msg.text, { quoted: true })) return null;
  const quote = await quoteOf(ctx, msg);
  const replies = await state.listReplies(ctx.deplao);
  if (quote) {
    const ref = replies.find((r) => r.threadId === msg.threadId
      && ((quote.msgId && r.ids.includes(quote.msgId)) || (quote.cliMsgId && r.ids.includes(quote.cliMsgId))));
    return ref ? { command: chatCommand(msg.text, { quoted: true }), ref, quoted: true } : null;
  }
  const command = chatCommand(msg.text);
  if (!command || !msg.senderId) return null;
  const since = Date.now() - C.COMMAND_WINDOW_MS;
  const ref = replies.find((r) => r.threadId === msg.threadId && r.senderId === msg.senderId && r.at >= since
    && (command === 'cancel' || r.pending));
  return ref ? { command, ref, quoted: false } : null;
}

/**
 * “ok” → FinTrack records every pending entry of the draft; “huỷ” → reverses recorded entries (auto mode / after “ok”)
 * and drops the pending rest. Only the original sender or the account owner (a Zalo account on this Deplao) may do
 * this. Replies quote the command message; an unquoted command with nothing left to do stays silent.
 */
async function runCommand(turn, { command, ref, quoted }) {
  const { ctx, msg } = turn;
  const note = async (kind) => (quoted ? turn.say(formatCommandNote(kind)) : '');
  // Update the remembered draft: the reply just sent (e.g. “✅ Đã ghi”) also points to it; pending = entries left.
  const settle = (pending) => state.rememberReply(turn.deplao, { ...ref, ids: turn.sentIds, pending }).catch(() => undefined);
  const owner = msg.isSelf || (!!msg.senderId && (await zaloAccounts(turn.deplao)).has(msg.senderId));
  if (!owner && (!ref.senderId || msg.senderId !== ref.senderId)) return turn.end('not_allowed', { reply: await note('not_allowed') });
  const path = `/assistant/drafts/${encodeURIComponent(ref.messageId)}/${command === 'confirm' ? 'confirm' : 'undo'}`;
  let res;
  try {
    const timeoutMs = Math.max(5000, Math.min(C.TIMEOUTS.DRAFT_ACTION, turn.deadline.remaining() - 4000));
    res = await proxy.forward(ctx, { method: 'POST', path, body: {} }, { workspaceId: ref.workspaceId, deadline: turn.deadline, timeoutMs });
  } catch (err) {
    return turn.fail(err, 'fintrack_error', 'fintrack');
  }
  if (res.status === 401) return turn.end('not_configured', { retry: true });
  // Draft gone (deleted with the assistant history) / an older Worker without the "Chờ xác nhận" inbox.
  if (res.status === 404) {
    await settle(false);
    return turn.end('draft_gone');
  }
  // Already dismissed ("Bỏ qua" (Dismiss) in FinTrack, or an earlier “huỷ”) → record nothing.
  if (res.status === 409) {
    const reply = await note('cancelled');
    await settle(false);
    return turn.end('already', { reply });
  }
  if (res.status >= 400) {
    console.warn(`[fintrack] ${command === 'confirm' ? 'Xác nhận' : 'Huỷ'} bản nháp: FinTrack trả ${res.status}: ${bodyError(res.body)}`);
    return turn.end('fintrack_error', { retry: true, reply: await turn.warn('fintrack') });
  }
  const body = isPlainObject(res.body) ? res.body : {};
  if (body.already) {
    const reply = await note(command === 'confirm' ? 'confirmed' : 'cancelled');
    await settle(false);
    return turn.end('already', { reply });
  }
  const draftActions = isPlainObject(body.draft) && Array.isArray(body.draft.actions) ? body.draft.actions.filter(isPlainObject) : [];
  const actionAt = (index) => (draftActions.find((a) => a.index === index) || {}).action || {};
  const results = (Array.isArray(body.results) ? body.results : []).filter(isPlainObject);
  const done = results.filter((r) => r.ok).map((r) => actionAt(r.index));
  const failed = results.filter((r) => !r.ok).map((r) => ({ action: actionAt(r.index), error: cleanLine(r.error, 120) }));
  const text = command === 'confirm'
    ? formatConfirmReply({ recorded: done, failed })
    : formatCancelReply({ undone: done, dropped: draftActions.filter((a) => !a.saved).map((a) => a.action || {}), failed });
  const reply = await turn.say(text);
  await settle(command === 'confirm' && isPlainObject(body.draft) && body.draft.status === 'pending');
  console.log(`[fintrack] “${command === 'confirm' ? 'ok' : 'huỷ'}” cho tin …${ref.messageId.slice(-6)}: ${done.length} khoản, ${failed.length} lỗi`);
  const items = command === 'confirm'
    ? results.map((r) => itemOf(actionAt(r.index), r.index, r.ok ? 'recorded' : 'draft', r.ok ? '' : cleanLine(r.error, 120)))
    : [];
  const confirm = command === 'confirm';
  return turn.end('', { recorded: confirm ? done.length : 0, drafts: confirm ? failed.length : 0, items, reply });
}

/**
 * Node fintrack.record.
 * @param {object} nodeCfg  node config (variables already substituted by Deplao): account, mode, replyInGroup,
 *                          quoteReply, voice, images, assistantId
 * @param {object} run      { trigger, pageId, … }
 * @param {object} ctx      { deplao, settings }
 */
async function recordMessage(nodeCfg, run, ctx) {
  const cfg = isPlainObject(nodeCfg) ? nodeCfg : {};
  const msg = extractTriggerMessage(run && run.trigger, run && run.pageId);
  const accountId = String(cfg.account || msg.accountId || (run && run.pageId) || '');
  msg.accountId = msg.accountId || accountId;
  const skip = (skipped, text = '') => ({ ...nodeOutput(), text, skipped });

  if (!msg.msgId && !msg.text) return skip('no_message');
  if (await isOwnReply(ctx.deplao, msg)) return skip('own_reply');
  // “ok” / “huỷ” to an assistant reply (only a short text that is exactly such a word looks up storage / the quote).
  const target = isPlainText(msg) ? await commandTarget(ctx, msg) : null;
  // Most group messages are text without money → skip right away: no storage write, no assistant call.
  if (!target && isPlainText(msg) && !hasMoneyMention(msg.text)) return skip('no_amount', msg.text);

  const key = messageKey(msg);
  if (inFlight.has(key)) return skip('duplicate');
  inFlight.add(key);
  try {
    // Storage error → process anyway (inFlight still dedupes within this process).
    if (!(await state.markSeen(ctx.deplao, key).catch(() => true))) return skip('duplicate');
    const turn = new Turn(cfg, msg, accountId, ctx);
    const { out, retry } = target ? await runCommand(turn, target) : await processMessage(turn);
    if (retry) await state.unmarkSeen(ctx.deplao, key);
    return out;
  } finally {
    inFlight.delete(key);
  }
}

// ─── fintrack.transcribe ─────────────────────────────────────────────────────

async function transcribeMessage(nodeCfg, run, ctx) {
  const cfg = isPlainObject(nodeCfg) ? nodeCfg : {};
  const out = { text: '', durationSec: 0, skipped: '' };
  const msg = extractTriggerMessage(run && run.trigger, run && run.pageId);
  msg.accountId = msg.accountId || String(cfg.account || (run && run.pageId) || '');
  if (!msg.msgId && !msg.text) return { ...out, skipped: 'no_message' };
  // Voice notes have no text; a message with text (photo captions included) returns that text as is.
  if (msg.text) return { ...out, text: msg.text, skipped: 'not_voice' };
  try {
    const resolved = await resolveMessage(ctx, msg);
    if (resolved.kind !== 'voice') return { ...out, skipped: 'not_voice' };
    const { workspaceId } = await ledgerOf(ctx);
    const v = await transcribeVoice(ctx, msg, resolved.content, { workspaceId, deadline: createDeadline(C.NODE_BUDGET_MS), reserveMs: 2000 });
    return { text: v.text, durationSec: Math.round(v.durationSec || 0), skipped: v.text ? '' : 'empty_transcript' };
  } catch (err) {
    if (isSetupError(err)) return { ...out, skipped: 'not_configured' };
    console.warn(`[fintrack] Chuyển ghi âm lỗi (${err.code || 'ERR'}): ${err.message}`);
    return { ...out, skipped: 'voice_failed' };
  }
}

module.exports = {
  recordMessage,
  transcribeMessage,
  autoEligible,
  _internal: { reset: resetMemory },
};
