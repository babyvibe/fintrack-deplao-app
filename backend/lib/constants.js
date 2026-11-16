'use strict';
/**
 * Shared backend constants. Cloudflare resource names must equal the plugin prefix
 * (last part of the id: io.github.babyvibe.fintrack → "fintrack"); see docs/CONTRACTS.md §1.1.
 */

const PLUGIN_ID = 'io.github.babyvibe.fintrack';
const PLUGIN_VERSION = '0.1.1';

module.exports = Object.freeze({
  PLUGIN_ID,
  PLUGIN_VERSION,
  USER_AGENT: `fintrack-deplao-app/${PLUGIN_VERSION}`,

  /** Workflow nodes contributed by the plugin. */
  NODE_TYPE: 'fintrack.record',
  TRANSCRIBE_NODE_TYPE: 'fintrack.transcribe',

  /** Worker and D1 on Cloudflare (exactly the plugin prefix). */
  RESOURCE_NAME: 'fintrack',
  BINDING_DB: 'DB',
  BINDING_AI: 'AI',
  SECRET_NAME: 'DEPLAO_INTEGRATION_SECRET',
  /** Prebuilt FinTrack bundle, relative to the plugin directory (bundle.json per CONTRACTS §1.2). */
  BUNDLE_DIR: 'vendor/fintrack',

  /** FinTrack session cookie (CONTRACTS §2.1). */
  SESSION_COOKIE: 'fintrack_session',
  /** FinTrack sessions expire after 30 days; less than 2 minutes left counts as expired. */
  SESSION_DAYS_MS: 30 * 24 * 60 * 60_000,
  SESSION_SKEW_MS: 2 * 60_000,
  /** Header sent with every request from the UI / nodes in Deplao (CONTRACTS §2.3). */
  CLIENT_HEADER: 'X-FinTrack-Client',
  /** Which assistant answers: `deplao` (delegate to a Deplao assistant) or `fintrack` (FinTrack's own assistant). */
  AI_HEADER: 'X-FinTrack-AI',
  /** Deplao assistant name (percent-encoded, only with `deplao`). */
  ASSISTANT_HEADER: 'X-FinTrack-Assistant',
  /**
   * A resolved Deplao assistant is cached for 5 minutes; when FinTrack has no account or several (none to open
   * automatically), ask again after 1 minute.
   */
  ASSISTANT_TTL_MS: 5 * 60_000,
  AUTO_LINK_RECHECK_MS: 60_000,
  /** Max FinTrack accounts remembered on this Deplao (quick switch without a password). */
  ACCOUNTS_MAX: 20,

  /** Plugin replies always start with one of these markers → the plugin never processes its own replies. */
  REPLY_MARKERS: Object.freeze(['✅', '❓', '⚠', '🎙', '📝', '↩']),

  /** Data limits (partly FinTrack's: chat ≤ 6000 characters, image as a data URL ≤ 6 000 000 characters). */
  MAX_TEXT_CHARS: 1500,
  MAX_CHAT_TEXT: 6000,
  MAX_AUDIO_BYTES: 5 * 1024 * 1024,
  MAX_VOICE_SECONDS: 180,
  /** Image base64 ≤ 5 990 000 characters (~4.4 MB image) so the whole data URL fits FinTrack's limit. */
  MAX_IMAGE_BASE64: 5_990_000,
  /** Delegating to a Deplao assistant: ≤ 100 messages of ≤ 100 000 characters, answer ≤ 60 000, max_tokens ≤ 8000. */
  AI_MESSAGES_MAX: 100,
  AI_MESSAGE_CHARS: 100_000,
  AI_OUTPUT_CHARS: 60_000,
  AI_MAX_TOKENS: 8000,

  /** Timeouts (ms). Deplao cuts workflow nodes off after 60 s and UI commands after 30 s; keep a safety margin. */
  NODE_BUDGET_MS: 52_000,
  COMMAND_BUDGET_MS: 25_000,
  /** Node: time reserved for the assistant's answer after downloading an image / transcribing a voice message. */
  ASSISTANT_RESERVE_MS: 25_000,
  /** api waits up to ~20 s, then returns pending; results are kept for 5 minutes. */
  API_WAIT_MS: 20_000,
  API_KEEP_MS: 5 * 60_000,
  TIMEOUTS: Object.freeze({
    FINTRACK: 60_000,
    HEALTH: 8000,
    WORKSPACES: 8000,
    INTEGRATION: 20_000,
    LOGIN: 20_000,
    SESSION_CHECK: 10_000,
    SETTINGS: 15_000,
    CHAT: 45_000,
    COMMIT: 20_000,
    /** "ok" / "huỷ" (cancel) in the group: confirm / cancel a whole draft (FinTrack records each entry). */
    DRAFT_ACTION: 30_000,
    TRANSCRIBE: 45_000,
    DEPLAO_AI: 110_000,
    AI_LIST: 8000,
    GET_MESSAGE: 8000,
    DOWNLOAD_MEDIA: 25_000,
    MEDIA_FETCH: 15_000,
    SEND_MESSAGE: 15_000,
    SYSTEM_INFO: 5000,
    CLOUDFLARE: 10_000,
    /** One try of https://<custom domain>/api/integration/health (fails fast while DNS / certificate are not ready). */
    DOMAIN_HEALTH: 10_000,
  }),

  /** Custom domain: wait up to 15 minutes for Cloudflare to create DNS + certificate, retrying every 10 seconds. */
  DOMAIN_WAIT_MS: 15 * 60_000,
  DOMAIN_POLL_MS: 10_000,

  /** Dedupe by Zalo message: kept 7 days, at most 5000 messages. */
  SEEN_TTL_MS: 7 * 24 * 60 * 60_000,
  SEEN_MAX: 5000,
  /**
   * Assistant replies in the group → FinTrack draft, so "ok" / "huỷ" find the right entries: kept 7 days, at most 300
   * replies (each storage key ≤ 1 MB). Without a quote, a command applies to the sender's own latest message within
   * 30 minutes.
   */
  REPLIES_TTL_MS: 7 * 24 * 60 * 60_000,
  REPLIES_MAX: 300,
  COMMAND_WINDOW_MS: 30 * 60_000,
  /** Report errors in a group at most once per 10 minutes per group. */
  ERROR_REPLY_GAP_MS: 10 * 60_000,
  /** Ids of messages the plugin just sent are kept 10 minutes (skipped when they come back through the trigger). */
  SENT_TTL_MS: 10 * 60_000,
  /** Zalo accounts on Deplao (to recognize the app's own replies) are cached for 5 minutes. */
  OWN_ACCOUNTS_TTL_MS: 5 * 60_000,

  /** deplao.storage keys (CONTRACTS §3.3, docs/ARCHITECTURE.md). */
  KEYS: Object.freeze({
    SECRET: 'integration.secret',
    DEPLOY: 'deploy',
    DEPLOY_JOB: 'deploy.job',
    /** Custom domain: { hostname, zoneName, attachedAt, verifiedAt } (verifiedAt = 0: DNS / certificate pending). */
    DOMAIN: 'domain',
    /** Account open in the FinTrack UI: { id (workspace), name, email, linkedAt }. */
    ACTIVE_ACCOUNT: 'workspace',
    /** Sessions per workspace: { [workspaceId]: { token, expiresAt, savedAt } }. */
    SESSIONS: 'sessions',
    /** Remembered accounts: [{ workspaceId, email, name, rememberedAt }]. */
    ACCOUNTS: 'accounts',
    /** true after "Đăng xuất" (Sign out) → no automatic sign-in until the next sign-in / account switch. */
    SIGNED_OUT: 'signedOut',
    /** Assistant per workspace: { [workspaceId]: { source: 'deplao' | 'fintrack', id, savedAt } }. */
    AI_CHOICE: 'ai.choice',
    /** [{ ids: [msg_id, cli_msg_id], threadId, senderId, workspaceId, messageId, pending, at }], newest first. */
    REPLIES: 'replies',
    SEEN: 'seen',
  }),
});
