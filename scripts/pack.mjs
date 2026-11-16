#!/usr/bin/env node
/**
 * npm run pack: validate, then package the app as dist/fintrack-<version>.zip for installing in Deplao
 * (Công cụ → Ứng dụng, API & Webhook → Cài ứng dụng).
 *
 *   node scripts/pack.mjs [--out <file.zip>] [--no-bundle] [--deplao <Deplao repo>]
 *
 *  --no-bundle   allow a missing vendor/fintrack (a test package that CANNOT deploy FinTrack)
 *  --deplao      (or DEPLAO_REPO) also run Deplao's official manifest validator:
 *                node <repo>/packages/plugin-cli/bin/deplao-plugin.js validate <this folder>
 * Packages only the files needed at runtime: manifest, icon, backend/, ui/, vendor/fintrack/, legal documents.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkManifest, readManifestFile } from './lib/manifest-check.mjs';
import { checkBundle, walk } from './lib/bundle-check.mjs';
import { createZip, readZip } from './lib/zip.mjs';
import { packageReadme } from './lib/readme.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const USAGE = 'Usage: node scripts/pack.mjs [--out <file.zip>] [--no-bundle] [--deplao <Deplao repo>]';
if (flag('--help') || flag('-h')) {
  console.log(USAGE);
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' || args[i] === '--deplao') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) {
      console.error(`✗ ${args[i]} needs a value.\n${USAGE}`);
      process.exit(1);
    }
    i++;
  } else if (args[i] !== '--no-bundle') {
    console.error(`✗ Unknown argument "${args[i]}".\n${USAGE}`);
    process.exit(1);
  }
}

const INCLUDE = ['deplao-plugin.json', 'icon.svg', 'README.md', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md', 'backend', 'ui', 'vendor/fintrack', 'vendor/fintrack.vendor.json'];
const OPTIONAL = new Set(['vendor/fintrack', 'vendor/fintrack.vendor.json']);
const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.git', 'node_modules']);

function fail(msg, details = []) {
  console.error(`✗ ${msg}`);
  for (const d of details) console.error(`  - ${d}`);
  process.exit(1);
}

// 1) Manifest
let manifest;
try {
  manifest = readManifestFile(root);
} catch (err) {
  fail(`deplao-plugin.json: ${err.message}`);
}
const mc = checkManifest(manifest, { dir: root, contract: true });
for (const w of mc.warnings) console.warn(`! ${w}`);
if (mc.errors.length) fail('Invalid manifest:', mc.errors);
console.log(`✓ Manifest ${manifest.id} ${manifest.version}`);

// 2) Deplao's official validator (optional)
const deplaoRepo = value('--deplao') || process.env.DEPLAO_REPO;
if (deplaoRepo) {
  const cli = path.join(path.resolve(deplaoRepo), 'packages', 'plugin-cli', 'bin', 'deplao-plugin.js');
  if (!fs.existsSync(cli)) fail(`Not found: ${cli}`);
  const r = spawnSync(process.execPath, [cli, 'validate', root], { stdio: 'inherit', cwd: path.resolve(deplaoRepo) });
  if (r.status !== 0) fail('The Deplao manifest validator reported errors (does that Deplao version support the cloudflare:workers permission?)');
}

// 3) FinTrack bundle
const bundleDir = path.join(root, 'vendor', 'fintrack');
const hasBundle = fs.existsSync(path.join(bundleDir, 'bundle.json'));
if (hasBundle) {
  const bc = checkBundle(bundleDir);
  for (const w of bc.warnings) console.warn(`! ${w}`);
  if (bc.errors.length) fail('Invalid vendor/fintrack:', bc.errors);
  // Release package: must open FinTrack in Deplao (app/) and ship FinTrack's license (MIT requires it when redistributing).
  const missing = [];
  if (!bc.summary.hasApp) missing.push('app/index.html (the Deplao build of the FinTrack UI)');
  if (!fs.existsSync(path.join(bundleDir, 'LICENSE'))) missing.push('the FinTrack LICENSE');
  if (missing.length && !flag('--no-bundle')) fail('vendor/fintrack is missing files required for a release (rebuild the bundle with `npm run bundle:deplao` in FinTrack, then `npm run vendor`):', missing);
  for (const m of missing) console.warn(`! Missing ${m} (--no-bundle: packaging a test build anyway)`);
  console.log(`✓ FinTrack ${bc.summary.version || '?'}: ${bc.summary.files} files, ${(bc.summary.bytes / 1048576).toFixed(2)} MB, ${bc.summary.migrations} migrations`);
} else if (flag('--no-bundle')) {
  console.warn('! Packaging WITHOUT FinTrack (--no-bundle): the app will not be able to deploy the Worker.');
} else {
  fail('Missing vendor/fintrack/bundle.json. Run `npm run vendor` first (or use --no-bundle for a test package).');
}

// 4) Collect files
const files = [];
for (const item of INCLUDE) {
  const full = path.join(root, ...item.split('/'));
  if (!fs.existsSync(full)) {
    if (OPTIONAL.has(item)) continue;
    fail(`Missing ${item}`);
  }
  if (fs.statSync(full).isDirectory()) {
    const { files: list, problems } = walk(full, root);
    if (problems.length) fail('Cannot package:', problems);
    for (const f of list) {
      if (f.rel.split('/').some((seg) => JUNK.has(seg))) continue;
      files.push({ name: f.rel, data: fs.readFileSync(f.full) });
    }
  } else if (item === 'README.md') {
    // Deplao shows the package README as plain text in its (Vietnamese) install dialog: README.md is the Vietnamese
    // landing page (README.en.md is the English one), so strip the GitHub-only blocks before shipping it.
    files.push({ name: item, data: Buffer.from(packageReadme(fs.readFileSync(full, 'utf8'))) });
  } else if (item === 'vendor/fintrack.vendor.json') {
    // The package keeps only the version + sha256 (no path / time from the packaging machine), so builds are reproducible.
    const info = JSON.parse(fs.readFileSync(full, 'utf8'));
    const keep = Object.fromEntries(['fintrackVersion', 'files', 'bytes', 'migrations', 'lastMigration', 'sha256'].filter((k) => k in info).map((k) => [k, info[k]]));
    files.push({ name: item, data: Buffer.from(`${JSON.stringify(keep, null, 2)}\n`) });
  } else {
    files.push({ name: item, data: fs.readFileSync(full) });
  }
}
files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

// 5) Zip + read it back as a self-check
let zip;
try {
  zip = createZip(files);
  const back = readZip(zip);
  if (back.length !== files.length) throw new Error('File count read back does not match');
} catch (err) {
  fail(`Could not create the zip: ${err.message}`);
}
const out = path.resolve(value('--out') || path.join(root, 'dist', `fintrack-${manifest.version}.zip`));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, zip);
const sha = crypto.createHash('sha256').update(zip).digest('hex');
console.log(`✓ ${files.length} files, ${(zip.length / 1048576).toFixed(2)} MB → ${path.relative(process.cwd(), out) || out}`);
console.log(`  sha256 ${sha}`);
