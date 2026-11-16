'use strict';
/**
 * deplao.cloudflare (CONTRACTS §1.1) + reading the bundled FinTrack package (vendor/fintrack/bundle.json, §1.2).
 * The Cloudflare token never reaches the plugin: every call goes through Deplao (main process).
 */

const fs = require('fs');
const path = require('path');
const { BUNDLE_DIR } = require('./constants');
const { isPlainObject, safeJsonParse } = require('./util');

/**
 * deplao.cloudflare if the running Deplao version supports it, otherwise null.
 * (The backend SDK returns a Proxy for unknown groups: deplao.cloudflare.d1 is then a function, not an object with
 * ensure.)
 */
function getCloudflare(deplao) {
  const cf = deplao && deplao.cloudflare;
  if (!cf) return null;
  const d1 = cf.d1;
  const workers = cf.workers;
  if (!d1 || typeof d1.ensure !== 'function' || typeof d1.migrate !== 'function') return null;
  if (!workers || typeof workers.get !== 'function' || typeof workers.deployBundle !== 'function') return null;
  if (typeof cf.status !== 'function') return null;
  return cf;
}

/** Installed plugin directory (Deplao passes DEPLAO_PLUGIN_DIR to the plugin process). */
function pluginDir() {
  return process.env.DEPLAO_PLUGIN_DIR || path.resolve(__dirname, '..', '..');
}

/** Safe relative path (same rules as Deplao). */
function isSafeRelative(p) {
  return typeof p === 'string' && !!p && p.length <= 200 && !p.includes('\\') && !p.includes('\0') && !p.includes(':') && !p.startsWith('/') && p.split('/').every((s) => s !== '..');
}

/**
 * Build id of the bundled FinTrack package: the first 16 characters of the sha256 that `npm run vendor` writes to
 * vendor/fintrack.vendor.json ('' if missing). Tells whether the Worker on Cloudflare runs an older bundle even when
 * the version (e.g. 0.1.0) is the same.
 */
function readBundleBuild(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, ...`${BUNDLE_DIR}.vendor.json`.split('/')), 'utf8');
    const info = safeJsonParse(raw.replace(/^\uFEFF/, ''));
    return isPlainObject(info) && typeof info.sha256 === 'string' && /^[0-9a-f]{16,64}$/.test(info.sha256) ? info.sha256.slice(0, 16) : '';
  } catch {
    return '';
  }
}

/**
 * Bundled FinTrack package info: present or not, version, build id, migrations directory (relative to the plugin
 * directory), app/ UI.
 */
function readBundleInfo(dir = pluginDir()) {
  const file = path.join(dir, ...BUNDLE_DIR.split('/'), 'bundle.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { present: false, reason: 'missing' };
  }
  const json = safeJsonParse(raw.replace(/^\uFEFF/, ''));
  if (!isPlainObject(json) || typeof json.mainModule !== 'string') return { present: false, reason: 'invalid' };
  const migrations = isSafeRelative(json.migrations) ? json.migrations : 'migrations';
  const migDir = path.join(dir, ...BUNDLE_DIR.split('/'), ...migrations.split('/'));
  let migrationCount = 0;
  try {
    migrationCount = fs.readdirSync(migDir).filter((f) => f.toLowerCase().endsWith('.sql')).length;
  } catch {
    migrationCount = 0;
  }
  // Deplao edition of the FinTrack UI (CONTRACTS §1.2 "app", §3.1): <bundle>/app/index.html.
  const appRel = isSafeRelative(json.app) ? json.app : 'app';
  const hasApp = fs.existsSync(path.join(dir, ...BUNDLE_DIR.split('/'), ...appRel.split('/'), 'index.html'));
  return {
    present: true,
    version: typeof json.fintrackVersion === 'string' ? json.fintrackVersion : '',
    build: readBundleBuild(dir),
    compatibilityDate: typeof json.compatibilityDate === 'string' ? json.compatibilityDate : '',
    migrationsDir: `${BUNDLE_DIR}/${migrations}`,
    migrationCount,
    hasAssets: isPlainObject(json.assets),
    hasApp,
    appPath: hasApp ? `${BUNDLE_DIR}/${appRel}/index.html` : '',
  };
}

module.exports = { getCloudflare, readBundleInfo, pluginDir };
