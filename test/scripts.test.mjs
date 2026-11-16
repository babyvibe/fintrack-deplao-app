import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { checkManifest, readManifestFile, CONTRACT_PERMISSIONS } from '../scripts/lib/manifest-check.mjs';
import { createZip, readZip, assertSafeName } from '../scripts/lib/zip.mjs';
import { checkBundle } from '../scripts/lib/bundle-check.mjs';
import { packageReadme } from '../scripts/lib/readme.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = readManifestFile(root);
const clone = (v) => JSON.parse(JSON.stringify(v));

test('deplao-plugin.json is valid and matches the contract (permissions, nodes, outputs, pages)', () => {
  const { errors } = checkManifest(manifest, { dir: root, contract: true });
  assert.deepEqual(errors, []);
  assert.deepEqual([...manifest.permissions].sort(), [...CONTRACT_PERMISSIONS].sort());
  const node = manifest.contributes.workflowNodes[0];
  assert.equal(node.type, 'fintrack.record');
  assert.deepEqual(node.outputs.map((o) => o.name), ['recorded', 'drafts', 'items', 'text', 'reply', 'skipped']);
  assert.deepEqual(node.configSchema.properties.mode.enum, ['draft', 'auto']);
  const t = manifest.contributes.workflowNodes[1];
  assert.equal(t.type, 'fintrack.transcribe');
  assert.deepEqual(t.outputs.map((o) => o.name), ['text', 'durationSec', 'skipped']);
  assert.equal(node.configSchema.properties.account['x-widget'], 'account');
  assert.match(manifest.minDeplaoVersion, /^\d+\.\d+\.\d+$/);
});

