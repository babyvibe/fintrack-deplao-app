'use strict';
/**
 * Deploys FinTrack to the user's Cloudflare account through deplao.cloudflare:
 *   status → d1.ensure('fintrack') → d1.migrate (like wrangler, skips migrations already applied)
 *   → workers.deployBundle (D1 binding DB, Workers AI binding AI, secret DEPLAO_INTEGRATION_SECRET)
 *   → check /api/integration/health.
 * If the Worker already exists, the user must confirm (D1 data is kept, only the Worker code is replaced).
 */

const { RESOURCE_NAME, BINDING_DB, BINDING_AI, SECRET_NAME, BUNDLE_DIR, KEYS } = require('./constants');
const { PluginError } = require('./errors');
const { getCloudflare, readBundleInfo } = require('./cloudflare');
const { createFinTrackClient } = require('./fintrackClient');
const state = require('./state');
const { randomSecret, normalizeBaseUrl, workersDevUrl, sleep, withTimeout } = require('./util');

/** Pre-deploy checks (for the confirmation dialog). */
async function precheck(deplao) {
  const cf = getCloudflare(deplao);
  if (!cf) {
    throw new PluginError('CF_UNSUPPORTED', 'Bản Deplao đang dùng chưa hỗ trợ triển khai lên Cloudflare cho ứng dụng. Cập nhật Deplao lên bản mới nhất.');
  }
  const st = await withTimeout(cf.status(), 12_000, 'Kiểm tra Cloudflare');
  if (!st || !st.connected) {
    throw new PluginError('CF_NOT_CONNECTED', 'Deplao chưa kết nối Cloudflare. Mở Cài đặt → Internet & Đám mây → Kết nối Cloudflare.');
  }
  if (Array.isArray(st.missing) && st.missing.length) {
    throw new PluginError('CF_PERMISSION', `Token Cloudflare còn thiếu quyền: ${st.missing.join(', ')}. Tạo lại token ở Cài đặt → Internet & Đám mây → Kết nối Cloudflare (link mẫu đã có sẵn quyền Worker và D1).`);
  }
  const bundle = readBundleInfo();
  if (!bundle.present) {
    throw new PluginError('BUNDLE_MISSING', 'Ứng dụng thiếu gói FinTrack (vendor/fintrack). Hãy cài bản phát hành đầy đủ từ trang dự án.');
  }
  const worker = await withTimeout(cf.workers.get(RESOURCE_NAME), 12_000, 'Đọc Worker trên Cloudflare');
  return { cf, status: st, bundle, worker: worker || { exists: false, modifiedOn: null, url: null } };
}

