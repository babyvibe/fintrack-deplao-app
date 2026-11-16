'use strict';
/**
 * Test fakes for ctx.deplao (the backend SDK) and the FinTrack v2 Worker (CONTRACTS §2). No network, no Deplao.
 */

const crypto = require('crypto');

const SECRET = 'secret-123';
const BASE_URL = 'https://fintrack.example.workers.dev';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function apiError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

const ACTION_KEYS = ['type', 'accountId', 'destinationAccountId', 'categoryId', 'instrumentId', 'side', 'amount', 'quantity', 'quantityUnit', 'price', 'currency', 'fee', 'tax', 'date', 'note', 'name', 'annualRate', 'maturityDate', 'unsure'];
/** Wallets and categories of the fake workspace (GET /api/bootstrap). */
const BOOTSTRAP = {
  accounts: [{ id: 'cash', name: 'Tiền mặt', kind: 'cash' }, { id: 'vcb', name: 'Vietcombank', kind: 'cash' }],
  categories: [{ id: 'food', name: 'Ăn uống', kind: 'expense' }, { id: 'living', name: 'Sinh hoạt', kind: 'expense' }, { id: 'salary', name: 'Lương', kind: 'income' }],
};
const TODAY = '2026-10-20';

/** An action with every key, as FinTrack returns it (missing → null). */
function action(o) {
  const a = {};
  for (const k of ACTION_KEYS) a[k] = o[k] === undefined ? null : o[k];
  return a;
}

