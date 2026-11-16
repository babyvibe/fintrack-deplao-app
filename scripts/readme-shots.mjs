#!/usr/bin/env node
/**
 * npm run shots: retake the docs screenshots (docs/images/*.jpg) from the preview with demo data
 * (scripts/dev-preview.mjs --demo): the FinTrack UI in Deplao + the app's Options page, with headless Chrome / Edge
 * over the DevTools Protocol. Everything runs on 127.0.0.1, no external network.
 *
 * Needs: Node ≥ 22 (built-in WebSocket), the FinTrack repo after `npm install` (as for npm run preview), Chrome or
 * Edge (found automatically, or set CHROME_PATH).
 *   npm run shots                                  # all
 *   npm run shots -- --only app-overview,options-cloud
 * Demo screenshots (app-*, options-*) are self-contained and can be taken alone; the install screenshots (install-*)
 * are one flow, so all four are taken together.
 * zalo-group.jpg and deplao-workflow.jpg are not taken by this script: they show Deplao's own chat / workflow UI (demo
 * data) and come from Deplao's README screenshot harness.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'docs', 'images');
const PREVIEW_PORT = 4329;
const CDP_PORT = 9339;
/** Phone-sized viewport, 480 × 1000 CSS px, captured at 1.5× (720 px wide): fits the screenshot table in the README. */
const VIEW = { width: 480, height: 1000, scale: 1.5 };
const QUALITY = 82;
const BASE = `http://127.0.0.1:${PREVIEW_PORT}`;
const APP = `${BASE}/vendor/fintrack/app/index.html`;
const OPTIONS = `${BASE}/ui/index.html#options`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg >= 0 ? new Set(String(process.argv[onlyArg + 1] || '').split(',').filter(Boolean)) : null;

if (typeof WebSocket !== 'function') {
  console.error('✗ Requires Node ≥ 22 (built-in WebSocket).');
  process.exit(1);
}

function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const pf = process.env.PROGRAMFILES || 'C:/Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = {
    win32: [path.join(pf, 'Google/Chrome/Application/chrome.exe'), path.join(pf86, 'Google/Chrome/Application/chrome.exe'), path.join(local, 'Google/Chrome/Application/chrome.exe'), path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'), path.join(pf, 'Microsoft/Edge/Application/msedge.exe')],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  }[process.platform] || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

// Child processes have children of their own (tsx → preview → workerd; Chrome → renderers…) → kill the whole tree.
const ownGroup = process.platform !== 'win32';
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

/** Start the preview in one mode (--demo / --undeployed) and wait until it prints its address. */
function startPreview(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'with-fintrack.mjs'), path.join(root, 'scripts', 'dev-preview.mjs'), `--${mode}`, '--port', String(PREVIEW_PORT)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: ownGroup });
    let log = '';
    let ready = false;
    const timer = setTimeout(() => reject(new Error(`Preview not running after 120 s:\n${log}`)), 120_000);
    child.stdout.on('data', (d) => {
      log += d;
      if (!ready && log.includes('Preview:')) {
        ready = true;
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (d) => { log += d; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!ready) reject(new Error(`Preview exited (code ${code}):\n${log}`));
    });
  });
}

