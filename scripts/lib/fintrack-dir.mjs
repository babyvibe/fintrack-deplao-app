// Where the FinTrack repo is: FINTRACK_DIR, else ../fintrack (both repos side by side, as on GitHub), else
// ../../fintrack (this repo kept inside a folder of Deplao apps, e.g. deplao-plugin/fintrack-deplao-app next to fintrack/).
import fs from 'node:fs';
import path from 'node:path';

export function fintrackDir(pluginRoot) {
  if (process.env.FINTRACK_DIR) return path.resolve(process.env.FINTRACK_DIR);
  const candidates = [path.join(pluginRoot, '..', 'fintrack'), path.join(pluginRoot, '..', '..', 'fintrack')];
  return path.resolve(candidates.find((dir) => fs.existsSync(path.join(dir, 'package.json'))) ?? candidates[0]);
}
