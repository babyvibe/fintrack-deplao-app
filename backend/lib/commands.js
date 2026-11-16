'use strict';
/**
 * Commands for the UI (deplao.backend.call, cut off by Deplao after 30 s). Every command returns { ok: true, … } or
 * { ok: false, error: { code, message } } and never throws, so the UI shows the exact Vietnamese message.
 *
 *  - api / apiResult: proxy from the FinTrack UI to the Worker (CONTRACTS §3.2–3.3); each call is a background job.
 *  - accounts / login / register / switchAccount / forgetAccount / logout: FinTrack accounts in Deplao (lib/accounts).
 *  - aiAssistants / setAiAssistant: which assistant answers for the open account, FinTrack's own or a Deplao one.
 *  - status, deploy*: entry page + Options page ("Tuỳ chọn", §3.4); job: progress of a deploy / domain background job.
 *  - domainZones / domainAttach / domainDetach / domainUse: custom domain for the Worker (lib/domain, §3.4).
 *  - shareSettings / setShareSettings: "Chia sẻ FinTrack" (Share FinTrack), public sign-up of this FinTrack as the open
 *    admin account (lib/sharing, §3.4).
 *
 * There are no draft or Zalo group commands: recording expenses from Zalo messages is configured on the workflow node
 * (lib/record), drafts live in FinTrack ("Tổng quan → Chờ xác nhận", Overview → awaiting confirmation), and the sender
 * replies "ok" / "huỷ" (cancel) right in the group.
 */

const C = require('./constants');
const { PluginError, describeError } = require('./errors');
const state = require('./state');
const jobs = require('./jobs');
const proxy = require('./proxy');
const accountsCmd = require('./accounts');
const sharing = require('./sharing');
const { getCloudflare, readBundleInfo } = require('./cloudflare');
const { precheck, runDeploy } = require('./deploy');
const { createFinTrackClient } = require('./fintrackClient');
const domain = require('./domain');
const { withTimeout, cleanLine, normalizeBaseUrl, isPlainObject, workersDevUrl, createMutex, createDeadline, compareVersions, bodyError } = require('./util');

function wrap(fn) {
  return async (params, ctx) => {
    try {
      const data = await fn(isPlainObject(params) ? params : {}, ctx);
      return { ok: true, ...(data || {}) };
    } catch (err) {
      if (!(err instanceof PluginError)) console.warn(`[fintrack] Lệnh lỗi: ${err && (err.code || '')} ${err && err.message}`);
      return { ok: false, error: describeError(err) };
    }
  };
}

const settled = (p) => p.then((value) => ({ value }), (err) => ({ error: describeError(err) }));

function requireString(v, name, max = 200) {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  if (!s || s.length > max) throw new PluginError('VALIDATION_ERROR', `Thiếu hoặc sai ${name}.`);
  return s;
}

// ─── api / apiResult (§3.2) ──────────────────────────────────────────────────

function apiResponse(job) {
  if (!job) throw new PluginError('NOT_FOUND', 'Kết quả đã hết hạn (giữ 5 phút). Thử lại thao tác.');
  if (job.state === 'running') return { pending: job.id };
  jobs.dropJob(job.id); // result handed over to the UI
  if (job.state === 'error') throw new PluginError(job.error?.code || 'ERROR', job.error?.message || 'Lỗi không rõ');
  return { status: job.result.status, body: job.result.body ?? null };
}

async function api(params, ctx) {
  const req = proxy.validateRequest(params);
  if (req.blocked) return { status: 403, body: { error: 'Không được gọi API tích hợp từ giao diện FinTrack.' } };
  const j = jobs.startJob('api', () => proxy.forward(ctx, { method: req.method, path: req.path, body: params.body }), { keepMs: C.API_KEEP_MS });
  return apiResponse(await jobs.waitJob(j.id, C.API_WAIT_MS));
}

async function apiResult(params) {
  return apiResponse(await jobs.waitJob(requireString(params.id, 'id'), 0));
}

// ─── Status (entry page + Options page) ──────────────────────────────────────