/** A Chrome tab driven over the DevTools Protocol. */
class Page {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    };
  }

  static async open(port) {
    for (let i = 0; i < 100; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const target = list.find((t) => t.type === 'page');
        if (target) {
          const ws = new WebSocket(target.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
          return new Page(ws);
        }
      } catch { /* browser not ready yet */ }
      await sleep(200);
    }
    throw new Error('The browser did not open the DevTools port');
  }

  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`JS error: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`);
    return r.result.value;
  }

  /** Wait until the JS expression returns a truthy value. */
  async waitFor(expression, label, timeout = 15_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.eval(`Boolean(${expression})`).catch(() => false)) return;
      await sleep(150);
    }
    throw new Error(`Timed out waiting for: ${label}`);
  }

  /** Open a fresh page (via about:blank, so the same URL or one differing only in #hash reloads too), then wait until ready. */
  async go(url, ready, label) {
    await this.send('Page.navigate', { url: 'about:blank' });
    await this.waitFor("location.href === 'about:blank'", 'blank page');
    await this.send('Page.navigate', { url });
    await this.waitFor(ready, label);
  }

  /** Click the first element matching the selector (and the text, if given). */
  click(selector, text) {
    return this.eval(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text ? `e.textContent.trim() === ${JSON.stringify(text)}` : 'true'});
      if (!el) throw new Error('Not found: ${selector.replace(/'/g, '')} ${text ? text.replace(/'/g, '') : ''}');
      el.click();
    })()`);
  }

  /** Type into a React-controlled input: set the value through the native DOM setter, then dispatch an input event. */
  type(selector, text) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  }

  /** Bounding box of the elements (page coordinates, with padding) to capture exactly one section. */
  clipOf(selectors, pad = 10) {
    return this.eval(`(() => {
      const rects = ${JSON.stringify(selectors)}.map((s) => document.querySelector(s).getBoundingClientRect());
      const top = Math.min(...rects.map((r) => r.top)), bottom = Math.max(...rects.map((r) => r.bottom));
      const left = Math.min(...rects.map((r) => r.left)), right = Math.max(...rects.map((r) => r.right));
      return { x: Math.max(0, left - ${pad}), y: Math.max(0, top + scrollY - ${pad}), width: right - left + ${pad * 2}, height: bottom - top + ${pad * 2} };
    })()`);
  }

  async shot(name, clip) {
    const params = { format: 'jpeg', quality: QUALITY };
    if (clip) Object.assign(params, { clip: { ...clip, scale: 1 }, captureBeyondViewport: true });
    const r = await this.send('Page.captureScreenshot', params);
    fs.writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(r.data, 'base64'));
    console.log(`✓ docs/images/${name}.jpg`);
  }
}

const text = (s) => `document.body && document.body.innerText.includes(${JSON.stringify(s)})`;
const backendCall = (name, params) => `deplao.backend.call(${JSON.stringify(name)}, ${JSON.stringify(params || {})})`;

const OPTIONS_READY = "document.querySelector('#sec-workspace .step__body').children.length > 0 && document.querySelector('#sec-cloud .step__badge').textContent === 'Đang chạy'";
/** Reopen the Options page (each screenshot is self-contained, so `--only` can take any one alone). */
const openOptions = (p) => p.go(OPTIONS, OPTIONS_READY, 'Options page');
/** Reopen the owner's account (remembered → no password needed). */
const reopenOwner = (p) => p.eval(`(async () => {
  const list = await ${backendCall('accounts')};
  const owner = list.accounts.find((a) => a.email === 'chu@example.com');
  return deplao.backend.call('switchAccount', { workspaceId: owner.workspaceId });
})()`);

/** Area from the top of the page to the end of the "FinTrack trên Cloudflare" section. */
const topToCloud = `(() => { const r = document.querySelector('#sec-cloud').getBoundingClientRect(); return { x: 0, y: 0, width: ${VIEW.width}, height: r.bottom + scrollY + 12 }; })()`;

/**
 * Screenshots per preview mode, in capture order (some change the state, then restore it):
 *  - undeployed: the first-install flow (not deployed → confirm → deployed → create the first account);
 *  - demo: FinTrack with demo data, two remembered accounts, drafts from Zalo group messages.
 */
const SHOTS = {
  undeployed: [
    ['install-start', async (p) => {
      await p.go(OPTIONS, "document.querySelector('#sec-cloud .step__badge').textContent === 'Chưa triển khai'", 'first-time setup page');
      await sleep(600);
      await p.shot('install-start', await p.eval(topToCloud));
    }],
    ['install-confirm', async (p) => {
      await p.click('#sec-cloud button', 'Triển khai FinTrack');
      await p.waitFor("document.querySelector('dialog.modal[open]')", 'deploy confirm dialog');
      await sleep(600);
      await p.shot('install-confirm');
    }],
    ['install-done', async (p) => {
      await p.click('dialog.modal .btn--primary', 'Triển khai');
      await p.waitFor("document.querySelector('#sec-cloud .step__badge').textContent === 'Đang chạy' && " + text('Lần triển khai gần nhất'), 'deploy finished', 60_000);
      await sleep(800);
      await p.shot('install-done', await p.eval(topToCloud));
    }],
    ['install-account', async (p) => {
      await p.go(APP, text('Tạo tài khoản FinTrack'), 'first sign-up screen');
      await sleep(800);
      await p.shot('install-account');
    }],
  ],
  demo: [
    ['app-overview', async (p) => {
      await p.go(APP, text('Số dư tháng này'), 'overview');
      await sleep(1500);
      await p.shot('app-overview');
    }],
    ['app-overview-assets', async (p) => {
      await p.go(APP, text('Số dư tháng này'), 'overview');
      await p.click('.tabs button', 'Tài sản');
      await p.waitFor(text('Tài sản ròng'), 'Assets tab');
      await sleep(1500);
      await p.shot('app-overview-assets');
      // FinTrack remembers the chosen tab: switch back to Spending (Chi tiêu) for the next screenshots.
      await p.click('.tabs button', 'Chi tiêu');
      await p.waitFor(text('Số dư tháng này'), 'Spending tab');
    }],
    ['app-drafts', async (p) => {
      // Demo drafts from group messages (--demo) → the Overview shows how many are pending → Chờ xác nhận (pending drafts).
      await p.go(APP, text('khoản từ tin nhóm chờ xác nhận'), 'drafts notice on the overview');
      await p.click('.drafts-notice');
      await p.waitFor("document.querySelector('.draft-inbox-item')", 'pending drafts list');
      await sleep(1200);
      await p.shot('app-drafts');
      await p.eval("document.querySelector('dialog[open]').dispatchEvent(new Event('cancel', { cancelable: true }))");
    }],
    ['app-spending', async (p) => {
      await p.go(`${APP}#spending`, "document.querySelector('.ledger-calendar')", 'income and spending calendar');
      // The demo covers the current month: give it time to load. Older demo data may not: then go back to a month with
      // transactions (a day cell labeled "N giao dịch").
      const hasData = "[...document.querySelectorAll('.ledger-calendar [aria-label]')].some((e) => e.getAttribute('aria-label').includes('giao dịch'))";
      await p.waitFor(hasData, 'transactions of this month', 8000).catch(() => {});
      for (let i = 0; i < 24 && !(await p.eval(`Boolean(${hasData})`)); i++) {
        await p.click('[aria-label="Tháng trước"]');
        await sleep(800);
      }
      await sleep(1500);
      await p.shot('app-spending');
    }],
    ['app-investments', async (p) => {
      await p.eval("location.hash = 'investments'");
      await p.waitFor(text('Giá trị danh mục'), 'investments');
      await sleep(2000);
      await p.shot('app-investments');
    }],
    ['app-reports', async (p) => {
      await p.eval("location.hash = 'reports'");
      await p.waitFor(text('Chênh lệch thu chi'), 'reports');
      await sleep(2000);
      await p.shot('app-reports');
    }],
    ['app-assistant', async (p) => {
      await p.go(APP, text('Số dư tháng này'), 'overview');
      await p.click('[aria-label="Mở thao tác nhanh"]');
      await p.waitFor('document.querySelector(\'[aria-label="Thao tác nhanh"]\')', 'quick actions');
      await p.click('[aria-label="Thao tác nhanh"] button', 'Trợ lý AI');
      await p.waitFor('document.querySelector(\'[aria-label="Lời nhắn cho trợ lý"]\')', 'assistant chat input');
      await p.type('[aria-label="Lời nhắn cho trợ lý"]', 'Ăn trưa với khách 185k, trả bằng tiền mặt');
      await p.waitFor('!document.querySelector(\'[aria-label="Gửi cho trợ lý"]\').disabled', 'send button');
      await p.click('[aria-label="Gửi cho trợ lý"]');
      await p.waitFor(text('Đã tạo bản nháp'), 'assistant reply', 30_000);
      await sleep(1200);
      await p.shot('app-assistant');
    }],
    ['app-ai-settings', async (p) => {
      // sessionStorage needs a page on the same origin (when taken alone with --only, the tab is still on about:blank).
      await p.go(APP, text('Số dư tháng này'), 'overview');
      await p.eval("sessionStorage.setItem('fintrack-open-setting', 'assistant')");
      await p.go(`${APP}#settings`, text('Trợ lý của Deplao'), 'assistant settings');
      await sleep(1200);
      await p.shot('app-ai-settings');
    }],
    ['app-accounts', async (p) => {
      await p.go(APP, text('Số dư tháng này'), 'overview');
      await p.click('.account-menu > button.account-avatar');
      await p.waitFor("document.querySelector('.account-popover') && " + text('em@example.com'), 'account menu');
      await sleep(500);
      await p.shot('app-accounts');
    }],
    ['app-signin', async (p) => {
      await p.eval(backendCall('logout'));
      await p.go(APP, text('Ghi nhớ mật khẩu trên Deplao này'), 'sign-in screen');
      await sleep(800);
      await p.shot('app-signin');
      await reopenOwner(p);
    }],
    ['app-signup', async (p) => {
      await p.eval(backendCall('logout'));
      await p.go(APP, text('Ghi nhớ mật khẩu trên Deplao này'), 'sign-in screen');
      await p.click('button', 'Tạo tài khoản mới');
      await p.waitFor("document.querySelectorAll('input').length >= 3", 'sign-up form');
      await sleep(500);
      await p.shot('app-signup');
      await reopenOwner(p);
    }],
    ['options-cloud', async (p) => {
      await openOptions(p);
      await sleep(800);
      await p.shot('options-cloud', await p.eval(topToCloud));
    }],
    ['options-domain', async (p) => {
      await openOptions(p);
      await p.click('#sec-cloud button', 'Gắn tên miền');
      await p.waitFor("document.querySelector('#domain-zone')", 'domain attach form');
      await p.type('#domain-sub', 'fintrack');
      await sleep(600);
      await p.shot('options-domain', await p.clipOf(['#sec-cloud']));
      await p.click('#sec-cloud .domain-form button', 'Huỷ');
    }],
    ['options-accounts', async (p) => {
      await openOptions(p);
      await p.shot('options-accounts', await p.clipOf(['#sec-workspace']));
    }],
    ['options-deploy', async (p) => {
      await openOptions(p);
      await p.click('#sec-cloud button', 'Cập nhật FinTrack');
      await p.waitFor("document.querySelector('dialog.modal[open]')", 'update confirm dialog');
      await sleep(600);
      await p.shot('options-deploy');
      await p.eval("document.querySelector('dialog.modal').dispatchEvent(new Event('cancel', { cancelable: true }))");
    }],
  ],
};

