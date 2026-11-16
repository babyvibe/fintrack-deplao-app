'use strict';
/**
 * Background jobs in the plugin process. Deplao cuts UI commands (deplao.backend.call) off after 30 s,
 * while a Cloudflare deploy / an AI assistant call can take longer → the command starts a job, waits a while,
 * and if it is not done yet returns an id for the UI to poll. Results are kept for `keepMs` (default 5 minutes)
 * after the job ends.
 */

const crypto = require('crypto');
const { describeError } = require('./errors');

const MAX_JOBS = 500;
const DEFAULT_KEEP_MS = 5 * 60_000;
const jobs = new Map();

function snapshot(job) {
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    steps: job.steps.map((s) => ({ ...s })),
    result: job.result,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

function prune(now = Date.now()) {
  for (const [id, j] of jobs) {
    if (j.state !== 'running' && j.finishedAt && now - j.finishedAt > j.keepMs) jobs.delete(id);
  }
  if (jobs.size <= MAX_JOBS) return;
  const done = [...jobs.values()].filter((j) => j.state !== 'running').sort((a, b) => a.startedAt - b.startedAt);
  while (jobs.size > MAX_JOBS && done.length) jobs.delete(done.shift().id);
}

/**
 * Runs fn(progress) in the background. progress(stepId, status, detail) updates the step list for the UI.
 * exclusive: a job of the same `kind` is already running (e.g. "Triển khai" (Deploy) pressed twice) → return that job.
 * onChange(snapshot): called on every progress change and on completion (e.g. to save it to deplao.storage).
 */
function startJob(kind, fn, { exclusive = false, onChange, keepMs = DEFAULT_KEEP_MS } = {}) {
  prune();
  if (exclusive) {
    const running = [...jobs.values()].find((j) => j.kind === kind && j.state === 'running');
    if (running) return snapshot(running);
  }
  const job = {
    id: crypto.randomUUID(),
    kind,
    state: 'running',
    steps: [],
    result: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    keepMs,
    promise: null,
  };
  jobs.set(job.id, job);
  const notify = () => {
    if (typeof onChange !== 'function') return;
    try {
      Promise.resolve(onChange(snapshot(job))).catch(() => undefined);
    } catch {
      /* saving progress must never break the job itself */
    }
  };
  const progress = (id, status, detail) => {
    const step = job.steps.find((s) => s.id === id);
    if (step) {
      step.status = status;
      if (detail !== undefined) step.detail = detail;
    } else {
      job.steps.push({ id, status, detail: detail || '' });
    }
    notify();
  };
  notify();
  job.promise = Promise.resolve()
    .then(() => fn(progress))
    .then((result) => {
      job.result = result === undefined ? null : result;
      job.state = 'done';
    })
    .catch((err) => {
      job.error = describeError(err);
      job.state = 'error';
      for (const s of job.steps) if (s.status === 'running') s.status = 'error';
    })
    .finally(() => {
      job.finishedAt = Date.now();
      notify();
    });
  return snapshot(job);
}

function getJob(id) {
  return snapshot(jobs.get(String(id || '')));
}

/** Waits up to `ms` for the job → snapshot (state 'running' if not done yet); null if there is no such job. */
async function waitJob(id, ms) {
  const job = jobs.get(String(id || ''));
  if (!job) return null;
  if (job.state === 'running') {
    let timer;
    await Promise.race([job.promise, new Promise((r) => { timer = setTimeout(r, Math.max(0, ms)); })]);
    clearTimeout(timer);
  }
  return snapshot(job);
}

function latestJob(kind) {
  const list = [...jobs.values()].filter((j) => j.kind === kind).sort((a, b) => b.startedAt - a.startedAt);
  return snapshot(list[0]);
}

/** Drops a delivered result (the UI has it) so large data is not kept in memory for another 5 minutes. */
function dropJob(id) {
  const job = jobs.get(String(id || ''));
  if (job && job.state !== 'running') jobs.delete(job.id);
}

module.exports = { startJob, getJob, waitJob, latestJob, dropJob, _reset: () => jobs.clear() };
