'use strict';
/**
 * Custom domain for the FinTrack Worker (CONTRACTS §1.1, §3.4) through deplao.cloudflare.zones + workers.domains.*
 * (older Deplao versions lack them → supported: false, and the Options page ("Tuỳ chọn") asks the user to update
 * Deplao).
 *
 *  - Attach: Deplao validates the name (a new subdomain of a zone in the account, never overwriting an existing DNS
 *    record), then asks the user in a Deplao dialog; Cloudflare creates the DNS record + certificate itself. The app
 *    only uses that hostname as the FinTrack URL once https://<hostname>/api/integration/health answers (verifiedAt);
 *    until then it keeps using workers.dev.
 *  - Detach: only hostnames of the "fintrack" Worker (Deplao will not touch other Workers' hostnames); the URL goes
 *    back to workers.dev.
 *  - A hostname in use that stops answering while workers.dev still runs → clear verifiedAt (falls back to workers.dev
 *    until checked again).
 */

const C = require('./constants');
const { PluginError, describeError } = require('./errors');
const state = require('./state');
const { getCloudflare } = require('./cloudflare');
const { createFinTrackClient } = require('./fintrackClient');
const { withTimeout, sleep, cleanLine } = require('./util');

/** Subdomain: a single DNS label, e.g. "fintrack" → fintrack.<zone>. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** deplao.cloudflare if it has the domain functions (newer Deplao) → cf, otherwise null. */
function domainsApi(deplao) {
  const cf = getCloudflare(deplao);
  const d = cf && cf.workers && cf.workers.domains;
  if (!cf || typeof cf.zones !== 'function' || !d || typeof d.list !== 'function' || typeof d.attach !== 'function' || typeof d.detach !== 'function') return null;
  return cf;
}

function requireApi(deplao) {
  const cf = domainsApi(deplao);
  if (!cf) throw new PluginError('UNSUPPORTED', 'Bản Deplao đang dùng chưa gắn được tên miền cho ứng dụng. Cập nhật Deplao lên bản mới nhất.');
  return cf;
}

function normalizeHostname(value) {
  const host = typeof value === 'string' ? value.trim().toLowerCase().replace(/\.+$/, '') : '';
  if (!state.HOSTNAME_RE.test(host)) throw new PluginError('VALIDATION_ERROR', 'Tên miền không hợp lệ.');
  return host;
}

const zoneView = (z) => ({ id: cleanLine(z && z.id, 64), name: cleanLine(z && z.name, 253).toLowerCase() });
const domainView = (d) => ({ hostname: cleanLine(d && d.hostname, 253).toLowerCase(), zoneName: cleanLine(d && d.zoneName, 253).toLowerCase() });

/** Active zones of the Cloudflare account (for the picker). */
async function listZones(deplao) {
  const cf = requireApi(deplao);
  const zones = await withTimeout(cf.zones(), C.COMMAND_BUDGET_MS, 'Cloudflare');
  return (Array.isArray(zones) ? zones : []).map(zoneView).filter((z) => z.id && state.HOSTNAME_RE.test(z.name));
}

/** Hostnames attached to the "fintrack" Worker (Deplao caches the list for ~1 minute). */
async function listDomains(deplao, timeoutMs = C.TIMEOUTS.CLOUDFLARE) {
  const cf = requireApi(deplao);
  const list = await withTimeout(cf.workers.domains.list(C.RESOURCE_NAME), timeoutMs, 'Cloudflare');
  return (Array.isArray(list) ? list : []).map(domainView).filter((d) => state.HOSTNAME_RE.test(d.hostname));
}

