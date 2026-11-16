#!/usr/bin/env node
/**
 * npm run vendor: copy the prebuilt FinTrack bundle into vendor/fintrack/.
 *
 * Source (in order): --from <folder> → the FINTRACK_BUNDLE_DIR variable → ../fintrack/artifacts/deplao-bundle
 * (the FinTrack repo next to this one, built with `npm run bundle:deplao` in FinTrack).
 * The bundle is checked against docs/CONTRACTS.md §1.2 before copying; vendor/fintrack/README.md is kept.
 * Copies into a temporary folder and only then swaps it in, so a failure halfway never breaks the current copy.
 * Writes vendor/fintrack.vendor.json (version, file count, sha256) to record which build gets packaged.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkBundle, walk } from './lib/bundle-check.mjs';
import { fintrackDir } from './lib/fintrack-dir.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'vendor', 'fintrack');
const KEEP = new Set(['README.md']);

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const source = path.resolve(argValue('--from') || process.env.FINTRACK_BUNDLE_DIR || path.join(fintrackDir(root), 'artifacts', 'deplao-bundle'));
console.log(`Source: ${source}`);
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
if (inside(source, target) || inside(target, source)) {
  console.error(`✗ The source and vendor/fintrack are nested (${source}): copying would delete the source itself. Choose another bundle folder.`);
  process.exit(1);
}
const check = checkBundle(source);
for (const w of check.warnings) console.warn(`! ${w}`);
if (check.errors.length) {
  console.error('✗ Invalid FinTrack bundle:');
  for (const e of check.errors) console.error(`  - ${e}`);
  console.error('\nBuild the bundle in the FinTrack repo (npm run bundle:deplao) or point to it with --from / FINTRACK_BUNDLE_DIR.');
  process.exit(1);
}

const staging = path.join(root, 'vendor', `.fintrack-new-${process.pid}`);
const previous = path.join(root, 'vendor', `.fintrack-old-${process.pid}`);
const { files } = walk(source);
const hash = crypto.createHash('sha256');
let bytes = 0;
try {
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const f of files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    if (KEEP.has(f.rel)) continue; // don't overwrite this repo's README
    const dest = path.join(staging, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const data = fs.readFileSync(f.full);
    fs.writeFileSync(dest, data);
    hash.update(f.rel).update('\0').update(data);
    bytes += data.length;
  }
  for (const keep of KEEP) {
    const old = path.join(target, keep);
    if (fs.existsSync(old)) fs.copyFileSync(old, path.join(staging, keep));
  }
  // Swap: move the old copy aside, move the new one in; if that fails, put the old copy back.
  if (fs.existsSync(target)) fs.renameSync(target, previous);
  try {
    fs.renameSync(staging, target);
  } catch (err) {
    if (fs.existsSync(previous)) fs.renameSync(previous, target);
    throw err;
  }
  fs.rmSync(previous, { recursive: true, force: true });
} catch (err) {
  fs.rmSync(staging, { recursive: true, force: true });
  console.error(`✗ Could not copy the FinTrack bundle: ${err.message}`);
  process.exit(1);
}

const info = {
  fintrackVersion: check.summary.version,
  files: files.length,
  bytes,
  migrations: check.summary.migrations,
  lastMigration: check.summary.lastMigration,
  sha256: hash.digest('hex'),
  // Only a repo-relative path (never this machine's own folders).
  source: (() => {
    const rel = path.relative(root, source).split(path.sep).join('/');
    return path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) ? '(outside the repo)' : rel || '.';
  })(),
  vendoredAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(root, 'vendor', 'fintrack.vendor.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`✓ FinTrack ${info.fintrackVersion || '(unknown version)'} → vendor/fintrack: ${info.files} files, ${(bytes / 1048576).toFixed(2)} MB, ${info.migrations} migrations (latest ${info.lastMigration})`);
