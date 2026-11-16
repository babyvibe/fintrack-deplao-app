#!/usr/bin/env node
/**
 * npm run validate: check deplao-plugin.json (+ that every .json file in the repo is valid JSON).
 * Used in CI. Does not need the Deplao repo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkManifest, readManifestFile } from './lib/manifest-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.idea', '.vscode', '.wrangler', '.mf']);
let failed = false;

function jsonFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    // The vendored FinTrack bundle can be large: only check its bundle.json.
    if (e.isDirectory() && path.relative(root, full).split(path.sep).join('/') === 'vendor/fintrack') {
      const b = path.join(full, 'bundle.json');
      if (fs.existsSync(b)) out.push(b);
      continue;
    }
    if (e.isDirectory()) jsonFiles(full, out);
    else if (e.isFile() && e.name.endsWith('.json')) out.push(full);
  }
  return out;
}

for (const file of jsonFiles(root)) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    failed = true;
    console.error(`✗ ${path.relative(root, file)}: invalid JSON: ${err.message}`);
  }
}

let manifest;
try {
  manifest = readManifestFile(root);
} catch (err) {
  console.error(`✗ deplao-plugin.json: ${err.message}`);
  process.exit(1);
}
const { errors, warnings } = checkManifest(manifest, { dir: root, contract: true });
for (const w of warnings) console.warn(`! ${w}`);
if (errors.length) {
  failed = true;
  console.error('✗ deplao-plugin.json is invalid:');
  for (const e of errors) console.error(`  - ${e}`);
} else {
  console.log(`✓ ${manifest.name} ${manifest.version} (${manifest.id}): ${manifest.permissions.length} permissions, nodes ${manifest.contributes.workflowNodes.map((n) => n.type).join(', ')}`);
}
process.exitCode = failed ? 1 : 0;
