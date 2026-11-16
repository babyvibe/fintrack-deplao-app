/**
 * Validates deplao-plugin.json without the Deplao repo: repeats the rules of
 * src/services/plugins/manifest.ts that apply to this app + the terms of docs/CONTRACTS.md §3.
 * To run Deplao's own validator instead: set DEPLAO_REPO (see scripts/pack.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Deplao API v1 scopes (src/services/api/types.ts, API_SCOPES). */
export const API_SCOPES = [
  'accounts:read', 'accounts:manage', 'chat:read', 'chat:send', 'chat:manage', 'contacts:read', 'contacts:write',
  'crm:read', 'crm:write', 'campaigns:run', 'workflow:read', 'workflow:write', 'workflow:run', 'integrations:read',
  'integrations:execute', 'integrations:manage', 'erp:read', 'erp:write', 'ai:use', 'ai:manage', 'media:read',
  'media:write', 'analytics:read', 'events:subscribe', 'webhooks:manage', 'employees:manage', 'settings:read',
  'settings:write', 'plugins:manage', 'admin',
];

/** Plugin-only permissions (manifest.ts, PLUGIN_PERMISSIONS) + cloudflare:workers (CONTRACTS §1.1). */
export const PLUGIN_PERMISSIONS = ['storage', 'ui:pages', 'ui:chat-panel', 'ui:composer', 'ui:microphone', 'workflow:nodes', 'events:emit', 'network', 'schedules', 'cloudflare:workers'];

export const FORBIDDEN_SCOPES = ['admin', 'plugins:manage', 'employees:manage', 'settings:write'];

/** Exactly the permission list in CONTRACTS §3. */
export const CONTRACT_PERMISSIONS = [
  'storage', 'ui:pages', 'ui:microphone', 'workflow:nodes', 'network', 'cloudflare:workers', 'accounts:read', 'chat:read', 'chat:send',
  'media:read', 'ai:use',
];
export const CONTRACT_ID = 'io.github.babyvibe.fintrack';
export const CONTRACT_NODE = 'fintrack.record';
export const CONTRACT_OUTPUTS = ['recorded', 'drafts', 'items', 'text', 'reply', 'skipped'];
export const CONTRACT_TRANSCRIBE_NODE = 'fintrack.transcribe';
export const CONTRACT_TRANSCRIBE_OUTPUTS = ['text', 'durationSec', 'skipped'];

const RESERVED_SHORT_NAMES = [
  'trigger', 'action', 'logic', 'output', 'data', 'ai', 'notify', 'sheets', 'payment', 'integration', 'crm', 'erp',
  'zalo', 'fb', 'facebook', 'tg', 'tgbot', 'telegram', 'workflow', 'api', 'plugin', 'plugins', 'system', 'deplao',
  'ghn', 'ghtk', 'sapo', 'pancake', 'nhanh', 'kiotviet', 'haravan', 'casso', 'sepay', 'viettelpost', 'jt',
];

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const CONTRIB_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NODE_SUFFIX_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/;
const FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,60}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function isSafeRelativePath(p) {
  if (typeof p !== 'string' || !p || p.length > 200) return false;
  if (p.includes('\\') || p.includes('\0') || p.includes(':')) return false;
  if (p.startsWith('/')) return false;
  return p.split('/').every((seg) => seg !== '..');
}

function isHttps(v) {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

function checkFields(errors, where, schema, allowWidgets) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return errors.push(`${where}: must be a JSON Schema object`);
  if (schema.type !== undefined && schema.type !== 'object') errors.push(`${where}.type: only "object" is supported`);
  const props = schema.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return errors.push(`${where}.properties: missing`);
  const keys = Object.keys(props);
  if (keys.length > 50) errors.push(`${where}.properties: at most 50 fields`);
  const types = allowWidgets ? ['string', 'number', 'integer', 'boolean', 'array'] : ['string', 'number', 'integer', 'boolean'];
  for (const key of keys) {
    const f = props[key];
    const fw = `${where}.properties.${key}`;
    if (!FIELD_KEY_RE.test(key)) errors.push(`${fw}: field names may only contain letters, digits, _`);
    if (!f || typeof f !== 'object') { errors.push(`${fw}: must be an object`); continue; }
    if (!types.includes(f.type)) errors.push(`${fw}.type: must be ${types.join(' | ')}`);
    if (f.type === 'array' && f.items?.type !== 'string') errors.push(`${fw}.items: only arrays of strings are supported`);
    if (f.enum !== undefined && (!Array.isArray(f.enum) || !f.enum.length || f.enum.length > 100)) errors.push(`${fw}.enum: an array of 1–100 values`);
    if (f.title !== undefined && !str(f.title, 100)) errors.push(`${fw}.title: at most 100 characters`);
    // Like Deplao's CONFIG_WIDGETS (assistant = pick a Deplao AI assistant; needs a Deplao version with that picker).
    if (f['x-widget'] !== undefined && (!allowWidgets || !['account', 'thread', 'label', 'assistant'].includes(f['x-widget']))) errors.push(`${fw}.x-widget: only account | thread | label | assistant (workflow nodes)`);
    if (f['x-widget'] === 'assistant' && f.type !== 'string') errors.push(`${fw}.x-widget: assistant is only for string fields`);
    if (f.default !== undefined) {
      const ok = f.type === 'boolean' ? typeof f.default === 'boolean'
        : f.type === 'number' || f.type === 'integer' ? typeof f.default === 'number'
          : f.type === 'array' ? Array.isArray(f.default) : typeof f.default === 'string';
      if (!ok) errors.push(`${fw}.default: does not match type`);
    }
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((k) => !keys.includes(k)))) {
    errors.push(`${where}.required: must list field names that exist in properties`);
  }
  return undefined;
}