/** One try of https://<hostname>/api/integration/health with the secret → { ok, version } | { ok:false, error }. */
async function checkDomain(deplao, settings, hostname) {
  const sec = await state.getSecret(deplao, settings);
  if (!sec.secret) return { ok: false, error: { code: 'NOT_DEPLOYED', message: 'Chưa có secret tích hợp: triển khai FinTrack trước.' } };
  const client = createFinTrackClient({ fetch: deplao.http.fetch, baseUrl: `https://${hostname}`, secret: sec.secret, timeoutMs: C.TIMEOUTS.DOMAIN_HEALTH });
  try {
    const h = await client.health({ timeout: C.TIMEOUTS.DOMAIN_HEALTH });
    if (h && h.ok !== false) return { ok: true, version: cleanLine(h.version, 40) };
    return { ok: false, error: { code: 'FT_HEALTH', message: 'FinTrack chưa sẵn sàng.' } };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/** Subdomain + zone (from the account) → validated hostname. */
async function targetHostname(deplao, params) {
  const sub = typeof params.sub === 'string' ? params.sub.trim().toLowerCase() : '';
  if (!LABEL_RE.test(sub)) throw new PluginError('VALIDATION_ERROR', 'Tên con chỉ gồm chữ thường a-z, số và dấu "-" (không đặt "-" ở đầu hoặc cuối), tối đa 63 ký tự.');
  const zoneName = typeof params.zone === 'string' ? params.zone.trim().toLowerCase() : '';
  const zones = await listZones(deplao);
  const zone = zones.find((z) => z.name === zoneName);
  if (!zone) throw new PluginError('VALIDATION_ERROR', 'Chọn một tên miền trong tài khoản Cloudflare đã kết nối.');
  return { hostname: `${sub}.${zone.name}`, zoneName: zone.name };
}

/**
 * "Gắn tên miền" (Attach domain) background job: Deplao asks the user (no time limit) → Cloudflare attaches → wait for
 * DNS + certificate (retry every 10 seconds, up to 15 minutes) → use it as the FinTrack URL.
 */
async function runAttach(ctx, target, progress, deps = {}) {
  const { deplao, settings } = ctx;
  const cf = requireApi(deplao);
  progress('attach', 'running', `Gắn ${target.hostname}: xác nhận ở hộp thoại của Deplao`);
  const res = await cf.workers.domains.attach(C.RESOURCE_NAME, target.hostname);
  const hostname = res && typeof res.hostname === 'string' && res.hostname ? res.hostname : target.hostname;
  const zoneName = (res && res.zoneName) || target.zoneName;
  const attachedAt = Date.now();
  await state.setDomain(deplao, { hostname, zoneName, attachedAt, verifiedAt: 0 });
  progress('attach', 'done', res && res.created === false ? `${hostname} đã gắn sẵn cho Worker “fintrack”` : `Đã gắn ${hostname} cho Worker “fintrack”`);

  progress('dns', 'running', 'Chờ Cloudflare tạo DNS và chứng chỉ (thường 1 đến 5 phút)');
  const wait = deps.sleep || sleep;
  const pollMs = deps.pollMs ?? C.DOMAIN_POLL_MS;
  const deadline = Date.now() + (deps.waitMs ?? C.DOMAIN_WAIT_MS);
  let last = null;
  for (;;) {
    const r = await checkDomain(deplao, settings, hostname);
    if (r.ok) {
      await state.setDomain(deplao, { hostname, zoneName, attachedAt, verifiedAt: Date.now() });
      progress('dns', 'done', `https://${hostname} đang trả lời${r.version ? ` · FinTrack v${r.version}` : ''}. Ứng dụng đã chuyển sang địa chỉ này.`);
      return { hostname, verified: true };
    }
    last = r.error;
    if (Date.now() + pollMs > deadline) break;
    await wait(pollMs);
  }
  progress('dns', 'warn', `Cloudflare chưa xong DNS hoặc chứng chỉ cho ${hostname}${last && last.message ? ` (${last.message})` : ''}. FinTrack vẫn chạy ở workers.dev; bấm “Kiểm tra” cạnh tên miền sau ít phút.`);
  return { hostname, verified: false };
}

/** Detaches a hostname from the "fintrack" Worker; if it was in use, the URL goes back to workers.dev. */
async function detach(deplao, hostnameRaw) {
  const cf = requireApi(deplao);
  const hostname = normalizeHostname(hostnameRaw);
  const res = await withTimeout(cf.workers.domains.detach(C.RESOURCE_NAME, hostname), C.COMMAND_BUDGET_MS, 'Cloudflare');
  const cur = await state.getDomain(deplao);
  if (cur && cur.hostname === hostname) await state.setDomain(deplao, null);
  return { removed: !!(res && res.removed) };
}

/** Checks (and uses) a hostname attached to the Worker: if it answers, it becomes the FinTrack URL. */
async function useDomain(deplao, settings, hostnameRaw) {
  const hostname = normalizeHostname(hostnameRaw);
  const attached = await listDomains(deplao, C.COMMAND_BUDGET_MS / 2);
  const found = attached.find((d) => d.hostname === hostname);
  if (!found) throw new PluginError('NOT_FOUND', `${hostname} không còn gắn cho Worker “fintrack”. Tải lại trang.`);
  const r = await checkDomain(deplao, settings, hostname);
  const cur = await state.getDomain(deplao);
  const attachedAt = cur && cur.hostname === hostname ? cur.attachedAt : Date.now();
  if (!r.ok) {
    await state.setDomain(deplao, { hostname, zoneName: found.zoneName, attachedAt, verifiedAt: 0 });
    throw new PluginError('DOMAIN_UNREACHABLE', `https://${hostname} chưa trả lời (${r.error.message}). Cloudflare có thể chưa xong DNS hoặc chứng chỉ, thử lại sau ít phút.`);
  }
  await state.setDomain(deplao, { hostname, zoneName: found.zoneName, attachedAt, verifiedAt: Date.now() });
  return { hostname, version: r.version };
}

module.exports = { domainsApi, listZones, listDomains, targetHostname, runAttach, detach, useDomain };