/** Fake FinTrack Worker. */
function createFakeFinTrack(opts = {}) {
  const st = {
    workspaces: opts.workspaces || [{ id: 'ws1', name: 'Nhà mình', ownerEmail: 'lan@example.com', currency: 'VND' }],
    // Users (each one owns a workspace). Passwords are for tests only.
    users: opts.users || [{ id: 'u1', email: 'lan@example.com', password: 'dung', displayName: 'Lan', workspaceId: 'ws1' }],
    disabled: new Set(), // workspaceIds whose owner is disabled
    // FinTrack's own assistant (OpenAI / Gemini / DeepSeek profiles) per workspace, used when X-FinTrack-AI: fintrack.
    profiles: opts.profiles || [{ id: 'p1', name: 'OpenAI', provider: 'openai', model: 'gpt-6-luna', configured: true }, { id: 'p2', name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-flash', configured: false }],
    defaultProfileId: opts.defaultProfileId === undefined ? 'p1' : opts.defaultProfileId,
    sessions: new Map(), // token → workspaceId
    messages: new Map(), // messageId → { conversationId, text, answer }
    receipts: new Map(), // `${messageId}:${index}` → result
    // Drafts awaiting confirmation (FinTrack: Tổng quan → Chờ xác nhận): messageId → { status, source }. opts.noDrafts = old Worker.
    drafts: new Map(),
    reversed: new Set(), // ids of reversed transactions (“huỷ”)
    transcribeText: opts.transcribeText ?? 'ăn trưa năm mươi nghìn',
    // Instance settings (FinTrack: Cài đặt → Tài khoản → “Đăng ký tài khoản”), admins only.
    instance: { registrationOpen: false, maxAccounts: 0, signupsPerIpHour: 5, aiDailyCap: 0, ...opts.instance },
    down: false,
    expireAll: false,
    requests: [],
  };
  const json = (status, body, headers = {}) => ({ status, url: '', headers: { 'content-type': 'application/json', ...headers }, truncated: false, text: body === undefined ? '' : JSON.stringify(body) });
  const cookieOf = (headers) => {
    const m = /fintrack_session=([^;]+)/.exec(String(headers.Cookie || ''));
    return m ? decodeURIComponent(m[1]) : '';
  };
  const mint = (workspaceId) => {
    const token = crypto.randomBytes(16).toString('hex');
    st.sessions.set(token, workspaceId);
    return token;
  };
  /** Like FinTrack's POST /api/assistant/chat: `inbox` plus at least one action → keeps a draft; returns `draft` whenever `inbox` is sent. */
  const keepDraft = (id, body, actions) => {
    if (opts.noDrafts || !body.inbox) return {};
    if (actions.length) st.drafts.set(id, { status: 'pending', source: clone(body.inbox) });
    return { draft: actions.length > 0 };
  };
  const draftView = (id) => {
    const msg = st.messages.get(id);
    const d = st.drafts.get(id);
    return {
      id,
      status: d.status,
      source: d.source,
      actions: msg.answer.actions.map((a, index) => {
        const r = st.receipts.get(`${id}:${index}`);
        return { index, action: r && r.action ? r.action : a, saved: !!r };
      }),
    };
  };

  async function handle(url, init = {}) {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    const body = init.body ? JSON.parse(init.body) : undefined;
    st.requests.push({ method, path: u.pathname + u.search, headers: { ...headers }, body });
    if (st.down) throw apiError('UPSTREAM_ERROR', 'http.fetch: connect ECONNREFUSED', 502);
    const key = `${method} ${u.pathname}`;

    // ── Integration routes: Bearer secret only.
    if (u.pathname.startsWith('/api/integration/')) {
      const okAuth = headers.Authorization === `Bearer ${SECRET}` || (opts.anySecret && /^Bearer .{32,}$/.test(String(headers.Authorization || '')));
      if (!okAuth) return json(401, { error: { code: 'unauthorized', message: 'Sai secret' } });
      if (key === 'GET /api/integration/health') return json(200, { ok: true, version: opts.version || '0.1.0', speechAvailable: true });
      if (key === 'GET /api/integration/workspaces') return json(200, st.workspaces);
      if (key === 'POST /api/integration/accounts') {
        if (opts.noAccountsRoute) return { status: 404, url: '', headers: { 'content-type': 'text/html' }, truncated: false, text: '<html>404</html>' };
        if (st.users.some((x) => x.email === body?.email)) return json(409, { error: { code: 'conflict', message: 'Email này đã có tài khoản' } });
        const workspaceId = `ws${st.workspaces.length + 1}`;
        const user = { id: `u${st.users.length + 1}`, email: body.email, password: body.password, displayName: body.displayName, workspaceId };
        st.users.push(user);
        st.workspaces.push({ id: workspaceId, name: body.displayName, ownerEmail: body.email, currency: 'VND' });
        const token = mint(workspaceId);
        return json(201, { user: { id: user.id, email: user.email, displayName: user.displayName, workspaceId, role: 'owner', isAdmin: st.users.length === 1, mustChangePassword: false }, session: { token, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } });
      }
      // Old Worker without the session route: the router's 404 (not_found), not workspace_not_found.
      if (opts.noSessionRoute && key === 'POST /api/integration/session') return json(404, { error: { code: 'not_found', message: 'Route POST:/api/integration/session not found' } });
      const ws = headers['X-FinTrack-Workspace'];
      if (!ws || !st.workspaces.some((w) => w.id === ws)) return json(404, { error: { code: 'workspace_not_found', message: 'Không có workspace' } });
      if (key === 'POST /api/integration/session') {
        if (st.disabled.has(ws)) return json(403, { error: { code: 'account_disabled', message: 'Tài khoản chủ workspace đã bị khoá. Liên hệ chủ FinTrack.' } });
        const token = mint(ws);
        const owner = st.users.find((x) => x.workspaceId === ws) || { id: 'u1', email: 'lan@example.com', displayName: 'Lan' };
        return json(201, { token, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), user: { id: owner.id, email: owner.email, displayName: owner.displayName, workspaceId: ws, role: 'owner' } });
      }
      if (key === 'POST /api/integration/transcribe') {
        if (!body || !body.audio) return json(400, { error: { code: 'invalid_request', message: 'Thiếu audio' } });
        return json(200, { text: st.transcribeText, model: '@cf/openai/whisper-large-v3-turbo' });
      }
      return json(404, { error: { code: 'not_found', message: 'Không có route' } });
    }

    // ── Regular routes: cookie session. Bearer has no effect here.
    if (key === 'POST /api/auth/login') {
      const user = st.users.find((x) => x.email === (body?.email || 'lan@example.com') && x.password === body?.password);
      if (!user) return json(401, { error: 'Email hoặc mật khẩu không đúng', code: 'unauthorized' });
      if (st.disabled.has(user.workspaceId)) return json(403, { error: 'Tài khoản đã bị khoá. Liên hệ chủ FinTrack.', code: 'account_disabled' });
      const token = mint(user.workspaceId);
      return json(200, { user: { id: user.id, email: user.email, displayName: user.displayName, workspaceId: user.workspaceId, role: 'owner' } }, { 'set-cookie': [`fintrack_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`] });
    }
    if (key === 'POST /api/auth/register') {
      const token = mint('ws1');
      return json(201, { user: { id: 'u1', email: body?.email, displayName: body?.displayName || 'Lan', workspaceId: 'ws1', role: 'owner' } }, { 'set-cookie': [`fintrack_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`] });
    }
    const token = cookieOf(headers);
    if (key === 'POST /api/auth/logout') {
      st.sessions.delete(token);
      return json(200, { ok: true }, { 'set-cookie': ['fintrack_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'] });
    }
    if (!token || !st.sessions.has(token) || st.expireAll) return json(401, { error: 'Chưa đăng nhập' });
    if (key === 'GET /api/auth/session') return json(200, { user: { email: 'lan@example.com', workspaceId: st.sessions.get(token) } });
    if (key === 'GET /api/big') return { status: 200, headers: { 'content-type': 'application/json' }, truncated: true, text: '{"a":' };
    if (key === 'GET /api/transactions') return json(200, { items: [], page: Number(u.searchParams.get('page') || 1) });
    if (key === 'DELETE /api/transactions/t1') return json(204);
    // Like FinTrack's GET / PUT /api/admin/settings: the account owning the session must be an admin (users[].isAdmin,
    // default: the first user); PUT takes any subset of the fields (unknown keys ignored) and returns the settings now in force.
    if (u.pathname === '/api/admin/settings' && (method === 'GET' || method === 'PUT')) {
      if (opts.noAdminSettings) return json(404, { error: 'Không tìm thấy tài nguyên', code: 'not_found' });
      const owner = st.users.find((x) => x.workspaceId === st.sessions.get(token));
      if (!owner || !(owner.isAdmin ?? st.users.indexOf(owner) === 0)) return json(403, { error: 'Chỉ quản trị FinTrack mới quản lý tài khoản.', code: 'forbidden' });
      if (method === 'PUT') {
        const input = body || {};
        const max = { maxAccounts: 1_000_000, signupsPerIpHour: 1000, aiDailyCap: 1000 };
        for (const [k, v] of Object.entries(input)) {
          if (!(k in st.instance)) continue;
          const ok = k === 'registrationOpen' ? typeof v === 'boolean' : Number.isInteger(v) && v >= 0 && v <= max[k];
          if (!ok) return json(400, { error: `Invalid input: ${k}`, code: 'invalid_request' });
        }
        for (const k of Object.keys(st.instance)) if (input[k] !== undefined) st.instance[k] = input[k];
      }
      return json(200, { ...st.instance, accounts: st.users.length });
    }
    const fintrackAI = headers['X-FinTrack-AI'] === 'fintrack';
    if (key === 'GET /api/assistant/settings') {
      const p = st.profiles.find((x) => x.id === st.defaultProfileId) || null;
      // Like FinTrack: OpenAI and Gemini read images; DeepSeek only with a Flash model.
      const supportsImages = !!p && (p.provider !== 'deepseek' || /flash/.test(p.model));
      const base = { profileId: p ? p.id : null, defaultProfileId: st.defaultProfileId, name: p ? p.name : 'Chưa chọn trợ lý', provider: p ? p.provider : 'openai', model: p ? p.model : 'gpt-6-luna', configured: !!(p && p.configured), supportsImages, profiles: st.profiles, client: 'deplao', aiSource: fintrackAI ? 'fintrack' : 'deplao' };
      return json(200, fintrackAI ? base : { ...base, provider: 'deplao', name: decodeURIComponent(headers['X-FinTrack-Assistant'] || '') || 'Trợ lý AI của Deplao', configured: true, supportsImages: false });
    }
    const profileDefault = /^\/api\/assistant\/profiles\/([^/]+)\/default$/.exec(u.pathname);
    if (method === 'POST' && profileDefault) {
      const p = st.profiles.find((x) => x.id === decodeURIComponent(profileDefault[1]));
      if (!p) return json(404, { error: 'Không tìm thấy trợ lý.' });
      if (!p.configured) return json(400, { error: 'Thêm API key trước khi chọn mặc định.' });
      st.defaultProfileId = p.id;
      return json(200, { profileId: p.id, defaultProfileId: p.id, name: p.name, provider: p.provider, model: p.model, configured: true });
    }
    if (key === 'POST /api/assistant/chat') {
      if (headers['X-FinTrack-Client'] !== 'deplao') return json(400, { error: 'Chưa cấu hình trợ lý' });
      if (!body || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.conversationId || '')) return json(400, { error: 'conversationId không hợp lệ' });
      if (fintrackAI) {
        // FinTrack's own assistant answers right away (no 428): "<number>k" → one expense.
        const p = st.profiles.find((x) => x.id === st.defaultProfileId);
        if (!p || !p.configured) return json(400, { error: 'Mở Cài đặt → Trợ lý AI để thêm API key và chọn trợ lý mặc định.' });
        if (body.image !== undefined && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(body.image))) return json(400, { error: 'Ảnh không hợp lệ' });
        // Image: "reads" a 120.000đ receipt; text: "<number>k" → one expense.
        const k = /(\d+)\s*k\b/i.exec(String(body.text || ''));
        // Like FinTrack's prompt: an image without an amount (unclear purpose) is still a draft, with the category left to the user.
        const actions = body.image
          ? [action({ type: 'expense', accountId: 'cash', amount: k ? String(Number(k[1]) * 1000) : '120000', note: 'Hoá đơn (ảnh)', date: TODAY, categoryId: k ? 'food' : null, unsure: k ? [] : ['categoryId'] })]
          : k ? [action({ type: 'expense', accountId: 'cash', categoryId: 'food', amount: String(Number(k[1]) * 1000), note: String(body.text).split('\n').pop(), date: TODAY, unsure: [] })] : [];
        const id = crypto.randomUUID();
        st.messages.set(id, { workspaceId: st.sessions.get(token), conversationId: body.conversationId, text: body.text, answer: { reply: 'Bản nháp từ trợ lý FinTrack.', actions }, model: p.model });
        return json(200, { id, text: body.text, reply: 'Bản nháp từ trợ lý FinTrack.', actions, model: p.model, provider: p.provider, assistantName: p.name, receipts: [], createdAt: new Date().toISOString(), ...keepDraft(id, body, actions) });
      }
      if (!body.delegated) {
        return json(428, { error: 'Cần trợ lý AI của Deplao để trả lời.', code: 'delegate', delegate: { messages: [{ role: 'system', content: 'Bạn là trợ lý FinTrack. JSON schema: …' }, { role: 'user', content: body.text }], maxTokens: 4000 } });
      }
      const m = /\{[\s\S]*\}/.exec(String(body.delegated.output || ''));
      let answer;
      try { answer = m ? JSON.parse(m[0]) : null; } catch { answer = null; }
      if (!answer || typeof answer.reply !== 'string' || !Array.isArray(answer.actions)) {
        return json(502, { error: 'Trợ lý AI của Deplao không trả bản nháp JSON hợp lệ. Chưa ghi giao dịch nào.', code: 'bad_output' });
      }
      const id = crypto.randomUUID();
      const actions = answer.actions.map(action);
      st.messages.set(id, { workspaceId: st.sessions.get(token), conversationId: body.conversationId, text: body.text, answer: { reply: answer.reply, actions }, model: body.delegated.model || 'deplao' });
      return json(200, { id, text: body.text, reply: answer.reply, actions, model: body.delegated.model || 'deplao', provider: 'deplao', receipts: [], createdAt: new Date().toISOString(), ...keepDraft(id, body, actions) });
    }
    // “ok” / “huỷ” in the group (FinTrack apps/api/src/assistant-drafts.ts).
    const draftRoute = /^\/api\/assistant\/drafts\/([^/]+)\/(confirm|dismiss|undo)$/.exec(u.pathname);
    if (method === 'POST' && draftRoute && !opts.noDrafts) {
      const id = decodeURIComponent(draftRoute[1]);
      const msg = st.messages.get(id);
      const d = st.drafts.get(id);
      if (!msg || !d || msg.workspaceId !== st.sessions.get(token)) return json(404, { error: 'Bản nháp không còn (đã xoá cùng lịch sử trợ lý).' });
      const results = [];
      if (draftRoute[2] === 'confirm') {
        if (d.status === 'dismissed') return json(409, { error: 'Bản nháp này đã bỏ qua.' });
        if (draftView(id).actions.every((a) => a.saved)) return json(200, { draft: draftView(id), results, already: true });
        for (const item of draftView(id).actions) {
          if (item.saved) continue;
          const a = { ...item.action, note: item.action.note || d.source.text || 'Từ tin nhóm', date: item.action.date || TODAY };
          if ((a.type === 'expense' || a.type === 'income') && !a.categoryId) results.push({ index: item.index, ok: false, error: 'chưa có danh mục' });
          else if (!a.accountId) results.push({ index: item.index, ok: false, error: 'chưa có ví' });
          else {
            st.receipts.set(`${id}:${item.index}`, { id: `tx${st.receipts.size + 1}`, amount: a.amount, type: a.type, categoryId: a.categoryId, action: a });
            results.push({ index: item.index, ok: true });
          }
        }
        if (draftView(id).actions.every((a) => a.saved)) d.status = 'done';
        return json(200, { draft: draftView(id), results });
      }
      if (draftRoute[2] === 'dismiss') {
        if (d.status === 'pending') d.status = 'dismissed';
        return json(200, { draft: draftView(id) });
      }
      if (d.status === 'dismissed') return json(200, { draft: draftView(id), results, already: true });
      for (const item of draftView(id).actions) {
        if (!item.saved) continue;
        const r = st.receipts.get(`${id}:${item.index}`);
        if (st.reversed.has(r.id)) results.push({ index: item.index, ok: false, error: 'đã được sửa hoặc huỷ trong FinTrack' });
        else {
          st.reversed.add(r.id);
          results.push({ index: item.index, ok: true });
        }
      }
      d.status = 'dismissed';
      return json(200, { draft: draftView(id), results });
    }
    if (key === 'POST /api/assistant/commit') {
      const msg = st.messages.get(body?.messageId);
      if (!msg || msg.workspaceId !== st.sessions.get(token) || !msg.answer.actions[body.actionIndex]) return json(404, { error: 'Không tìm thấy bản nháp.' });
      const rk = `${body.messageId}:${body.actionIndex}`;
      if (st.receipts.has(rk)) return json(200, { saved: true, result: st.receipts.get(rk), replay: true });
      if (st.drafts.get(body.messageId)?.status === 'dismissed') return json(409, { error: 'Bản nháp này đã bỏ qua.' });
      if (!body.action.accountId) return json(400, { error: 'Chọn ví trước khi ghi.' });
      // Like FinTrack's POST /api/transactions: income / expense need a category of the same kind, every transaction needs a date.
      const cashflow = body.action.type === 'expense' || body.action.type === 'income';
      if (cashflow && !BOOTSTRAP.categories.some((c) => c.id === body.action.categoryId && c.kind === body.action.type)) {
        return json(400, { error: 'Danh mục không phù hợp với loại giao dịch' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.action.date || ''))) return json(400, { error: 'Ngày không hợp lệ' });
      const result = { id: `tx${st.receipts.size + 1}`, amount: body.action.amount, type: body.action.type, categoryId: body.action.categoryId, action: body.action };
      st.receipts.set(rk, result);
      const d = st.drafts.get(body.messageId);
      if (d && msg.answer.actions.every((_, i) => st.receipts.has(`${body.messageId}:${i}`))) d.status = 'done';
      return json(200, { saved: true, result });
    }
    return json(404, { error: 'Không tìm thấy' });
  }
  return { handle, state: st };
}