const browserPath = findBrowser();
if (!browserPath) {
  console.error('✗ Chrome / Edge not found. Set CHROME_PATH to the browser executable.');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fintrack-shots-'));
let preview;
let browser;
let page;
let failed = false;
process.on('SIGINT', () => {
  killTree(browser);
  killTree(preview);
  process.exit(130);
});
try {
  browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--lang=vi-VN', 'about:blank'], { stdio: 'ignore', detached: ownGroup });
  page = await Page.open(CDP_PORT);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: VIEW.scale, mobile: false });
  for (const [mode, shots] of Object.entries(SHOTS)) {
    const wanted = shots.filter(([name]) => !only || only.has(name));
    if (!wanted.length) continue;
    console.log(`Preview --${mode}…`);
    preview = await startPreview(mode);
    for (const [name, run] of wanted) {
      try {
        await run(page);
      } catch (err) {
        failed = true;
        console.error(`✗ ${name}: ${err.message}`);
        // The install flow is a chain (each screenshot needs the state the previous one left) → stop;
        // demo screenshots are self-contained → keep going.
        if (mode === 'undeployed') break;
      }
    }
    killTree(preview);
    preview = null;
    await sleep(1000);
  }
} catch (err) {
  failed = true;
  console.error(`✗ ${err.message}`);
} finally {
  try { if (page) page.ws.close(); } catch { /* ignore */ }
  killTree(browser);
  killTree(preview);
  await sleep(800);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exitCode = failed ? 1 : 0;
