/**
 * Validates a prebuilt FinTrack bundle (bundle.json, docs/CONTRACTS.md §1.2) before it is copied into
 * vendor/fintrack or packaged: declared files exist, paths are safe, size limits hold.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isSafeRelativePath } from './manifest-check.mjs';

export const BUNDLE_LIMITS = { totalBytes: 50 * 1024 * 1024, assetFiles: 5000, assetBytes: 25 * 1024 * 1024 };
const IGNORED = new Set(['README.md', '.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** List files (relative paths with "/"), report symlinks. */
export function walk(dir, base = dir, out = [], problems = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (entry.isSymbolicLink()) problems.push(`Symlinks are not allowed: ${rel}`);
    else if (entry.isDirectory()) walk(full, base, out, problems);
    else if (entry.isFile()) out.push({ rel, full, size: fs.statSync(full).size });
  }
  return { files: out, problems };
}

const readJson = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
};

/**
 * @returns {{ errors: string[], warnings: string[], summary: object|null }}
 */
export function checkBundle(dir) {
  const errors = [];
  const warnings = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { errors: [`Bundle folder not found: ${dir}`], warnings, summary: null };
  const bundleFile = path.join(dir, 'bundle.json');
  if (!fs.existsSync(bundleFile)) return { errors: ['Missing bundle.json'], warnings, summary: null };
  let b;
  try {
    b = readJson(bundleFile);
  } catch (err) {
    return { errors: [`bundle.json is not valid JSON: ${err.message}`], warnings, summary: null };
  }

  if (typeof b.mainModule !== 'string' || !b.mainModule) errors.push('bundle.json: missing mainModule');
  const modules = Array.isArray(b.modules) ? b.modules : [];
  if (!modules.length) errors.push('bundle.json: modules must be an array with at least one module');
  for (const m of modules) {
    if (!m || !isSafeRelativePath(m.name)) { errors.push(`bundle.json: unsafe module name: ${m && m.name}`); continue; }
    if (m.type !== undefined && !['esm', 'commonjs', 'text', 'data', 'compiled-wasm', 'source-map'].includes(m.type)) warnings.push(`module ${m.name}: unknown type "${m.type}"`);
    if (!fs.existsSync(path.join(dir, 'worker', ...m.name.split('/')))) errors.push(`Missing file worker/${m.name}`);
  }
  if (b.mainModule && !modules.some((m) => m && m.name === b.mainModule)) errors.push(`mainModule "${b.mainModule}" is not listed in modules`);
  if (typeof b.compatibilityDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.compatibilityDate)) errors.push('bundle.json: compatibilityDate must be YYYY-MM-DD');
  if (b.compatibilityFlags !== undefined && (!Array.isArray(b.compatibilityFlags) || b.compatibilityFlags.some((f) => typeof f !== 'string'))) errors.push('bundle.json: compatibilityFlags must be an array of strings');

  let assetDir = null;
  if (b.assets !== undefined) {
    if (!b.assets || typeof b.assets !== 'object' || !isSafeRelativePath(b.assets.dir)) errors.push('bundle.json: unsafe assets.dir');
    else {
      assetDir = path.join(dir, ...b.assets.dir.split('/'));
      if (!fs.existsSync(assetDir)) errors.push(`Missing assets folder "${b.assets.dir}"`);
      if (b.assets.binding !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(String(b.assets.binding))) warnings.push(`Unusual assets.binding: ${b.assets.binding}`);
    }
  }

  // v2: the Deplao build of the FinTrack UI (<bundle>/app/index.html); Deplao doesn't read it, the plugin opens it in an iframe.
  let hasApp = false;
  if (b.app !== undefined && !isSafeRelativePath(b.app)) errors.push('bundle.json: unsafe app');
  else {
    const appRel = b.app === undefined ? 'app' : b.app;
    hasApp = fs.existsSync(path.join(dir, ...appRel.split('/'), 'index.html'));
    if (!hasApp) warnings.push(`Missing the Deplao build of the FinTrack UI (${appRel}/index.html): the app will only show the setup page.`);
  }

  const migrations = b.migrations === undefined ? 'migrations' : b.migrations;
  let migrationFiles = [];
  if (!isSafeRelativePath(migrations)) errors.push('bundle.json: unsafe migrations');
  else {
    const migDir = path.join(dir, ...migrations.split('/'));
    if (!fs.existsSync(migDir)) errors.push(`Missing migrations folder "${migrations}"`);
    else {
      migrationFiles = fs.readdirSync(migDir).filter((f) => f.toLowerCase().endsWith('.sql')).sort();
      if (!migrationFiles.length) errors.push(`Folder "${migrations}" has no .sql files`);
    }
  }

  const { files, problems } = walk(dir);
  errors.push(...problems);
  let total = 0;
  let assets = 0;
  for (const f of files) {
    if (!isSafeRelativePath(f.rel)) errors.push(`Unsafe path: ${f.rel}`);
    if (IGNORED.has(path.basename(f.rel)) && !f.rel.includes('/')) continue;
    total += f.size;
    if (assetDir && f.full.startsWith(assetDir + path.sep)) {
      assets++;
      if (f.size > BUNDLE_LIMITS.assetBytes) errors.push(`Asset over 25 MiB: ${f.rel}`);
    }
  }
  if (total > BUNDLE_LIMITS.totalBytes) errors.push(`Bundle is ${Math.round(total / 1048576)} MB, over 50 MB`);
  if (assets > BUNDLE_LIMITS.assetFiles) errors.push(`Too many assets (${assets} > ${BUNDLE_LIMITS.assetFiles})`);
  if (typeof b.fintrackVersion !== 'string') warnings.push('bundle.json has no fintrackVersion');

  return {
    errors,
    warnings,
    summary: { version: b.fintrackVersion || '', files: files.length, bytes: total, assets, migrations: migrationFiles.length, lastMigration: migrationFiles[migrationFiles.length - 1] || '', hasApp },
  };
}
