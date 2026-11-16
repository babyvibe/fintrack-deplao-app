/* global deplao */
/**
 * Shared UI helpers (no framework): DOM creation, backend calls, background job polling, an in-page confirm dialog
 * (the app iframe has no window.confirm), copying to the clipboard, time formatting, diacritic-insensitive search.
 */
(function () {
  'use strict';
  var FT = (window.FT = window.FT || {});

  /**
   * h('button', { class: 'btn', onclick: fn, 'aria-label': '…' }, 'Text', otherNode). A null / undefined / false value
   * skips the attribute; checked / disabled / selected / value are assigned directly as DOM properties.
   */
  FT.h = function h(tag, attrs) {
    var node = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'value') node[k] = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    });
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  };

  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); return; }
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }

  /**
   * Replace all content of el. A focused input (with an id) inside el gets its focus and caret position back, so
   * re-rendering when data arrives doesn't lose what the user is typing.
   */
  FT.mount = function mount(el, children) {
    var active = document.activeElement;
    var keep = active && active.id && el.contains(active)
      ? { id: active.id, start: active.selectionStart, end: active.selectionEnd }
      : null;
    el.replaceChildren();
    append(el, children);
    if (!keep) return;
    var next = document.getElementById(keep.id);
    if (!next || !el.contains(next)) return;
    next.focus({ preventScroll: true });
    if (typeof keep.start === 'number' && typeof next.setSelectionRange === 'function') {
      try { next.setSelectionRange(keep.start, keep.end); } catch (e) { /* input type without a text caret */ }
    }
  };

  /** Call the backend's commands[name]; always resolves to { ok, ... } (channel error → ok:false). */
  FT.call = function call(name, params) {
    return deplao.backend.call(name, params || {}).then(function (res) {
      if (res && typeof res === 'object' && 'ok' in res) return res;
      return { ok: false, error: { code: 'BAD_RESPONSE', message: 'Phần chạy nền trả dữ liệu lạ.' } };
    }, function (err) {
      var code = (err && err.code) || 'ERROR';
      var msg = (err && err.message) || 'Lỗi không rõ';
      if (code === 'TIMEOUT') msg = 'Phần chạy nền của ứng dụng không trả lời kịp. Thử lại.';
      if (code === 'CONFLICT') msg = 'Ứng dụng đang tắt hoặc đang khởi động lại. Thử lại sau vài giây.';
      return { ok: false, error: { code: code, message: msg } };
    });
  };

  FT.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /**
   * Poll a background job until it finishes; onUpdate(job) on every new snapshot.
   * fetcher(job) → { ok, job } (default: the "job" command by id).
   */
  FT.pollJob = async function pollJob(job, onUpdate, intervalMs, fetcher) {
    var current = job;
    var failures = 0;
    onUpdate(current);
    while (current && current.state === 'running') {
      await FT.sleep(intervalMs || 1000);
      var res = fetcher ? await fetcher(current) : await FT.call('job', { id: current.id });
      if (!res.ok || !res.job) {
        // Temporary channel error (app busy) → retry a few times before giving up.
        if (++failures < 5) continue;
        return Object.assign({}, current, { state: 'error', error: (res && res.error) || { message: 'Mất thông tin tiến độ. Tải lại trang.' } });
      }
      failures = 0;
      current = res.job;
      onUpdate(current);
    }
    return current;
  };

  FT.toast = function toast(message, kind) {
    try { return deplao.ui.toast(String(message).slice(0, 290), kind || 'info').catch(function () {}); } catch (e) { return null; }
  };

  FT.openExternal = function (url) {
    try { deplao.ui.openExternal(url).catch(function (e) { FT.toast(e.message || 'Không mở được liên kết', 'error'); }); } catch (e) { /* ignore */ }
  };

  /**
   * Copy text during a click → Promise<boolean>. Deplao's app frame has no clipboard-write permission, so the async
   * Clipboard API is refused there; the legacy copy command on a hidden field still works (the API is the fallback).
   */
  FT.copyText = function copyText(text) {
    var prev = document.activeElement;
    var area = document.createElement('textarea');
    area.value = String(text);
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var copied = false;
    try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
    area.remove();
    if (prev && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
    if (copied) return Promise.resolve(true);
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return Promise.resolve(false);
    return navigator.clipboard.writeText(String(text)).then(function () { return true; }, function () { return false; });
  };

  var pad = function (n) { return String(n).padStart(2, '0'); };

  /** epoch ms / ISO → "14:05 20/10/2026" */
  FT.dateTime = function dateTime(v) {
    if (!v) return '';
    var d = new Date(typeof v === 'number' ? v : String(v));
    if (isNaN(d.getTime())) return '';
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
  };

  FT.initials = function initials(name) {
    var words = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    var first = Array.from(words[0])[0] || '?';
    return (words.length > 1 ? first + (Array.from(words[words.length - 1])[0] || '') : first).toUpperCase();
  };

  /**
   * Confirm dialog using the browser's <dialog>: keeps focus inside, Esc cancels, focus returns where it was on close.
   * opts: { title, body (node | string | array), confirmText, cancelText, danger, requireCheck (label of a required checkbox) }
   * → Promise<boolean>
   */
  FT.confirm = function confirmDialog(opts) {
    var h = FT.h;
    return new Promise(function (resolve) {
      var check = null;
      var done = false;
      var okBtn = h('button', { class: 'btn ' + (opts.danger ? 'btn--danger' : 'btn--primary'), type: 'button' }, opts.confirmText || 'Đồng ý');
      var cancelBtn = h('button', { class: 'btn btn--ghost', type: 'button' }, opts.cancelText || 'Huỷ');
      if (opts.requireCheck) {
        okBtn.disabled = true;
        check = h('input', { type: 'checkbox', onchange: function () { okBtn.disabled = !check.checked; } });
      }
      var dialog = h('dialog', { class: 'modal', 'aria-labelledby': 'modal-title' },
        h('div', { class: 'modal__inner' },
          h('h3', { class: 'modal__title', id: 'modal-title' }, opts.title || 'Xác nhận'),
          h('div', { class: 'modal__body' }, opts.body || ''),
          check ? h('label', { class: 'check check--modal' }, check, h('span', null, opts.requireCheck)) : null,
          h('div', { class: 'modal__actions' }, cancelBtn, okBtn)));
      function close(result) {
        if (done) return;
        done = true;
        if (dialog.open) dialog.close();
        dialog.remove();
        resolve(result);
      }
      okBtn.addEventListener('click', function () { close(true); });
      cancelBtn.addEventListener('click', function () { close(false); });
      // Esc (the cancel event) and a click on the backdrop outside the box = cancel.
      dialog.addEventListener('cancel', function (e) { e.preventDefault(); close(false); });
      dialog.addEventListener('click', function (e) { if (e.target === dialog) close(false); });
      document.body.appendChild(dialog);
      dialog.showModal();
      (check || cancelBtn).focus();
    });
  };
})();
