'use strict';
/**
 * FinTrack: backend of the Deplao app (runtime "local", a separate process managed by Deplao).
 *
 *  - commands.api / apiResult: proxy from the FinTrack UI (vendor/fintrack/app) to the user's FinTrack Worker.
 *  - Other commands: status, deploy and custom domain for the entry page and the Options page ("Tuỳ chọn"); FinTrack
 *    accounts (sign in, create, quick switch, sign out) and the AI assistant choice (lib/commands, lib/accounts).
 *  - nodes['fintrack.record']: Zalo group message (text / voice / image) → FinTrack AI assistant → a draft (kept by
 *    FinTrack in its "Chờ xác nhận" (awaiting confirmation) inbox) or, in auto mode, a recorded entry, in the FinTrack
 *    account currently open in Deplao. "ok" / "huỷ" (cancel) replies in the group are relayed to FinTrack (lib/record).
 *  - nodes['fintrack.transcribe']: voice message → text.
 * Every call into Deplao goes through ctx.deplao (API v1 + deplao.cloudflare), within the approved permissions.
 *
 * @typedef {import('@deplao/plugin-sdk').PluginBackend} PluginBackend
 */

const { NODE_TYPE, TRANSCRIBE_NODE_TYPE, PLUGIN_VERSION } = require('./lib/constants');
const { recordMessage, transcribeMessage } = require('./lib/record');
const proxy = require('./lib/proxy');
const commands = require('./lib/commands');

/** Keeps an unexpected error from breaking the workflow: logs it and returns the fallback with a skip reason. */
function guard(fn, fallback) {
  return async (cfg, run, ctx) => {
    try {
      return await fn(cfg || {}, run || {}, ctx);
    } catch (err) {
      console.error(`[fintrack] Lỗi không mong đợi: ${err && err.message}`);
      return { ...fallback, skipped: 'internal_error' };
    }
  };
}

/** @type {PluginBackend} */
module.exports = {
  async activate() {
    console.log(`FinTrack ${PLUGIN_VERSION} sẵn sàng`);
  },

  async onSettingsChanged() {
    // The URL / secret may have changed → re-read the assistant, mint a new session when needed.
    proxy.resetCaches();
  },

  nodes: {
    [NODE_TYPE]: guard(recordMessage, { recorded: 0, drafts: 0, items: [], text: '', reply: '' }),
    [TRANSCRIBE_NODE_TYPE]: guard(transcribeMessage, { text: '', durationSec: 0 }),
  },

  commands,
};