/** Calls health until the new Worker answers (the workers.dev route can take a few tens of seconds). */
async function waitForHealth(client, { attempts = 8, delayMs = 5000 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const h = await client.health({ timeout: 10_000 });
      if (h && (h.ok === true || h.ok === undefined)) return h;
    } catch (err) {
      lastErr = err;
      // Waiting longer will not fix a wrong secret (a 401 from the third attempt on → stop).
      if (err && err.code === 'FT_UNAUTHORIZED' && i >= 2) break;
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  throw lastErr || new PluginError('FT_HEALTH', 'FinTrack chưa phản hồi.');
}

/**
 * @param {object} ctx  { deplao, settings }
 * @param {object} opts { confirmOverwrite, rotateSecret }
 * @param {(id:string, status:string, detail?:string)=>void} progress
 */
async function runDeploy(ctx, opts, progress, deps = {}) {
  const { deplao, settings } = ctx;
  const wait = deps.waitForHealth || waitForHealth;

  progress('check', 'running', 'Kiểm tra Cloudflare và gói FinTrack');
  const pre = await precheck(deplao);
  const { cf, bundle, worker } = pre;
  if (worker.exists && !opts.confirmOverwrite) {
    throw new PluginError('NEEDS_CONFIRM', `Worker "${RESOURCE_NAME}" đã có trên Cloudflare. Xác nhận cập nhật để tiếp tục.`);
  }
  progress('check', 'done', worker.exists ? `Worker "${RESOURCE_NAME}" đã có: sẽ cập nhật mã, giữ dữ liệu` : `Sẽ tạo Worker "${RESOURCE_NAME}" mới`);

  progress('d1', 'running', `Chuẩn bị cơ sở dữ liệu D1 "${RESOURCE_NAME}"`);
  const db = await cf.d1.ensure(RESOURCE_NAME);
  progress('d1', 'done', db && db.created ? `Đã tạo D1 "${RESOURCE_NAME}"` : `Dùng D1 "${RESOURCE_NAME}" đang có (giữ nguyên dữ liệu)`);

  progress('migrate', 'running', 'Áp migration cơ sở dữ liệu');
  const mig = await cf.d1.migrate(RESOURCE_NAME, bundle.migrationsDir);
  const applied = Array.isArray(mig?.applied) ? mig.applied : [];
  const skipped = Array.isArray(mig?.skipped) ? mig.skipped : [];
  progress('migrate', 'done', applied.length ? `Áp ${applied.length} migration mới (${skipped.length} đã có)` : `Không có migration mới (${skipped.length} đã có)`);

  // Secret: app settings > stored > newly generated (rotateSecret skips the stored one). Saved only once the Worker
  // has accepted it.
  const current = await state.getSecret(deplao, settings);
  const secret = current.source === 'settings' ? current.secret : (!opts.rotateSecret && current.secret) || randomSecret();

  progress('worker', 'running', 'Tải Worker FinTrack lên Cloudflare');
  const res = await cf.workers.deployBundle({
    name: RESOURCE_NAME,
    bundleDir: BUNDLE_DIR,
    bindings: { d1: { [BINDING_DB]: RESOURCE_NAME }, ai: BINDING_AI },
    secrets: { [SECRET_NAME]: secret },
    workersDev: true,
  });
  if (current.source !== 'settings') await state.set(deplao, KEYS.SECRET, secret);
  const url = normalizeBaseUrl(res?.url) || normalizeBaseUrl(worker.url) || workersDevUrl(pre.status.workersSubdomain, RESOURCE_NAME);
  const record = {
    workerName: RESOURCE_NAME,
    url,
    deployedAt: Number(res?.deployedAt) || Date.now(),
    fintrackVersion: bundle.version,
    // Build id of the bundle just deployed: a bundled package with another id → "Có bản mới" (update available), even
    // at the same version.
    build: bundle.build || '',
    d1: { uuid: db?.uuid || '', name: RESOURCE_NAME, created: !!db?.created },
    migrations: { applied, skippedCount: skipped.length },
    updatedExisting: !!worker.exists,
  };
  await state.set(deplao, KEYS.DEPLOY, record);
  progress('worker', 'done', url ? `Đã triển khai: ${url}` : 'Đã triển khai (chưa có địa chỉ workers.dev)');

  progress('verify', 'running', 'Kiểm tra FinTrack trả lời');
  // URL the app will use: app settings URL > a custom domain that has answered > the workers.dev just deployed.
  const fromSettings = normalizeBaseUrl(settings?.fintrackUrl);
  const domain = fromSettings ? null : await state.getDomain(deplao);
  const primary = fromSettings || (domain && domain.verifiedAt ? `https://${domain.hostname}` : '') || url;
  if (!primary) {
    progress('verify', 'warn', 'Chưa có địa chỉ để kiểm tra: bật workers.dev trên Cloudflare hoặc nhập Địa chỉ FinTrack trong Cài đặt ứng dụng.');
    return { ...record, healthy: false };
  }
  const probe = async (baseUrl) => {
    const client = createFinTrackClient({ fetch: deplao.http.fetch, baseUrl, secret });
    const h = await wait(client);
    const list = await client.workspaces().catch(() => null);
    return { h, count: Array.isArray(list) ? list.length : null };
  };
  // Each FinTrack account has exactly one workspace → count them as accounts, like the UI does.
  const running = ({ h, count }, where) => `FinTrack ${h?.version ? `v${h.version} ` : ''}đang chạy${where ? ` ở ${where}` : ''}${count === null ? '' : count ? ` · ${count} tài khoản` : ' · chưa có tài khoản'}`;
  let firstErr;
  try {
    const ok = await probe(primary);
    progress('verify', 'done', running(ok, primary === url ? '' : primary));
    return { ...record, healthy: true, version: ok.h?.version || '', workspaces: ok.count };
  } catch (err) {
    firstErr = err;
  }
  // The URL in use does not answer: is the Worker running on workers.dev? Point at what actually needs fixing.
  if (url && primary !== url) {
    const fallback = await probe(url).catch(() => null);
    if (fallback && domain) {
      await state.setDomain(deplao, { ...domain, verifiedAt: 0 });
      progress('verify', 'warn', `${running(fallback, url)}. Tên miền ${domain.hostname} chưa trả lời (${firstErr.message || firstErr}) nên tạm dùng workers.dev; bấm “Kiểm tra” cạnh tên miền sau ít phút.`);
      return { ...record, healthy: true, version: fallback.h?.version || '', workspaces: fallback.count };
    }
    if (fallback) {
      progress('verify', 'warn', `${running(fallback, url)}, nhưng Địa chỉ FinTrack trong Cài đặt ứng dụng (${primary}) không trả lời: ${firstErr.message || firstErr}. Sửa ô đó, hoặc để trống để dùng workers.dev / tên miền riêng.`);
      return { ...record, healthy: false, settingsUrlBroken: true };
    }
  }
  progress('verify', 'warn', `Đã triển khai nhưng chưa gọi được FinTrack: ${firstErr.message || firstErr}. Thử “Kiểm tra lại” sau 1 phút.`);
  return { ...record, healthy: false };
}

module.exports = { precheck, runDeploy, waitForHealth };