async function cloudflareStatus(deplao) {
  const cf = getCloudflare(deplao);
  if (!cf) return { supported: false };
  const st = await withTimeout(cf.status(), C.TIMEOUTS.CLOUDFLARE, 'Cloudflare');
  const out = {
    supported: true,
    connected: !!st?.connected,
    accountName: st?.accountName || '',
    accountId: st?.accountId || '',
    workersSubdomain: st?.workersSubdomain || '',
    prefix: st?.prefix || C.RESOURCE_NAME,
    missing: Array.isArray(st?.missing) ? st.missing : [],
    worker: null,
  };
  if (out.connected && !out.missing.length) {
    const w = await settled(withTimeout(cf.workers.get(C.RESOURCE_NAME), C.TIMEOUTS.CLOUDFLARE, 'Cloudflare'));
    out.worker = w.value ? { exists: !!w.value.exists, modifiedOn: w.value.modifiedOn || null, url: normalizeBaseUrl(w.value.url) || null } : null;
    if (w.error) out.workerError = w.error;
  }
  // Custom domains: list = null when not read (no Worker yet / error), so no hostname is taken as removed.
  out.domains = { supported: !!domain.domainsApi(deplao), list: null };
  if (out.domains.supported && out.worker && out.worker.exists) {
    const d = await settled(domain.listDomains(deplao));
    if (d.error) out.domains.error = d.error;
    else out.domains.list = d.value;
  }
  return out;
}

/**
 * FinTrack: health + account state in Deplao: linked (an account is open) | signed_out (the user signed out) |
 * none (FinTrack has no account yet → sign-up screen) | single / multiple (no account open → sign-in screen).
 * updateAvailable = the running Worker is older than the bundled FinTrack (→ "Cập nhật FinTrack" (Update FinTrack)).
 */
async function fintrackStatus(deplao, cfg, { fallbackUrl = '', signedOut = false, bundleVersion = '' } = {}) {
  const url = cfg.baseUrl || normalizeBaseUrl(fallbackUrl);
  const out = { url, urlSource: cfg.baseUrl ? cfg.urlSource : url ? 'cloudflare' : 'none', hasSecret: !!cfg.secret, secretSource: cfg.secretSource, health: null, workspaceState: '', workspaceCount: null };
  if (!url || !cfg.secret) return out;
  const client = createFinTrackClient({ fetch: deplao.http.fetch, baseUrl: url, secret: cfg.secret });
  const h = await settled(client.health());
  if (h.value) {
    out.health = { ok: h.value.ok !== false, version: cleanLine(h.value.version, 40), speech: h.value.speechAvailable !== false };
    out.updateAvailable = !!(bundleVersion && out.health.version && compareVersions(out.health.version, bundleVersion) < 0);
  } else {
    out.error = h.error;
    return out;
  }
  if (cfg.workspaceId) {
    out.workspaceState = 'linked';
    return out;
  }
  const list = await settled(client.workspaces({ timeout: C.TIMEOUTS.WORKSPACES }));
  if (list.error) {
    out.error = list.error;
    return out;
  }
  // Count only: other accounts open only with a password (or when remembered), so their emails are not sent to the UI.
  out.workspaceCount = list.value.length;
  out.workspaceState = !out.workspaceCount ? 'none' : signedOut ? 'signed_out' : out.workspaceCount === 1 ? 'single' : 'multiple';
  return out;
}

/** FinTrack's assistant settings (GET /assistant/settings, session of the open account) → body or null. */
async function fintrackAssistantSettings(ctx) {
  const r = await settled(proxy.forward(ctx, { method: 'GET', path: '/assistant/settings' }, { timeoutMs: C.TIMEOUTS.SETTINGS }));
  return r.value && r.value.status === 200 && isPlainObject(r.value.body) ? r.value.body : null;
}

const profileView = (p) => ({ id: String(p.id), name: cleanLine(p.name || p.id, 80), provider: cleanLine(p.provider || '', 20), model: cleanLine(p.model || '', 100), configured: !!p.configured });

// ─── AI assistant choice ─────────────────────────────────────────────────────

/** Assistants selectable for the open account: FinTrack's own (OpenAI / Gemini / DeepSeek profiles) + Deplao's. */
async function aiAssistants(params, ctx) {
  const { deplao } = ctx;
  const active = await state.getActive(deplao);
  const [list, def, choice, body] = await Promise.all([
    proxy.listAssistantOptions(deplao),
    settled(withTimeout(deplao.ai.getDefaultAiAssistant(), C.TIMEOUTS.AI_LIST, 'Trợ lý AI')),
    state.getAiChoice(deplao, active ? active.id : ''),
    active ? fintrackAssistantSettings(ctx) : Promise.resolve(null),
  ]);
  const d = def.value && def.value.id ? def.value : null;
  const assistants = list || [];
  const profiles = body && Array.isArray(body.profiles) ? body.profiles.filter((p) => p && p.id).map(profileView) : [];
  const defaultProfileId = body && body.defaultProfileId ? String(body.defaultProfileId) : null;
  const selectedId = choice.source === 'deplao' && choice.id && assistants.some((x) => x.id === choice.id) ? choice.id : '';
  return {
    supported: list !== null,
    assistants,
    selectedId,
    defaultAssistant: d ? { id: String(d.id), name: cleanLine(d.name || d.id, 80), model: cleanLine(d.model || '', 100) } : null,
    fintrack: { available: !!body, profiles, defaultProfileId },
    choice: choice.source === 'fintrack' ? { source: 'fintrack', id: defaultProfileId || choice.id } : { source: 'deplao', id: selectedId },
  };
}