test('versions match: package.json, manifest, backend, CHANGELOG; README states the right minimum Deplao version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const C = createRequire(import.meta.url)('../backend/lib/constants.js');
  assert.equal(pkg.version, manifest.version);
  assert.equal(C.PLUGIN_VERSION, manifest.version);
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, new RegExp(`^## \\[${manifest.version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'), 'CHANGELOG has an entry for this version');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes(`Deplao ≥ ${manifest.minDeplaoVersion}`), 'README states the right minimum Deplao version');
});

test('manifest-check catches common mistakes', () => {
  const bad = clone(manifest);
  bad.permissions = [...bad.permissions, 'admin', 'storage', 'khong-co'];
  bad.contributes.workflowNodes[0].type = 'khac.record';
  bad.contributes.workflowNodes[0].configSchema.properties.account['x-widget'] = 'map';
  bad.contributes.settings.schema.properties.x = { type: 'array' };
  const text = checkManifest(bad, { contract: true }).errors.join('\n');
  assert.match(text, /"admin" may not be requested/);
  assert.match(text, /duplicate "storage"/);
  assert.match(text, /unknown permission "khong-co"/);
  assert.match(text, /must start with "fintrack\."/);
  assert.match(text, /x-widget/);
  assert.match(text, /settings\.schema\.properties\.x\.type/);
  assert.match(text, /missing node fintrack\.record/);

  const noOutput = clone(manifest);
  noOutput.contributes.workflowNodes[0].outputs = [{ name: 'recorded' }];
  noOutput.permissions = noOutput.permissions.filter((p) => p !== 'media:read');
  const text2 = checkManifest(noOutput, { contract: true }).errors.join('\n');
  assert.match(text2, /missing output "reply"/);
  assert.match(text2, /permissions must match CONTRACTS/);

  // The Options page shows no external images: ui.imgSrc is not declared; if it is, its format is still validated.
  assert.equal(manifest.ui.imgSrc, undefined);
  for (const imgSrc of [['http://*.zadn.vn'], ['https://*.zadn.vn/path'], ['*'], ['https://*'], 'https://*.zadn.vn', Array(11).fill('https://a.vn')]) {
    const m = clone(manifest);
    m.ui.imgSrc = imgSrc;
    assert.match(checkManifest(m).errors.join('\n'), /ui\.imgSrc: at most 10 sources/, JSON.stringify(imgSrc).slice(0, 40));
  }
  const noNet = clone(manifest);
  noNet.ui.imgSrc = ['https://*.zadn.vn'];
  noNet.permissions = noNet.permissions.filter((p) => p !== 'network');
  assert.match(checkManifest(noNet).errors.join('\n'), /ui\.imgSrc: requires the "network" permission/);
});

test('zip: create and read back the same content, UTF-8, CRC check', () => {
  const files = [
    { name: 'deplao-plugin.json', data: Buffer.from('{"a":1}') },
    { name: 'ui/chữ-việt.txt', data: Buffer.from('Chi tiêu nhóm '.repeat(200)) },
    { name: 'vendor/fintrack/x.bin', data: Buffer.from([0, 1, 2, 3, 255]) },
  ];
  const back = readZip(createZip(files));
  assert.deepEqual(back.map((f) => f.name), files.map((f) => f.name));
  for (let i = 0; i < files.length; i++) assert.ok(back[i].data.equals(files[i].data));
});

test('zip: rejects names Deplao cannot extract', () => {
  for (const bad of ['../x', '/abs', 'C:/x', 'a\\b', 'con.txt', 'a/b.', 'a/ b ', 'a:b']) assert.throws(() => assertSafeName(bad), undefined, bad);
  assert.throws(() => createZip([{ name: 'A.txt', data: 'x' }, { name: 'a.txt', data: 'y' }]), /Duplicate name/);
  assert.doesNotThrow(() => assertSafeName('ui/app.js'));
  for (const reserved of ['aux', 'NUL.json', 'ui/com1.js', 'lpt9.txt']) assert.throws(() => assertSafeName(reserved), /Windows/, reserved);
});

test('zip: valid DOS date (1980-01-01), byte-identical across two builds', () => {
  const files = [{ name: 'a.txt', data: Buffer.from('x') }];
  const zip = createZip(files);
  assert.equal(zip.readUInt16LE(12), 0x21, 'date in the local header');
  assert.ok(zip.equals(createZip(files)), 'reproducible package');
});

test('vendor: rejects a source nested with vendor/fintrack (never deletes the source itself)', () => {
  for (const from of [path.join(root, 'vendor'), path.join(root, 'vendor', 'fintrack'), root]) {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'vendor-fintrack.mjs'), '--from', from], { encoding: 'utf8' });
    assert.equal(r.status, 1, from);
    assert.match(r.stderr, /nested/, from);
  }
});

test('pack: --help, unknown argument / missing value → prints usage', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts', 'pack.mjs'), ...args], { encoding: 'utf8' });
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage/);
  for (const args of [['--bogus'], ['--out'], ['--no-bundel']]) {
    const r = run(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /Usage/, args.join(' '));
  }
});

test('bundle-check: valid bundle / missing declared files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-bundle-'));
  try {
    fs.mkdirSync(path.join(dir, 'worker'));
    fs.mkdirSync(path.join(dir, 'migrations'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'worker', 'worker.js'), 'export default {}');
    fs.writeFileSync(path.join(dir, 'migrations', '001_initial.sql'), 'select 1;');
    fs.writeFileSync(path.join(dir, 'assets', 'index.html'), '<!doctype html>');
    const bundle = { mainModule: 'worker.js', modules: [{ name: 'worker.js', type: 'esm' }], compatibilityDate: '2026-10-05', compatibilityFlags: ['nodejs_compat'], assets: { dir: 'assets', binding: 'ASSETS' }, migrations: 'migrations', fintrackVersion: '0.1.0' };
    fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(bundle));
    const ok = checkBundle(dir);
    assert.deepEqual(ok.errors, []);
    assert.deepEqual({ version: ok.summary.version, assets: ok.summary.assets, migrations: ok.summary.migrations }, { version: '0.1.0', assets: 1, migrations: 1 });

    fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify({ ...bundle, mainModule: 'main.js', modules: [{ name: '../escape.js' }] }));
    const bad = checkBundle(dir);
    assert.ok(bad.errors.some((e) => /unsafe/.test(e)));
    assert.ok(bad.errors.some((e) => /mainModule/.test(e)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('README in the package: README.md (Vietnamese) without HTML blocks and images (Deplao shows it as plain text at install, the package has no docs/images)', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const packed = packageReadme(readme);
  assert.ok(packed.startsWith('# FinTrack cho Deplao\n\n**FinTrack** là'), packed.slice(0, 80));
  assert.doesNotMatch(packed, /<img|<table|<p align|<sub>|<h1/);
  assert.doesNotMatch(packed, /\n{3,}/);
  assert.ok(readme.includes('<table>') && readme.includes('src="docs/images/'), 'the source README has a screenshot table to test against');
  // The text around the images stays intact.
  for (const heading of ['## Yêu cầu', '## Cài đặt', '### Trợ lý AI', '## Node workflow', '## Câu hỏi thường gặp']) {
    assert.ok(packed.includes(heading), heading);
  }
  assert.ok(packed.includes('Cập nhật lên bản mới: cài zip mới đè lên'));

  const sample = '<h1>X</h1>\n\n**FinTrack** mở đầu.\n\n<table>\n  <tr><td><img src="a.jpg"></td></tr>\n</table>\n\nGiữa.\n\n'
    + '<p align="center">\n  <img src="b.jpg">\n  <br><sub>chú thích</sub>\n</p>\n\n<sub>Ghi chú ảnh.</sub>\n\nCuối `<sub>` trong dòng.\n';
  assert.equal(packageReadme(sample), '# X\n\n**FinTrack** mở đầu.\n\nGiữa.\n\nCuối `<sub>` trong dòng.\n');
  assert.equal(packageReadme('# Khác\n\nkhông có đoạn giới thiệu'), '# Khác\n\nkhông có đoạn giới thiệu', 'not recognized → unchanged');
});
