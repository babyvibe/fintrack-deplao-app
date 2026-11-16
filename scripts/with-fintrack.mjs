#!/usr/bin/env node
/**
 * Run a script that needs the FinTrack SOURCE (TypeScript: API + D1 in Miniflare) with the FinTrack repo's own tsx.
 * For maintainers who have the FinTrack repo; regular contributions only need `npm test`.
 *
 *   npm run e2e                  → node scripts/with-fintrack.mjs scripts/e2e-fintrack.mjs
 *   npm run preview [-- --fresh] → node scripts/with-fintrack.mjs scripts/dev-preview.mjs
 *
 * FinTrack repo: the FINTRACK_DIR environment variable, default ../fintrack (after `npm install`).
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fintrackDir as findFintrack } from './lib/fintrack-dir.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fintrackDir = findFintrack(pluginRoot);
const [script, ...args] = process.argv.slice(2);

if (!script) {
  console.error('Usage: node scripts/with-fintrack.mjs <script.mjs> [args…]');
  process.exit(2);
}

let cli;
try {
  const require = createRequire(path.join(fintrackDir, 'package.json'));
  cli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
} catch {
  console.error(`tsx not found in the FinTrack repo (${fintrackDir}).`);
  console.error('Needs the FinTrack repo after `npm install`, at ../fintrack or pointed to by FINTRACK_DIR (see CONTRIBUTING.md).');
  process.exit(2);
}

const res = spawnSync(process.execPath, [cli, path.resolve(pluginRoot, script), ...args], {
  stdio: 'inherit',
  env: { ...process.env, FINTRACK_DIR: fintrackDir },
});
process.exit(res.status === null ? 1 : res.status);