/**
 * { source: 'fintrack', profileId } → FinTrack's assistant (set as the default profile; FinTrack rejects a profile
 * without an API key); { source: 'deplao', id } → a Deplao assistant, empty id = Deplao's default; a disabled
 * assistant cannot be chosen. Picked in FinTrack under "Cài đặt → Trợ lý AI" (Settings → AI assistant), stored per
 * open account; applies to chat in FinTrack and to Zalo group messages recorded into that account.
 */
async function setAiAssistant(params, ctx) {
  const { deplao } = ctx;
  const active = await state.getActive(deplao);
  if (!active) throw new PluginError('NOT_CONFIGURED', 'Mở FinTrack và đăng nhập trước khi chọn trợ lý.');
  if (params.source === 'fintrack') {
    const profileId = typeof params.profileId === 'string' ? params.profileId.trim() : '';
    if (!profileId || profileId.length > 200) throw new PluginError('VALIDATION_ERROR', 'Chọn một trợ lý của FinTrack.');
    const r = await proxy.forward(ctx, { method: 'POST', path: `/assistant/profiles/${encodeURIComponent(profileId)}/default`, body: {} }, { timeoutMs: C.TIMEOUTS.SETTINGS });
    if (r.status >= 400) throw new PluginError(r.status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR', bodyError(r.body) || `FinTrack trả ${r.status}`);
    await state.setAiChoice(deplao, active.id, { source: 'fintrack', id: profileId });
    const b = isPlainObject(r.body) ? r.body : {};
    return { choice: { source: 'fintrack', id: profileId }, assistant: { source: 'fintrack', id: profileId, name: cleanLine(b.name, 80), model: cleanLine(b.model, 100) } };
  }
  const id = params.id === null || params.id === undefined ? '' : String(params.id).trim();
  if (id) {
    const list = await proxy.listAssistantOptions(deplao);
    if (list === null) throw new PluginError('UNSUPPORTED', 'Bản Deplao đang dùng chưa cho chọn trợ lý AI. Cập nhật Deplao lên bản mới nhất.');
    const a = list.find((x) => x.id === id);
    if (!a) throw new PluginError('NOT_FOUND', 'Không còn trợ lý này trong Deplao. Tải lại danh sách.');
    if (!a.enabled) throw new PluginError('VALIDATION_ERROR', `Trợ lý “${a.name}” đang tắt. Bật lại ở Tích hợp → Trợ lý AI trong Deplao.`);
  }
  await state.setAiChoice(deplao, active.id, { source: 'deplao', id });
  proxy.resetAssistantCache();
  const now = await proxy.deplaoAssistant(deplao, id);
  return { choice: { source: 'deplao', id }, assistant: now ? { source: 'deplao', id: now.id, name: now.name, model: now.model, chosen: now.chosen } : null };
}

/**
 * True when the Worker deployed by this app (workers.dev / custom domain, not a URL typed into the app settings) runs
 * a different bundle than the bundled one: even at the same version it still needs "Cập nhật FinTrack" (new migrations,
 * new APIs). A deploy without a recorded bundle build id counts as an old bundle.
 */
function staleDeploy(bundle, cfg) {
  if (!bundle || !bundle.build || !cfg || !isPlainObject(cfg.deploy)) return false;
  if (cfg.urlSource !== 'deploy' && cfg.urlSource !== 'domain') return false;
  return cfg.deploy.build !== bundle.build;
}

/**
 * Status for the entry page / Options page. ready = FinTrack answers + the bundle has the app/ UI → the entry page
 * switches straight to the FinTrack UI (when nobody is signed in, FinTrack shows its sign-in / sign-up screen). Parts
 * run in parallel; a part that fails or times out only becomes { error } for that part; the whole command fits in
 * ~25 s (UI commands are cut off after 30 s).
 */
async function status(params, ctx) {
  const { deplao, settings } = ctx;
  const deadline = createDeadline(C.COMMAND_BUDGET_MS);
  const part = (p, label, cap = C.COMMAND_BUDGET_MS) => settled(withTimeout(p, Math.max(1000, Math.min(cap, deadline.remaining() - 1000)), label));
  const skip = Promise.resolve({ value: null });
  const quick = params.quick === true; // entry page: skip the Cloudflare part when a URL is already known
  const [cfg, signedOut] = await Promise.all([state.getFinTrackConfig(deplao, settings), state.isSignedOut(deplao)]);
  const bundle = readBundleInfo();
  const ftOpts = { signedOut, bundleVersion: bundle.version || '' };
  const cfP = quick && cfg.baseUrl ? skip : part(cloudflareStatus(deplao), 'Cloudflare');
  // No saved URL: try the Worker on Cloudflare (deployed earlier / from another machine).
  const ftP = cfg.baseUrl
    ? part(fintrackStatus(deplao, cfg, ftOpts), 'FinTrack')
    : cfP.then((cf) => part(fintrackStatus(deplao, cfg, { ...ftOpts, fallbackUrl: cfg.secret ? cf.value?.worker?.url || workersDevUrl(cf.value?.workersSubdomain) : '' }), 'FinTrack'));
  const [cf, fintrack, sys, session, remembered, deployJob] = await Promise.all([
    cfP,
    ftP,
    part(deplao.system.info(), 'Deplao', C.TIMEOUTS.SYSTEM_INFO),
    settled(state.getSession(deplao, cfg.workspaceId)),
    settled(state.listAccounts(deplao)),
    settled(latestDeployJob(deplao)),
  ]);
  let ft = fintrack.value || { error: fintrack.error };
  // Custom domain no longer attached to the Worker (removed on Cloudflare / from another machine) → drop it. In use but
  // not answering while workers.dev still runs → fall back to workers.dev for now (clear verifiedAt and wait for the
  // user to press "Kiểm tra" (Check)).
  let dom = cfg.domain;
  const listed = cf.value && cf.value.domains && Array.isArray(cf.value.domains.list) ? cf.value.domains.list : null;
  if (dom && listed && !listed.some((d) => d.hostname === dom.hostname)) {
    await state.setDomain(deplao, null);
    dom = null;
  }
  if (cfg.urlSource === 'domain' && !(ft.health && ft.health.ok) && cfg.fallbackUrl) {
    const again = await part(fintrackStatus(deplao, { ...cfg, baseUrl: cfg.fallbackUrl, urlSource: 'deploy' }, ftOpts), 'FinTrack');
    if (again.value && again.value.health && again.value.health.ok) {
      if (dom) {
        dom = { ...dom, verifiedAt: 0 };
        await state.setDomain(deplao, dom);
      }
      ft = { ...again.value, domainDown: cfg.domain.hostname };
    }
  }
  const healthy = !!(ft.health && ft.health.ok);
  // Never offer a downgrade: a Worker reporting a newer version than the bundled one is not "outdated".
  const notNewer = !ft.health || compareVersions(ft.health.version, bundle.version || '') <= 0;
  if (healthy && !ft.updateAvailable && notNewer && staleDeploy(bundle, cfg)) ft = { ...ft, updateAvailable: true };
  let reason = '';
  if (!cfg.baseUrl && !ft.url) reason = 'not_deployed';
  else if (!healthy) reason = 'unreachable';
  else if (!bundle.hasApp) reason = 'bundle_incomplete';
  const s = session.value;
  const active = cfg.workspace;
  return {
    ready: !reason,
    reason,
    appPath: bundle.appPath || '',
    plugin: { id: C.PLUGIN_ID, version: C.PLUGIN_VERSION },
    deplao: sys.value ? { appVersion: sys.value.appVersion || '', apiVersion: sys.value.apiVersion || 0 } : null,
    cloudflare: cf.value || (cf.error ? { supported: true, error: cf.error } : null),
    bundle,
    deploy: cfg.deploy,
    fintrack: ft,
    /** FinTrack account open in Deplao and the remembered accounts (no tokens). */
    account: active ? { workspaceId: active.id, email: cleanLine(active.email, 120), name: cleanLine(active.name, 80) } : null,
    accounts: (remembered.value || []).map((a) => ({ workspaceId: a.workspaceId, email: a.email, name: a.name, active: !!active && a.workspaceId === String(active.id) })),
    signedOut,
    session: s ? { active: s.expiresAt > Date.now(), expiresAt: s.expiresAt } : { active: false },
    deployJob: deployJob.value || null,
    /** Custom domain in use / pending (verifiedAt = 0) and the latest "Gắn tên miền" (Attach domain) job. */
    domain: dom ? { hostname: dom.hostname, zoneName: dom.zoneName, verifiedAt: dom.verifiedAt } : null,
    domainJob: jobs.latestJob('domain'),
  };
}

// ─── Deploy ──────────────────────────────────────────────────────────────────

async function deployCheck(params, { deplao }) {
  const pre = await precheck(deplao);
  return { accountName: pre.status.accountName || '', workersSubdomain: pre.status.workersSubdomain || '', worker: pre.worker, bundle: pre.bundle };
}

const persistLock = createMutex();

/** Deploy runs in the background, one at a time; progress is saved to storage so a reopened page still shows it. */
async function deployStart(params, ctx) {
  const opts = { confirmOverwrite: params.confirmOverwrite === true, rotateSecret: params.rotateSecret === true };
  const persist = (snap) => persistLock(() => state.set(ctx.deplao, C.KEYS.DEPLOY_JOB, snap)).catch(() => undefined);
  const job = jobs.startJob('deploy', async (progress) => {
    const result = await runDeploy(ctx, opts, progress);
    // The secret / Worker may have changed: re-read the assistant, re-check accounts. Saved sessions stay usable (they
    // live in D1, independent of the secret); a session that is no longer valid → 401 → a new one is minted.
    proxy.resetCaches();
    return result;
  }, { exclusive: true, onChange: persist, keepMs: 60 * 60_000 });
  return { job };
}

async function latestDeployJob(deplao) {
  const live = jobs.latestJob('deploy');
  if (live) return live;
  const stored = await state.get(deplao, C.KEYS.DEPLOY_JOB);
  if (!stored || typeof stored !== 'object') return null;
  if (stored.state !== 'running') return stored;
  return {
    ...stored,
    state: 'error',
    steps: (stored.steps || []).map((s) => (s.status === 'running' ? { ...s, status: 'error' } : s)),
    error: { code: 'INTERRUPTED', message: 'Lần triển khai trước bị gián đoạn (ứng dụng hoặc Deplao khởi động lại). Bấm triển khai lại; dữ liệu và migration đã áp được giữ nguyên.' },
  };
}

async function deployStatus(params, { deplao }) {
  return { job: await latestDeployJob(deplao) };
}

async function job(params, { deplao }) {
  const j = jobs.getJob(params.id);
  if (j) return { job: j };
  const d = await latestDeployJob(deplao);
  if (d && d.id === params.id) return { job: d };
  throw new PluginError('NOT_FOUND', 'Không còn thông tin việc này (ứng dụng vừa khởi động lại?). Tải lại trang.');
}

// ─── Custom domain (§3.4) ────────────────────────────────────────────────────

async function domainZones(params, { deplao }) {
  return { zones: await domain.listZones(deplao) };
}

/** Attaches in the background (Deplao asks the user, then we wait for DNS + certificate); the UI polls with `job`. */
async function domainAttach(params, ctx) {
  const target = await domain.targetHostname(ctx.deplao, params);
  const job = jobs.startJob('domain', async (progress) => {
    const result = await domain.runAttach(ctx, target, progress);
    proxy.resetCaches();
    return result;
  }, { exclusive: true, keepMs: 30 * 60_000 });
  return { job, hostname: target.hostname };
}

async function domainDetach(params, { deplao }) {
  const res = await domain.detach(deplao, params.hostname);
  proxy.resetCaches();
  return res;
}

/** Re-checks / uses a hostname attached to the Worker (if it answers, it becomes the FinTrack URL). */
async function domainUse(params, { deplao, settings }) {
  const res = await domain.useDomain(deplao, settings, params.hostname);
  proxy.resetCaches();
  return res;
}

module.exports = {
  api: wrap(api),
  apiResult: wrap(apiResult),
  aiAssistants: wrap(aiAssistants),
  setAiAssistant: wrap(setAiAssistant),
  status: wrap(status),
  deployCheck: wrap(deployCheck),
  deployStart: wrap(deployStart),
  deployStatus: wrap(deployStatus),
  job: wrap(job),
  domainZones: wrap(domainZones),
  domainAttach: wrap(domainAttach),
  domainDetach: wrap(domainDetach),
  domainUse: wrap(domainUse),
  accounts: wrap(accountsCmd.accounts),
  login: wrap(accountsCmd.login),
  register: wrap(accountsCmd.register),
  switchAccount: wrap(accountsCmd.switchAccount),
  forgetAccount: wrap(accountsCmd.forgetAccount),
  logout: wrap(accountsCmd.logout),
  shareSettings: wrap(sharing.shareSettings),
  setShareSettings: wrap(sharing.setShareSettings),
};
