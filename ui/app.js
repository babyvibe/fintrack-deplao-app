/* global deplao, FT */
/**
 * Entry page + Options page of the FinTrack app (CONTRACTS §3.1, §3.4).
 *  - No hash (entry page): quick check → if ready, go straight to the FinTrack UI
 *    (vendor/fintrack/app/index.html); otherwise show the setup page (same content as the Options page).
 *  - #options (Options page): Share FinTrack (public address, public sign-up), FinTrack on Cloudflare (deploy / update /
 *    custom domain / address) and FinTrack accounts.
 *    Drafts from groups wait inside FinTrack (Overview → "Chờ xác nhận"); recording spending from Zalo messages is
 *    configured on the FinTrack node in Workflow (mode, replies, voice, photos, assistant); the AI assistant is picked in
 *    FinTrack (Settings → AI assistant).
 * No framework: each section re-renders its whole block when the state changes (FT.mount keeps the input being typed in).
 */
(function () {
  'use strict';
  const h = FT.h;
  const HOMEPAGE = 'https://github.com/babyvibe/fintrack-deplao-app';

  const S = {
    status: null,
    /** Status comes from the quick check (entry page): no Cloudflare data yet → that section shows a skeleton. */
    quick: false,
    statusError: null,
    /** Connected to the Deplao SDK (deplao.ready). */
    started: false,
    deploy: { job: null, busy: false, error: null, rotate: false },
    /** Custom domain: the attach form opens right under its row (editing), the account's zones load lazily, attaching runs as a background job (job). */
    domain: { editing: false, zones: null, zonesBusy: false, zonesError: null, sub: 'fintrack', zone: '', busy: '', error: null, job: null },
    ws: { busy: false, error: null },
    /**
     * "Chia sẻ FinTrack": the shareSettings answer ({ access, settings, message }), read after each status load while
     * FinTrack answers (seq drops a stale read); busy = 'open' | 'max' while saving; maxDraft = the limit being typed.
     */
    share: { data: null, loading: false, error: null, busy: '', saveError: null, maxDraft: null, seq: 0 },
  };

  const optionsMode = () => location.hash === '#options';
  const secEl = (id) => document.getElementById(`sec-${id}`);
  const bodyOf = (id) => secEl(id).querySelector('.step__body');

  function setSec(id, state, label) {
    const el = secEl(id);
    el.dataset.state = state;
    const badge = el.querySelector('.step__badge');
    badge.className = `step__badge badge badge--${state}`;
    badge.textContent = label || '';
  }

  const strong = (t) => h('strong', null, t);
  const muted = (t) => h('span', { class: 'muted' }, t);

  /** Initials of an account name. */
  function avatarNode(name) {
    return h('span', { class: 'avatar', 'aria-hidden': 'true' }, FT.initials(name));
  }

  function alertBox(kind, content, actions) {
    const icon = { info: 'ℹ️', warn: '⚠️', error: '⛔', ok: '✅' }[kind] || 'ℹ️';
    return h('div', { class: `alert alert--${kind}`, role: kind === 'error' ? 'alert' : null },
      h('span', { class: 'alert__icon', 'aria-hidden': 'true' }, icon),
      h('div', { class: 'alert__text' }, content, actions ? h('div', { class: 'alert__actions' }, actions) : null));
  }

  const errorBox = (err) => (err ? alertBox('error', err.message || String(err)) : null);
  const row = (label, value) => h('div', { class: 'kv' }, h('div', { class: 'kv__k' }, label), h('div', { class: 'kv__v' }, value));
  const skeleton = (n) => h('div', { class: 'skeleton-list', 'aria-busy': 'true' }, Array.from({ length: n || 2 }, () => h('div', { class: 'skeleton' })));
  const cacheHint = () => h('span', { class: 'hint' }, 'Deplao lưu kết quả kiểm tra Cloudflare khoảng 1 phút: vừa sửa xong thì đợi chút rồi bấm “Kiểm tra lại”.');

  /** opts: { kind, small, disabled, busy, busyLabel, title, ariaLabel (for buttons repeated per row: "Mở" → "Mở tài khoản …"), id, hidden } */
  function button(label, onClick, opts) {
    const o = opts || {};
    return h('button', {
      id: o.id || null,
      class: `btn ${o.kind ? `btn--${o.kind}` : ''} ${o.small ? 'btn--sm' : ''}`.trim(),
      type: 'button',
      hidden: !!o.hidden,
      disabled: !!o.disabled || !!o.busy,
      title: o.title || null,
      'aria-label': o.ariaLabel || null,
      onclick: onClick,
    }, o.busy ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null, o.busy && o.busyLabel ? o.busyLabel : label);
  }

  function stepList(steps) {
    const icon = { running: '⏳', done: '✓', warn: '⚠', error: '✕' };
    return h('ol', { class: 'progress' }, (steps || []).map((s) =>
      h('li', { class: `progress__item progress__item--${s.status}` },
        h('span', { class: 'progress__icon', 'aria-hidden': 'true' }, icon[s.status] || '•'),
        h('span', null, s.detail || s.id))));
  }

  // ─── Open the FinTrack UI ───────────────────────────────────────────────

  /** hash: the FinTrack screen to open (e.g. "add-account" = the sign-in / create-account screen while signed in). */
  function appUrl(hash) {
    const url = new URL(`../${(S.status && S.status.appPath) || 'vendor/fintrack/app/index.html'}`, location.href);
    url.hash = typeof hash === 'string' ? hash : '';
    return url.href;
  }

  /** The FinTrack UI shows an update notice when the Worker on Cloudflare runs an older bundle than the one shipped with the app. */
  function rememberUpdate(st) {
    try {
      sessionStorage.setItem('fintrack-update-available', st && st.fintrack && st.fintrack.updateAvailable ? '1' : '');
    } catch { /* no sessionStorage: skip the notice */ }
  }

  function openApp(hash) {
    rememberUpdate(S.status);
    location.href = appUrl(hash);
  }

  // ─── Top-of-page notice ─────────────────────────────────────────────────

  const REASONS = {
    not_deployed: ['info', 'FinTrack chưa được triển khai lên Cloudflare. Bắt đầu ở mục “FinTrack trên Cloudflare” bên dưới.'],
    unreachable: ['warn', 'Chưa kết nối được FinTrack trên Cloudflare. Xem chi tiết ở mục bên dưới; vừa triển khai thì đợi 1 phút rồi bấm “Kiểm tra lại”.'],
    bundle_incomplete: ['warn', 'Gói FinTrack đi kèm ứng dụng thiếu giao diện (vendor/fintrack/app), nên chưa mở được FinTrack trong Deplao. Cài bản phát hành đầy đủ của ứng dụng.'],
  };

  function renderHeader() {
    const st = S.status;
    document.getElementById('page-title').textContent = optionsMode() ? 'FinTrack · Tuỳ chọn' : 'Thiết lập FinTrack';
    const open = document.getElementById('open-app');
    open.disabled = !(st && st.ready);
    open.title = st && st.ready ? '' : 'Hoàn tất thiết lập để mở FinTrack';
    const el = document.getElementById('notice');
    if (S.statusError) {
      FT.mount(el, alertBox('error', ['Không kiểm tra được trạng thái: ', S.statusError.message], S.started ? button('Thử lại', () => refresh(), { small: true }) : null));
    } else if (!st) {
      FT.mount(el, alertBox('info', 'Đang kiểm tra FinTrack…'));
    } else if (st.reason && REASONS[st.reason]) {
      FT.mount(el, alertBox(REASONS[st.reason][0], REASONS[st.reason][1]));
    } else if (st.ready && !optionsMode()) {
      FT.mount(el, alertBox('ok', 'FinTrack đã sẵn sàng.', button('Mở FinTrack', () => openApp(), { kind: 'primary', small: true })));
    } else {
      FT.mount(el, null);
    }
    if (st) {
      const p = st.plugin || {};
      const d = st.deplao || {};
      document.getElementById('foot-version').textContent = `FinTrack cho Deplao ${p.version || ''}${d.appVersion ? ` · Deplao ${d.appVersion}` : ''} ·`;
    }
  }

  // ─── Share FinTrack ──────────────────────────────────────────────────────

  const MAX_ACCOUNTS = 1000000;

  /**
   * "Chia sẻ FinTrack": the address to send (custom domain in use, else workers.dev) and FinTrack's public sign-up (the
   * same settings as FinTrack → Cài đặt → Tài khoản → "Đăng ký tài khoản"), changed here by the open admin account.
   */
  function renderShare() {
    const sec = secEl('share');
    const ft = (S.status && S.status.fintrack) || {};
    const show = !!(ft.url && ft.health && ft.health.ok);
    sec.hidden = !show;
    if (!show) return;
    const set = S.share.data && S.share.data.access === 'admin' ? S.share.data.settings : null;
    const kv = [row('Địa chỉ', shareAddress(ft)), row('Đăng ký', signupValue(set))];
    if (set) kv.push(row('Tối đa tài khoản', maxAccountsValue(set)));
    FT.mount(bodyOf('share'), h('div', { class: 'kv-list' }, kv));
    if (set) setSec('share', set.registrationOpen ? 'done' : 'todo', set.registrationOpen ? 'Đang mở đăng ký' : 'Đăng ký đang tắt');
    else setSec('share', 'todo', '');
  }

  function shareAddress(ft) {
    const source = { domain: 'tên miền riêng', settings: 'từ ô Địa chỉ FinTrack trong Cài đặt ứng dụng' }[ft.urlSource] || 'workers.dev';
    return h('div', { class: 'stack-sm' },
      h('div', { class: 'share-address' },
        h('a', { href: '#', class: 'link', onclick: (e) => { e.preventDefault(); FT.openExternal(ft.url); } }, ft.url),
        button('Sao chép', () => onCopyAddress(ft.url), { small: true, ariaLabel: `Sao chép địa chỉ ${ft.url}` })),
      muted(source));
  }

  const saveErrorLine = (what) => (S.share.saveError && S.share.saveError.what === what ? h('span', { class: 'text-error' }, S.share.saveError.message) : null);

  /** "Đăng ký" row: the switch with one line on what it does; otherwise why it cannot be changed from here. */
  function signupValue(set) {
    const sh = S.share;
    if (sh.error) {
      return h('div', { class: 'stack-sm' },
        h('span', { class: 'text-error' }, sh.error.message),
        h('span', null, button('Thử lại', loadShare, { small: true, busy: sh.loading })));
    }
    if (!sh.data) return skeleton(1);
    if (!set) {
      const notAdmin = sh.data.access === 'not_admin';
      return h('div', { class: 'stack-sm' },
        h('span', { class: notAdmin ? 'text-warn' : 'muted' }, sh.data.message),
        notAdmin ? h('span', { class: 'hint' }, 'Chuyển sang tài khoản quản trị (tài khoản tạo đầu tiên) ở mục Tài khoản FinTrack để bật đăng ký.') : null);
    }
    return h('div', { class: 'stack-sm' },
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', role: 'switch', id: 'share-open', checked: set.registrationOpen, disabled: !!sh.busy, onchange: (e) => saveShare({ registrationOpen: e.target.checked }, 'open') }),
        h('span', null, 'Cho người khác tự tạo tài khoản')),
      h('span', { class: 'hint' }, 'Mỗi người tự tạo tài khoản ở trang đăng nhập và có sổ tài chính riêng, tách biệt với sổ của bạn.'),
      set.registrationOpen ? null : h('span', { class: 'hint' }, 'Đang tắt: địa chỉ này chỉ để đăng nhập các tài khoản đã có.'),
      sh.busy === 'open' ? muted('Đang lưu…') : null,
      saveErrorLine('open'));
  }

  /** The limit being typed → integer, or NaN when it is not a whole number ≥ 0. */
  const parseMax = (text) => (/^\d{1,7}$/.test(String(text).trim()) ? Number(String(text).trim()) : NaN);
  const maxChanged = (set) => S.share.maxDraft !== null && parseMax(S.share.maxDraft) !== set.maxAccounts;

  function maxAccountsValue(set) {
    const sh = S.share;
    const full = set.registrationOpen && set.maxAccounts > 0 && set.accounts !== null && set.accounts >= set.maxAccounts;
    return h('div', { class: 'stack-sm' },
      h('div', { class: 'share-max' },
        h('input', {
          id: 'share-max', class: 'input', type: 'number', min: '0', max: String(MAX_ACCOUNTS), step: '1', inputmode: 'numeric',
          value: sh.maxDraft === null ? String(set.maxAccounts) : sh.maxDraft, 'aria-label': 'Tối đa tài khoản', readonly: !!sh.busy,
          oninput: (e) => {
            sh.maxDraft = e.target.value;
            const save = document.getElementById('share-max-save');
            if (save) save.hidden = !maxChanged(set);
          },
          onkeydown: (e) => {
            if (e.key === 'Enter') { e.preventDefault(); onSaveMax(); }
            if (e.key === 'Escape') { sh.maxDraft = null; sh.saveError = null; renderShare(); }
          },
        }),
        button('Lưu', onSaveMax, { id: 'share-max-save', small: true, kind: 'primary', hidden: !maxChanged(set), busy: sh.busy === 'max', busyLabel: 'Đang lưu…' })),
      h('span', { class: 'hint' }, `${set.accounts !== null ? `Hiện có ${set.accounts} tài khoản. ` : ''}0 = không giới hạn.`),
      full ? h('span', { class: 'text-warn' }, 'Đã đủ số tài khoản nên người mới chưa tạo được. Tăng số này để nhận thêm người.') : null,
      saveErrorLine('max'));
  }

  async function loadShare() {
    const sh = S.share;
    const seq = ++sh.seq;
    sh.loading = true;
    sh.error = null;
    renderShare();
    const res = await FT.call('shareSettings');
    if (seq !== sh.seq) return;
    sh.loading = false;
    sh.data = res.ok ? { access: res.access, settings: res.settings || null, message: res.message || '' } : null;
    sh.error = res.ok ? null : res.error;
    if (res.ok) sh.saveError = null; // fresh settings: an earlier save error no longer applies
    renderShare();
  }

  async function saveShare(patch, what) {
    const sh = S.share;
    sh.busy = what;
    sh.saveError = null;
    renderShare();
    const res = await FT.call('setShareSettings', patch);
    sh.busy = '';
    if (res.ok) {
      sh.seq++; // a read still in flight must not overwrite what was just saved
      sh.loading = false;
      sh.error = null;
      sh.data = { access: res.access, settings: res.settings, message: '' };
      if (what === 'max') sh.maxDraft = null;
      renderShare();
      const open = res.settings.registrationOpen;
      FT.toast(what === 'max' ? 'Đã lưu tối đa tài khoản' : open ? 'Đã bật: người khác tự tạo được tài khoản' : 'Đã tắt: chỉ tài khoản đã có đăng nhập được', 'success');
      return;
    }
    sh.saveError = { what, message: res.error.message };
    renderShare();
    // FinTrack refused (no longer an admin, session gone): read again so the section shows why.
    if (res.error.code === 'FT_FORBIDDEN' || res.error.code === 'NOT_SIGNED_IN') loadShare();
  }

  function onSaveMax() {
    const sh = S.share;
    const set = sh.data && sh.data.settings;
    if (!set || sh.busy || sh.maxDraft === null) return;
    const n = parseMax(sh.maxDraft);
    if (!Number.isInteger(n) || n > MAX_ACCOUNTS) {
      sh.saveError = { what: 'max', message: 'Nhập số nguyên từ 0 đến 1.000.000 (0 = không giới hạn).' };
      renderShare();
      return;
    }
    if (n === set.maxAccounts) {
      sh.maxDraft = null;
      sh.saveError = null;
      renderShare();
      return;
    }
    saveShare({ maxAccounts: n }, 'max');
  }

  async function onCopyAddress(url) {
    const copied = await FT.copyText(url);
    FT.toast(copied ? `Đã sao chép ${url}` : 'Không sao chép được: chọn địa chỉ rồi sao chép thủ công.', copied ? 'success' : 'error');
  }

  // ─── Cloudflare & deploy ─────────────────────────────────────────────────

  function renderCloud() {
    const el = bodyOf('cloud');
    const st = S.status;
    if (!st || (S.quick && !st.cloudflare)) { setSec('cloud', 'todo', ''); FT.mount(el, skeleton(3)); return; }
    const cf = st.cloudflare || {};
    const b = st.bundle || {};
    const ft = st.fintrack || {};
    const parts = [];
    let canDeploy = true;

    if (cf.supported === false) {
      canDeploy = false;
      parts.push(alertBox('warn', 'Bản Deplao đang dùng chưa hỗ trợ triển khai lên Cloudflare cho ứng dụng. Cập nhật Deplao lên bản mới nhất.'));
    } else if (cf.error) {
      canDeploy = false;
      parts.push(alertBox('error', cf.error.message));
    } else if (!cf.connected) {
      canDeploy = false;
      parts.push(alertBox('warn', ['Deplao chưa kết nối Cloudflare. Mở ', strong('Cài đặt → Internet & Đám mây → Kết nối Cloudflare'), ', kết nối xong bấm “Kiểm tra lại”.', cacheHint()]));
    } else if (cf.missing && cf.missing.length) {
      canDeploy = false;
      parts.push(alertBox('warn', ['Token Cloudflare còn thiếu quyền ', strong(cf.missing.join(', ')), '. Tạo lại token ở Cài đặt → Internet & Đám mây → Kết nối Cloudflare (link mẫu đã có sẵn quyền Worker và D1).', cacheHint()]));
    }
    if (cf.workerError) parts.push(alertBox('warn', ['Không kiểm tra được Worker “fintrack” trên Cloudflare: ', cf.workerError.message]));
    if (ft.updateAvailable) {
      // Same version (e.g. 0.1.0) but a different bundle than the last deploy → don't mention version numbers.
      const newer = ft.health && ft.health.version && ft.health.version !== b.version
        ? `FinTrack v${b.version} mới hơn bản đang chạy (v${ft.health.version})`
        : 'bản FinTrack mới hơn bản đang chạy trên Cloudflare';
      parts.push(alertBox('info', [`Ứng dụng có ${newer}. Bấm `, strong('Cập nhật FinTrack'), ' để dùng tính năng mới, dữ liệu giữ nguyên.']));
    }

    const kv = [];
    if (cf.connected) {
      kv.push(row('Tài khoản Cloudflare', cf.accountName || cf.accountId || 'Đã kết nối'));
      kv.push(row('workers.dev', cf.workersSubdomain
        ? (/\.workers\.dev$/.test(cf.workersSubdomain) ? cf.workersSubdomain : `${cf.workersSubdomain}.workers.dev`)
        : muted('chưa bật: bật trong Cloudflare (Workers & Pages) hoặc nhập Địa chỉ FinTrack trong Cài đặt ứng dụng')));
      if (cf.worker) kv.push(row('Worker “fintrack”', cf.worker.exists ? `Đã có · sửa lần cuối ${FT.dateTime(cf.worker.modifiedOn) || '—'}` : 'Chưa có'));
      if (cf.worker && cf.worker.exists) kv.push(row('Tên miền riêng', domainValue(st)));
    }
    if (b.present) kv.push(row('Gói FinTrack đi kèm', [`v${b.version || '?'} · ${b.migrationCount} migration · `, b.hasApp ? 'có giao diện' : h('span', { class: 'text-warn' }, 'thiếu giao diện (app)')]));
    else {
      canDeploy = false;
      kv.push(row('Gói FinTrack đi kèm', h('span', { class: 'text-warn' }, 'Thiếu: cài bản phát hành đầy đủ của ứng dụng')));
    }
    if (ft.url) {
      const health = ft.health && ft.health.ok
        ? h('span', { class: 'text-ok' }, `Đang chạy${ft.health.version ? ` · v${ft.health.version}` : ''}`)
        : ft.error ? h('span', { class: 'text-error' }, ft.error.message)
          : !ft.hasSecret ? muted('chưa có secret tích hợp, triển khai để đặt') : muted('chưa kiểm tra');
      const source = { settings: 'từ ô Địa chỉ FinTrack trong Cài đặt ứng dụng', domain: 'tên miền riêng', deploy: 'workers.dev', cloudflare: 'workers.dev' }[ft.urlSource] || '';
      const healthy = !!(ft.health && ft.health.ok);
      kv.push(row('Địa chỉ', h('div', { class: 'stack-sm' },
        h('a', { href: '#', class: 'link', onclick: (e) => { e.preventDefault(); FT.openExternal(ft.url); } }, ft.url),
        source ? muted(source) : null,
        health,
        ft.domainDown ? h('span', { class: 'text-warn' }, `Tên miền ${ft.domainDown} chưa trả lời nên tạm dùng workers.dev. Bấm “Kiểm tra” cạnh tên miền sau ít phút.`) : null,
        !healthy && ft.urlSource === 'settings' ? h('span', { class: 'hint' }, 'Gõ sai hoặc tên miền chưa trỏ tới Worker? Sửa ô Địa chỉ FinTrack trong Cài đặt ứng dụng, hoặc để trống để dùng workers.dev / tên miền riêng gắn ở trên.') : null)));
      if (ft.health && ft.health.ok) {
        kv.push(row('Ghi âm → chữ', ft.health.speech
          ? h('span', { class: 'text-ok' }, 'Sẵn sàng (Workers AI)')
          : h('span', { class: 'text-warn' }, 'Worker chưa có Workers AI: triển khai lại để gắn binding AI.')));
      }
    }
    if (kv.length) parts.push(h('div', { class: 'kv-list' }, kv));
    if (S.domain.editing && cf.worker && cf.worker.exists) parts.push(domainForm());
    const djob = S.domain.job;
    if (djob && (djob.state === 'running' || Date.now() - (djob.finishedAt || 0) < 10 * 60_000)) {
      parts.push(h('div', { class: 'job', 'aria-live': 'polite' },
        h('div', { class: 'job__title' }, djob.state === 'running' ? 'Đang gắn tên miền…' : djob.state === 'done' ? 'Gắn tên miền' : 'Gắn tên miền lỗi'),
        stepList(djob.steps)));
      if (djob.state === 'error' && djob.error) parts.push(errorBox(djob.error));
    }

    const job = S.deploy.job;
    if (job && (job.state === 'running' || Date.now() - (job.finishedAt || 0) < 10 * 60_000)) {
      parts.push(h('div', { class: 'job', 'aria-live': 'polite' },
        h('div', { class: 'job__title' }, job.state === 'running' ? 'Đang triển khai…' : job.state === 'done' ? 'Lần triển khai gần nhất' : 'Triển khai lỗi'),
        stepList(job.steps)));
      if (job.state === 'error' && job.error && job.error.code !== 'NEEDS_CONFIRM') parts.push(errorBox(job.error));
    }
    if (S.deploy.error) parts.push(errorBox(S.deploy.error));

    const exists = !!(cf.worker && cf.worker.exists);
    const running = !!(job && job.state === 'running');
    // A secret from the app settings is always deployed to the Worker unchanged; to change it, edit the settings.
    const secretFromSettings = ft.secretSource === 'settings';
    parts.push(h('div', { class: 'actions' },
      button(exists ? 'Cập nhật FinTrack' : 'Triển khai FinTrack', onDeploy, { kind: exists && !ft.updateAvailable ? '' : 'primary', disabled: !canDeploy, busy: S.deploy.busy || running, busyLabel: running ? 'Đang triển khai…' : 'Đang kiểm tra…' }),
      ft.url ? button('Mở bằng trình duyệt', () => FT.openExternal(ft.url), { kind: 'ghost' }) : null,
      h('label', { class: 'check check--inline', title: secretFromSettings ? 'Secret đang lấy từ Cài đặt ứng dụng, đổi ở đó' : 'Đặt secret tích hợp mới cho Worker (secret cũ hết hiệu lực)' },
        h('input', { type: 'checkbox', checked: S.deploy.rotate && !secretFromSettings, disabled: secretFromSettings, onchange: (e) => { S.deploy.rotate = e.target.checked; } }),
        h('span', null, 'Tạo secret tích hợp mới'))));

    FT.mount(el, parts);
    const healthy = !!(ft.health && ft.health.ok);
    if (healthy) setSec('cloud', ft.updateAvailable ? 'warn' : 'done', ft.updateAvailable ? 'Có bản mới' : 'Đang chạy');
    else if (running) setSec('cloud', 'todo', 'Đang triển khai');
    else setSec('cloud', canDeploy ? 'todo' : 'warn', canDeploy ? 'Chưa triển khai' : 'Cần xử lý');
  }

  // ─── Custom domain ───────────────────────────────────────────────────────

  /** Value of the "Tên miền riêng" (custom domain) row: hostnames attached to the Worker (in use / waiting for DNS / unused) + attach button. */
  function domainValue(st) {
    const dm = (st.cloudflare && st.cloudflare.domains) || null;
    if (!dm || !dm.supported) return muted('Cập nhật Deplao lên bản mới nhất để gắn tên miền ngay tại đây.');
    if (dm.error) return h('div', { class: 'stack-sm' }, h('span', { class: 'text-warn' }, dm.error.message), button('Thử lại', () => refresh(), { small: true }));
    const list = dm.list || [];
    const cur = st.domain;
    const d = S.domain;
    const jobRunning = !!(d.job && d.job.state === 'running');
    const lines = list.map((x) => {
      const using = !!(cur && cur.hostname === x.hostname);
      const state = using && cur.verifiedAt
        ? h('span', { class: 'text-ok' }, 'Đang dùng')
        : using ? h('span', { class: 'text-warn' }, 'Chờ DNS và chứng chỉ') : muted('Chưa dùng');
      return h('div', { class: 'domain-line' },
        h('a', { href: '#', class: 'link', onclick: (e) => { e.preventDefault(); FT.openExternal(`https://${x.hostname}`); } }, x.hostname),
        state,
        h('span', { class: 'domain-line__actions' },
          using && cur.verifiedAt ? null : button(using ? 'Kiểm tra' : 'Dùng địa chỉ này', () => onDomainUse(x.hostname), { small: true, busy: d.busy === `use:${x.hostname}`, disabled: !!d.busy || jobRunning }),
          button('Gỡ', () => onDomainDetach(x.hostname), { small: true, kind: 'ghost', busy: d.busy === `detach:${x.hostname}`, disabled: !!d.busy || jobRunning, ariaLabel: `Gỡ tên miền ${x.hostname}` })));
    });
    return h('div', { class: 'stack-sm' },
      lines.length ? lines : muted('Chưa có. FinTrack đang chạy ở workers.dev.'),
      d.error && !d.editing ? h('span', { class: 'text-error' }, d.error.message) : null,
      !lines.length && !d.editing && !jobRunning ? button('Gắn tên miền', onDomainOpen, { small: true }) : null);
  }

  /** Domain attach form, opened right under the row: subdomain + a picker for the Cloudflare account's zones. */
  function domainForm() {
    const d = S.domain;
    const close = () => { d.editing = false; d.error = null; renderCloud(); };
    if (!d.zones) {
      return h('div', { class: 'domain-form' }, d.zonesError
        ? alertBox('error', d.zonesError.message, [button('Thử lại', loadZones, { small: true }), button('Huỷ', close, { small: true, kind: 'ghost' })])
        : skeleton(1));
    }
    if (!d.zones.length) {
      return h('div', { class: 'domain-form' }, alertBox('warn', 'Tài khoản Cloudflare đã kết nối chưa có tên miền nào. Thêm tên miền vào Cloudflare trước (Add a domain), rồi bấm Tải lại.',
        [button('Tải lại', loadZones, { small: true, busy: d.zonesBusy }), button('Huỷ', close, { small: true, kind: 'ghost' })]));
    }
    if (!d.zones.some((z) => z.name === d.zone)) d.zone = d.zones[0].name;
    const preview = () => `https://${d.sub || 'tên-con'}.${d.zone}`;
    return h('div', { class: 'domain-form' },
      h('div', { class: 'domain-form__row' },
        h('input', {
          id: 'domain-sub', class: 'input domain-form__sub', maxlength: '63', value: d.sub, placeholder: 'fintrack', 'aria-label': 'Tên con',
          autocomplete: 'off', spellcheck: 'false',
          oninput: (e) => { d.sub = e.target.value.trim().toLowerCase(); const p = document.getElementById('domain-preview'); if (p) p.textContent = preview(); },
        }),
        h('span', { class: 'domain-form__dot', 'aria-hidden': 'true' }, '.'),
        h('select', { id: 'domain-zone', class: 'input', 'aria-label': 'Tên miền', onchange: (e) => { d.zone = e.target.value; const p = document.getElementById('domain-preview'); if (p) p.textContent = preview(); } },
          d.zones.map((z) => h('option', { value: z.name, selected: z.name === d.zone }, z.name)))),
      h('span', { class: 'hint' }, ['Địa chỉ mới: ', h('strong', { id: 'domain-preview' }, preview()), '. Cloudflare tự tạo bản ghi DNS và chứng chỉ (thường 1 đến 5 phút); Deplao sẽ hỏi bạn xác nhận. Chỉ dùng tên chưa có bản ghi DNS.']),
      errorBox(d.error),
      h('div', { class: 'actions' },
        button('Gắn tên miền', onDomainAttach, { kind: 'primary', busy: d.busy === 'attach', busyLabel: 'Đang gửi…' }),
        button('Huỷ', close, { kind: 'ghost', disabled: d.busy === 'attach' })));
  }

  async function loadZones() {
    const d = S.domain;
    d.zonesBusy = true;
    d.zonesError = null;
    renderCloud();
    const res = await FT.call('domainZones');
    d.zonesBusy = false;
    if (res.ok) d.zones = res.zones || [];
    else d.zonesError = res.error;
    renderCloud();
  }

  function onDomainOpen() {
    S.domain.editing = true;
    S.domain.error = null;
    renderCloud();
    if (!S.domain.zones) loadZones();
  }

  async function onDomainAttach() {
    const d = S.domain;
    d.error = null;
    d.busy = 'attach';
    renderCloud();
    const res = await FT.call('domainAttach', { sub: d.sub, zone: d.zone });
    d.busy = '';
    if (!res.ok) { d.error = res.error; renderCloud(); return; }
    d.editing = false;
    await pollDomainJob(res.job);
  }

  let domainPolling = false;
  async function pollDomainJob(job) {
    if (domainPolling) return;
    domainPolling = true;
    try {
      let attached = false;
      const final = await FT.pollJob(job, (j) => {
        S.domain.job = j;
        renderCloud();
        // Attached (waiting for DNS + certificate): reload the status so the domain row shows the new hostname right away.
        if (!attached && (j.steps || []).some((x) => x.id === 'attach' && x.status === 'done')) {
          attached = true;
          refresh();
        }
      }, 2000);
      S.domain.job = final;
      if (final.state === 'done') FT.toast(final.result && final.result.verified ? `Đã chuyển FinTrack sang https://${final.result.hostname}` : 'Đã gắn tên miền, Cloudflare đang tạo DNS và chứng chỉ', final.result && final.result.verified ? 'success' : 'info');
      else if (final.error) FT.toast(final.error.message, 'error');
    } finally {
      domainPolling = false;
    }
    refresh();
  }

  async function onDomainUse(hostname) {
    const d = S.domain;
    d.busy = `use:${hostname}`;
    d.error = null;
    renderCloud();
    const res = await FT.call('domainUse', { hostname });
    d.busy = '';
    if (res.ok) FT.toast(`FinTrack đang dùng https://${hostname}`, 'success');
    else d.error = res.error;
    await refresh();
  }

  async function onDomainDetach(hostname) {
    const ok = await FT.confirm({
      title: `Gỡ ${hostname}?`,
      body: h('ul', { class: 'bullets' },
        h('li', null, 'Cloudflare xoá bản ghi DNS của tên này; FinTrack quay về địa chỉ workers.dev.'),
        h('li', null, 'Dữ liệu FinTrack không đổi. Gắn lại được bất cứ lúc nào.')),
      confirmText: 'Gỡ tên miền',
      danger: true,
    });
    if (!ok) return;
    const d = S.domain;
    d.busy = `detach:${hostname}`;
    d.error = null;
    renderCloud();
    const res = await FT.call('domainDetach', { hostname });
    d.busy = '';
    if (!res.ok) d.error = res.error;
    else FT.toast(`Đã gỡ ${hostname}`, 'success');
    await refresh();
  }

  const pollDeploy = () => FT.call('deployStatus');

  async function onDeploy() {
    S.deploy.error = null;
    S.deploy.busy = true;
    renderCloud();
    const pre = await FT.call('deployCheck');
    S.deploy.busy = false;
    renderCloud();
    if (!pre.ok) { S.deploy.error = pre.error; renderCloud(); return; }
    const exists = !!(pre.worker && pre.worker.exists);
    const version = pre.bundle && pre.bundle.version ? `v${pre.bundle.version}` : '';
    const ok = await FT.confirm(exists ? {
      title: 'Cập nhật Worker “fintrack” đang có?',
      body: h('ul', { class: 'bullets' },
        h('li', null, `Mã Worker sẽ được thay bằng FinTrack ${version} đi kèm ứng dụng (bản hiện tại sửa lần cuối ${FT.dateTime(pre.worker.modifiedOn) || '—'}).`),
        h('li', null, 'Dữ liệu trong D1 “fintrack” và các secret đang có của Worker được giữ nguyên; chỉ áp các migration còn thiếu (giống wrangler d1 migrations apply).'),
        h('li', null, 'Cần quay lại thì D1 có Time Travel để khôi phục về thời điểm trước khi cập nhật.')),
      requireCheck: 'Tôi hiểu, cập nhật Worker đang có',
      confirmText: 'Cập nhật',
      danger: true,
    } : {
      title: 'Triển khai FinTrack lên Cloudflare?',
      body: h('ul', { class: 'bullets' },
        h('li', null, ['Tạo Worker “fintrack” và cơ sở dữ liệu D1 “fintrack” trên tài khoản ', strong(pre.accountName || 'Cloudflare'), '.']),
        h('li', null, 'Workers AI (Whisper) dùng để chuyển giọng nói thành chữ, tính vào hạn mức Workers AI của bạn.'),
        h('li', null, 'Xong thì mở FinTrack để tạo tài khoản đầu tiên (tài khoản quản trị).')),
      confirmText: 'Triển khai',
    });
    if (!ok) return;
    const rotateSecret = S.deploy.rotate && !(S.status && S.status.fintrack && S.status.fintrack.secretSource === 'settings');
    const res = await FT.call('deployStart', { confirmOverwrite: exists, rotateSecret });
    if (!res.ok) { S.deploy.error = res.error; renderCloud(); return; }
    const final = await FT.pollJob(res.job, (j) => { S.deploy.job = j; renderCloud(); }, 2000, pollDeploy);
    S.deploy.job = final;
    if (final.state === 'done') FT.toast(final.result && final.result.healthy ? 'Đã triển khai FinTrack' : 'Đã triển khai, FinTrack chưa phản hồi: kiểm tra lại sau ít phút', final.result && final.result.healthy ? 'success' : 'warning');
    else if (final.error) FT.toast(final.error.message, 'error');
    S.deploy.rotate = false;
    await refresh();
  }

  // ─── FinTrack accounts in Deplao ─────────────────────────────────────────

  function renderWorkspace() {
    const sec = secEl('workspace');
    const st = S.status;
    const ft = (st && st.fintrack) || {};
    const show = !!st && !!(ft.health && ft.health.ok);
    sec.hidden = !show;
    if (!show) return;
    const el = bodyOf('workspace');
    const acc = st.account;
    const all = st.accounts || [];
    const others = all.filter((a) => !a.active);
    const parts = [errorBox(S.ws.error)];
    if (acc) {
      parts.push(h('div', { class: 'kv-list' },
        row('Đang mở', [strong(acc.name || acc.email), acc.name && acc.email ? muted(` · ${acc.email}`) : null]),
        row('Ghi nhớ', all.some((a) => a.active) ? 'Có, chuyển qua lại không cần nhập mật khẩu' : muted('Không, hết phiên phải đăng nhập lại'))));
    } else {
      parts.push(alertBox('info', ft.workspaceState === 'none'
        ? 'FinTrack chưa có tài khoản nào. Mở FinTrack để tạo tài khoản đầu tiên (tài khoản quản trị).'
        : 'Chưa đăng nhập tài khoản FinTrack nào trong Deplao. Mở FinTrack để đăng nhập, chọn tài khoản đã ghi nhớ hoặc tạo tài khoản mới.'));
    }
    if (others.length) {
      parts.push(h('span', { class: 'label' }, acc ? 'Tài khoản khác đã ghi nhớ' : 'Tài khoản đã ghi nhớ'));
      parts.push(h('div', { class: 'pick-list' }, others.map((a) => {
        const who = a.name || a.email;
        return h('div', { class: 'pick pick--row' },
          avatarNode(who),
          h('span', { class: 'pick__name' }, who, a.name && a.email ? muted(` · ${a.email}`) : null),
          button('Mở', () => onSwitchAccount(a), { small: true, disabled: S.ws.busy, ariaLabel: `Mở tài khoản ${who}` }),
          button('Quên', () => onForgetAccount(a), { small: true, kind: 'ghost', disabled: S.ws.busy, title: 'Bỏ ghi nhớ: lần sau phải nhập mật khẩu', ariaLabel: `Quên tài khoản ${who} trên Deplao này` }));
      })));
    }
    parts.push(h('div', { class: 'actions' },
      acc
        ? button('Thêm tài khoản', () => openApp('add-account'), { kind: 'primary', disabled: !st.ready, title: 'Mở FinTrack ở màn đăng nhập / tạo tài khoản' })
        : button('Mở FinTrack để đăng nhập', () => openApp(), { kind: 'primary', disabled: !st.ready }),
      acc ? button('Đăng xuất', onSignOut, { kind: 'ghost', disabled: S.ws.busy }) : null));
    parts.push(h('p', { class: 'hint' }, 'Mỗi tài khoản một sổ, dữ liệu riêng. Trong FinTrack, nút tài khoản ở góc trên để chuyển nhanh, thêm tài khoản hoặc đăng xuất. “Ghi nhớ mật khẩu” = Deplao giữ phiên đăng nhập để chuyển qua lại không phải nhập lại; mật khẩu không được lưu.'));
    FT.mount(el, parts);
    setSec('workspace', acc ? 'done' : 'todo', acc ? 'Đã đăng nhập' : 'Chưa đăng nhập');
  }

  async function accountAction(command, params, message) {
    S.ws.busy = true;
    S.ws.error = null;
    renderWorkspace();
    const res = await FT.call(command, params);
    S.ws.busy = false;
    if (!res.ok) { S.ws.error = res.error; renderWorkspace(); return; }
    FT.toast(message, 'success');
    await refresh();
  }

  const onSwitchAccount = (a) => accountAction('switchAccount', { workspaceId: a.workspaceId }, `Đã mở tài khoản ${a.name || a.email}`);
  const onForgetAccount = (a) => accountAction('forgetAccount', { workspaceId: a.workspaceId }, `Đã bỏ ghi nhớ ${a.name || a.email}`);

  async function onSignOut() {
    const st = S.status;
    const acc = st && st.account;
    if (!acc) return;
    const remembered = (st.accounts || []).some((a) => a.active);
    const ok = await FT.confirm({
      title: `Đăng xuất ${acc.name || acc.email}?`,
      body: h('ul', { class: 'bullets' },
        h('li', null, 'FinTrack trong Deplao thôi dùng tài khoản này cho tới khi bạn đăng nhập hoặc chọn lại.'),
        h('li', null, remembered
          ? 'Tài khoản vẫn nằm trong danh sách ghi nhớ: mở lại không cần mật khẩu (bấm “Quên” để bỏ hẳn).'
          : 'Tài khoản này không được ghi nhớ: lần sau phải nhập mật khẩu.')),
      confirmText: 'Đăng xuất',
    });
    if (ok) await accountAction('logout', {}, 'Đã đăng xuất');
  }

  // ─── Status, startup ────────────────────────────────────────────────────

  function renderAll() {
    renderHeader();
    renderShare();
    renderCloud();
    renderWorkspace();
  }

  async function loadStatus() {
    const res = await FT.call('status');
    if (res.ok) {
      S.status = res;
      S.quick = false;
      S.statusError = null;
      if (res.deployJob && (!S.deploy.job || res.deployJob.startedAt >= (S.deploy.job.startedAt || 0))) {
        S.deploy.job = res.deployJob;
        if (res.deployJob.state === 'running') resumeDeployPolling(res.deployJob);
      }
      if (res.domainJob && (!S.domain.job || res.domainJob.startedAt >= (S.domain.job.startedAt || 0))) {
        S.domain.job = res.domainJob;
        if (res.domainJob.state === 'running') pollDomainJob(res.domainJob);
      }
    } else {
      S.statusError = res.error;
    }
    renderAll();
    // The sign-up settings depend on the open account (admin or not): read them again with every status.
    if (res.ok && res.fintrack && res.fintrack.health && res.fintrack.health.ok) loadShare();
  }

  let refreshing = null;
  let refreshAgain = false;

  /** Reload the status. A load already in flight → load exactly once more after it (the result is always the latest), same promise. */
  function refresh() {
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    const btn = document.getElementById('refresh');
    btn.disabled = true;
    refreshing = (async () => {
      try {
        do {
          refreshAgain = false;
          await loadStatus();
        } while (refreshAgain);
      } finally {
        btn.disabled = false;
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /** “Kiểm tra lại” (Check again): reload the status. */
  function onRecheck() {
    return refresh();
  }

  let polling = false;
  async function resumeDeployPolling(job) {
    if (polling) return;
    polling = true;
    try {
      await FT.pollJob(job, (j) => { S.deploy.job = j; renderCloud(); }, 2000, pollDeploy);
    } finally {
      polling = false;
    }
    refresh();
  }

  function showPage() {
    document.getElementById('launch').hidden = true;
    document.getElementById('page').hidden = false;
  }

  /** Entry page: ready → open FinTrack right away; not ready → setup page. Slow check (FinTrack not responding) → show the page while waiting. */
  async function launch() {
    const slow = setTimeout(() => { showPage(); renderAll(); }, 4000);
    const res = await FT.call('status', { quick: true });
    clearTimeout(slow);
    if (res.ok && res.ready) {
      S.status = res;
      rememberUpdate(res);
      location.replace(appUrl());
      return;
    }
    showPage();
    if (res.ok) {
      S.status = res;
      S.quick = true;
    } else {
      S.statusError = res.error;
    }
    renderAll();
    refresh();
  }

  function init() {
    if (S.started) return;
    S.started = true;
    document.getElementById('refresh').addEventListener('click', () => onRecheck());
    document.getElementById('open-app').addEventListener('click', () => openApp());
    window.addEventListener('hashchange', () => { showPage(); renderHeader(); });
    if (optionsMode()) {
      showPage();
      renderAll();
      refresh();
    } else {
      launch();
    }
  }

  document.getElementById('foot-link').addEventListener('click', (e) => { e.preventDefault(); if (S.started) FT.openExternal(HOMEPAGE); });

  if (window.deplao && typeof deplao.ready === 'function') {
    deplao.ready(init);
    // The SDK never reports ready (broken channel to Deplao) → show a clear error instead of hanging on the loading screen.
    setTimeout(() => {
      if (S.started) return;
      showPage();
      S.statusError = { message: 'Chưa kết nối được với Deplao. Đóng rồi mở lại ứng dụng.' };
      renderAll();
    }, 8000);
  } else {
    // Opened outside Deplao (a regular browser): no SDK.
    showPage();
    S.statusError = { message: 'Trang này chỉ chạy bên trong Deplao (Công cụ → Ứng dụng, API & Webhook).' };
    renderAll();
  }
})();