/** Fake ctx.deplao. aiAnswers: queue of aiChat answers (string | function(params) | Error). */
function createFakeDeplao(opts = {}) {
  const storage = new Map();
  const calls = [];
  const sent = [];
  const fintrack = opts.fintrack || createFakeFinTrack(opts.fintrackOpts);
  const aiQueue = [...(opts.aiAnswers || [])];
  const messages = new Map(Object.entries(opts.messages || {}));
  const media = opts.media || {};
  /** Hosts that do not resolve yet, e.g. a Cloudflare custom domain whose DNS is not ready. */
  const unreachable = new Set(opts.unreachable || []);

  const deplao = {
    storage: {
      get: async (k) => (storage.has(k) ? clone(storage.get(k)) : null),
      set: async (k, v) => { storage.set(k, clone(v)); return { ok: true }; },
      delete: async (k) => ({ deleted: storage.delete(k) }),
      list: async (prefix = '') => [...storage.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value: clone(value), updated_at: Date.now() })),
    },
    http: {
      fetch: async (url, init) => {
        calls.push({ op: 'http.fetch', url, init: clone(init) });
        if (media[url]) {
          const m = media[url];
          return { status: m.status || 200, url, headers: m.headers || { 'content-type': 'audio/mp4' }, truncated: !!m.truncated, base64: m.base64, text: m.text };
        }
        const host = new URL(url).host;
        if (unreachable.has(host)) throw apiError('UPSTREAM_ERROR', `http.fetch: getaddrinfo ENOTFOUND ${host}`, 502);
        return fintrack.handle(url, init);
      },
    },
    ai: {
      aiChat: async (params) => {
        calls.push({ op: 'aiChat', params: clone(params) });
        const next = aiQueue.length ? aiQueue.shift() : opts.aiDefault;
        const answer = typeof next === 'function' ? next(params) : next;
        if (answer instanceof Error) throw answer;
        if (answer === undefined) throw apiError('CONFLICT', 'Chưa có trợ lý AI mặc định', 409);
        // Like Deplao's POST /ai/chat: includes token counts.
        return { result: answer, total_tokens: 10, prompt_tokens: 7, completion_tokens: 3 };
      },
      getDefaultAiAssistant: async () => (opts.noAssistant ? null : { id: 'ai1', name: 'Trợ lý chính', platform: 'openai', model: 'gpt-4o-mini', enabled: true, has_api_key: true }),
      // List for the assistant picker (scope ai:use). opts.assistants = null → older Deplao without this function (NOT_FOUND).
      listAiAssistantOptions: async () => {
        calls.push({ op: 'listAiAssistantOptions' });
        if (opts.assistants === null) throw apiError('NOT_FOUND', 'Không có hàm "listAiAssistantOptions"', 404);
        return clone(opts.assistants || [
          { id: 'ai1', name: 'Trợ lý chính', platform: 'openai', model: 'gpt-4o-mini', enabled: true, is_default: true },
          { id: 'ai2', name: 'Kế toán Đào', platform: 'gemini', model: 'gemini-2.5-flash', enabled: true, is_default: false },
          { id: 'ai3', name: 'Cũ', platform: 'openai', model: 'gpt-4o', enabled: false, is_default: false },
        ]);
      },
    },
    chat: {
      sendMessage: async (p) => {
        calls.push({ op: 'sendMessage', params: clone(p) });
        sent.push(clone(p));
        return { channel: 'zalo', thread_id: p.threadId, sent: [{ type: 'text', msg_id: `sent${sent.length}`, cli_msg_id: `cli${sent.length}` }] };
      },
      getMessage: async (p) => {
        calls.push({ op: 'getMessage', params: clone(p) });
        const row = messages.get(String(p.msgId));
        if (!row) throw apiError('NOT_FOUND', `Không tìm thấy tin nhắn ${p.msgId}`, 404);
        return clone(row);
      },
      downloadMessageMedia: async (p) => {
        calls.push({ op: 'downloadMessageMedia', params: clone(p) });
        const row = messages.get(String(p.msgId));
        if (!row || !row.media) throw apiError('NOT_FOUND', 'Tin này không có file', 404);
        return clone(row.media);
      },
    },
    accounts: {
      listAccounts: async () => [{ id: 'acc1', channel: 'zalo', display_name: 'Chủ nhà', phone: '', online: true, avatar_url: 'https://s120-ava-talk.zadn.vn/me.jpg' }, { id: 'fb1', channel: 'facebook', display_name: 'FB', online: true, avatar_url: 'https://scontent.fbcdn.net/x.jpg' }],
    },
    system: { info: async () => ({ appVersion: '26.11.0', apiVersion: 1, pluginId: 'io.github.babyvibe.fintrack', pluginVersion: '0.1.0', runtime: 'local' }) },
  };
  if (opts.cloudflare) deplao.cloudflare = opts.cloudflare;
  return { deplao, storage, calls, sent, fintrack, aiQueue, unreachable, messages };
}

/** FinTrack already deployed (URL + secret); no workspace linked yet (auto-linked when there is only one). */
async function seedDeployed(deplao) {
  await deplao.storage.set('integration.secret', SECRET);
  await deplao.storage.set('deploy', { workerName: 'fintrack', url: BASE_URL, deployedAt: 1 });
}

/** Flat run.trigger, as the Deplao engine passes it to a node (trigger.message, Zalo). */
function textTrigger(overrides = {}) {
  return {
    fromId: 'u2', fromName: 'Lan', fromPhone: '', content: 'Ăn trưa 50k', images: [], threadId: 'g1', threadType: 1,
    isGroup: true, groupName: 'Chi tiêu', msgId: 'm100', cliMsgId: 'c100', timestamp: Date.UTC(2026, 9, 20, 5, 0, 0),
    isSelf: false, zaloId: 'acc1', ...overrides,
  };
}

/** The assistant's JSON answer (the output sent back to FinTrack). */
const answerJson = (actions, reply = 'Bản nháp chi ăn uống 50.000 ₫; kiểm tra ví rồi xác nhận.') => JSON.stringify({ reply, actions });

module.exports = { createFakeDeplao, createFakeFinTrack, seedDeployed, textTrigger, answerJson, SECRET, BASE_URL };