/**
 * @param {object} raw  parsed manifest
 * @param {{ dir?: string, contract?: boolean }} opts  dir: check that files exist; contract: compare with CONTRACTS §3
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkManifest(raw, { dir, contract = true } = {}) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['deplao-plugin.json must be a JSON object'], warnings };

  const short = typeof raw.id === 'string' ? raw.id.split('.').pop() : '';
  if (!str(raw.id, 100) || !PLUGIN_ID_RE.test(raw.id)) errors.push('id: must be lowercase reverse-DNS');
  else if (RESERVED_SHORT_NAMES.includes(short)) errors.push(`id: the last part "${short}" clashes with a built-in Deplao prefix`);
  if (!str(raw.name, 80)) errors.push('name: required, at most 80 characters');
  if (!str(raw.version, 50) || !SEMVER_RE.test(raw.version)) errors.push('version: must be semver');
  if (raw.apiVersion !== 1) errors.push('apiVersion: must be 1');
  if (raw.minDeplaoVersion !== undefined && !SEMVER_RE.test(String(raw.minDeplaoVersion))) errors.push('minDeplaoVersion: must be semver');
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 500)) errors.push('description: at most 500 characters');
  if (raw.author !== undefined && (typeof raw.author !== 'string' || raw.author.length > 100)) errors.push('author: at most 100 characters');
  if (raw.homepage !== undefined && !isHttps(raw.homepage)) errors.push('homepage: must be an https URL');
  if (raw.icon !== undefined && !isSafeRelativePath(raw.icon)) errors.push('icon: must be a relative path inside the plugin');
  if (raw.runtime !== 'local') errors.push('runtime: this app uses "local"');
  if (!raw.backend || !isSafeRelativePath(raw.backend.entry) || !/\.(c|m)?js$/.test(raw.backend.entry)) errors.push('backend.entry: required, a relative .js file');
  if (raw.ui !== undefined && (!isSafeRelativePath(raw.ui?.entry) || !/\.html?$/.test(raw.ui.entry))) errors.push('ui.entry: must be a relative .html file');
  if (raw.ui && raw.ui.imgSrc !== undefined) {
    // Like Deplao's isImageSource: https://domain or https://*.domain, no path / port.
    const ok = Array.isArray(raw.ui.imgSrc) && raw.ui.imgSrc.length <= 10
      && raw.ui.imgSrc.every((o) => typeof o === 'string' && /^https:\/\/(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(o));
    if (!ok) errors.push('ui.imgSrc: at most 10 sources, each https://domain or https://*.domain');
    else if (!(Array.isArray(raw.permissions) && raw.permissions.includes('network'))) errors.push('ui.imgSrc: requires the "network" permission');
  }

  const perms = [];
  if (!Array.isArray(raw.permissions)) errors.push('permissions: must be an array');
  else {
    for (const p of raw.permissions) {
      const v = String(p);
      if (FORBIDDEN_SCOPES.includes(v)) errors.push(`permissions: "${v}" may not be requested`);
      else if (!API_SCOPES.includes(v) && !PLUGIN_PERMISSIONS.includes(v)) errors.push(`permissions: unknown permission "${v}"`);
      else if (perms.includes(v)) errors.push(`permissions: duplicate "${v}"`);
      else perms.push(v);
    }
  }
  const has = (p) => perms.includes(p);

  const c = raw.contributes || {};
  const pages = Array.isArray(c.pages) ? c.pages : [];
  if (pages.length && !has('ui:pages')) errors.push('contributes.pages: requires the "ui:pages" permission');
  if (pages.length && !raw.ui) errors.push('contributes.pages: requires ui.entry');
  pages.forEach((p, i) => {
    if (!CONTRIB_ID_RE.test(String(p?.id || ''))) errors.push(`contributes.pages[${i}].id: lowercase letters, digits, "-"`);
    if (!str(p?.title, 40)) errors.push(`contributes.pages[${i}].title: required, ≤ 40 characters`);
    if (typeof p?.path !== 'string' || p.path.length > 200) errors.push(`contributes.pages[${i}].path: hash route`);
  });
  if (c.settings !== undefined) checkFields(errors, 'contributes.settings.schema', c.settings?.schema, false);

  const nodes = Array.isArray(c.workflowNodes) ? c.workflowNodes : [];
  if (nodes.length && !has('workflow:nodes')) errors.push('contributes.workflowNodes: requires the "workflow:nodes" permission');
  const typeSeen = new Set();
  nodes.forEach((n, i) => {
    const t = n?.type;
    if (typeof t !== 'string' || !t.startsWith(`${short}.`) || t.includes('.trigger.') || !NODE_SUFFIX_RE.test(t.slice(short.length + 1))) {
      errors.push(`contributes.workflowNodes[${i}].type: must start with "${short}." and must not contain ".trigger."`);
    }
    if (typeSeen.has(t)) errors.push(`contributes.workflowNodes: duplicate "${t}"`);
    typeSeen.add(t);
    if (!str(n?.label, 60)) errors.push(`contributes.workflowNodes[${i}].label: required, ≤ 60 characters`);
    if (n?.configSchema !== undefined) checkFields(errors, `contributes.workflowNodes[${i}].configSchema`, n.configSchema, true);
    if (n?.outputs !== undefined) {
      if (!Array.isArray(n.outputs) || n.outputs.length > 50) errors.push(`contributes.workflowNodes[${i}].outputs: an array of ≤ 50`);
      else n.outputs.forEach((o, j) => { if (!FIELD_KEY_RE.test(String(o?.name || ''))) errors.push(`contributes.workflowNodes[${i}].outputs[${j}].name: letters, digits, _`); });
    }
  });

  if (contract) {
    if (raw.id !== CONTRACT_ID) errors.push(`contract: id must be ${CONTRACT_ID}`);
    const want = [...CONTRACT_PERMISSIONS].sort().join(',');
    const got = [...perms].sort().join(',');
    if (want !== got) errors.push(`contract: permissions must match CONTRACTS §3 exactly (${CONTRACT_PERMISSIONS.join(', ')})`);
    const node = nodes.find((n) => n?.type === CONTRACT_NODE);
    if (!node) errors.push(`contract: missing node ${CONTRACT_NODE}`);
    else {
      const outs = (node.outputs || []).map((o) => o.name);
      for (const o of CONTRACT_OUTPUTS) if (!outs.includes(o)) errors.push(`contract: node ${CONTRACT_NODE} is missing output "${o}"`);
      if (node.configSchema?.properties?.account?.['x-widget'] !== 'account') errors.push('contract: configSchema.account must have x-widget "account"');
      if (node.configSchema?.properties?.replyInGroup?.default !== true) errors.push('contract: replyInGroup must default to true');
      if (node.configSchema?.properties?.images?.type !== 'boolean') errors.push('contract: configSchema.images (accept photo messages) must be a boolean');
      if (node.configSchema?.properties?.assistantId?.['x-widget'] !== 'assistant') errors.push('contract: configSchema.assistantId must have x-widget "assistant" (assistant picker)');
      const mode = node.configSchema?.properties?.mode;
      if (!mode || JSON.stringify(mode.enum) !== JSON.stringify(['draft', 'auto']) || mode.default !== 'draft') errors.push('contract: mode must be enum draft | auto, default draft');
    }
    const tnode = nodes.find((n) => n?.type === CONTRACT_TRANSCRIBE_NODE);
    if (!tnode) errors.push(`contract: missing node ${CONTRACT_TRANSCRIBE_NODE}`);
    else {
      const outs = (tnode.outputs || []).map((o) => o.name);
      for (const o of CONTRACT_TRANSCRIBE_OUTPUTS) if (!outs.includes(o)) errors.push(`contract: node ${CONTRACT_TRANSCRIBE_NODE} is missing output "${o}"`);
    }
    if (!pages.some((p) => p.title === 'FinTrack')) errors.push('contract: requires a "FinTrack" page');
  }

  if (dir && !errors.length) {
    const files = [['backend.entry', raw.backend?.entry], ['ui.entry', raw.ui?.entry], ['icon', raw.icon]];
    for (const [where, rel] of files) {
      if (!rel) continue;
      const full = path.resolve(dir, ...rel.split('/'));
      if (!full.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) errors.push(`${where}: "${rel}" not found`);
    }
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.version !== raw.version) errors.push(`version: package.json (${pkg.version}) differs from the manifest (${raw.version})`);
      if (pkg.type === 'module') errors.push('package.json: must not set "type": "module" (the backend is CommonJS)');
    } catch {
      warnings.push('Could not read package.json to compare versions');
    }
    try {
      const constants = fs.readFileSync(path.join(dir, 'backend', 'lib', 'constants.js'), 'utf8');
      const m = /PLUGIN_VERSION\s*=\s*'([^']+)'/.exec(constants);
      if (!m) warnings.push('PLUGIN_VERSION not found in backend/lib/constants.js');
      else if (m[1] !== raw.version) errors.push(`version: backend/lib/constants.js (${m[1]}) differs from the manifest (${raw.version})`);
      const idm = /PLUGIN_ID\s*=\s*'([^']+)'/.exec(constants);
      if (idm && idm[1] !== raw.id) errors.push(`id: backend/lib/constants.js (${idm[1]}) differs from the manifest (${raw.id})`);
    } catch {
      warnings.push('Could not read backend/lib/constants.js');
    }
  }
  return { errors, warnings };
}

export function readManifestFile(dir) {
  const file = path.join(dir, 'deplao-plugin.json');
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}
