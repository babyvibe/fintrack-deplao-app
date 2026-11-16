# Building a Deplao app with this repository as a template

This repository is the reference implementation of a complete Deplao app: a page with its own UI, a Node backend, two
workflow nodes, settings, persistent storage, a web app deployed to the user's own Cloudflare account, tests, a
reproducible package and CI. This guide explains each building block, where it lives in the code and what to change
when you start a new app from it.

Deplao calls apps "Ứng dụng" in its UI; the code and the file names still say *plugin* (`deplao-plugin.json`,
`deplao-plugin://<id>`). Deplao's own reference lives in the Deplao repository (`docs/api/guides/plugins.md`,
`docs/api/guides/plugin-reference.md`); this guide focuses on the patterns that make an app robust.

## Contents

1. [Pick a runtime](#1-pick-a-runtime)
2. [Start a new app from this template](#2-start-a-new-app-from-this-template)
3. [The manifest](#3-the-manifest)
4. [Backend](#4-backend)
5. [UI pages](#5-ui-pages)
6. [Workflow nodes](#6-workflow-nodes)
7. [Shipping a web app to the user's Cloudflare (optional)](#7-shipping-a-web-app-to-the-users-cloudflare-optional)
8. [Testing](#8-testing)
9. [Packaging, CI and releases](#9-packaging-ci-and-releases)
10. [Checklist before publishing](#10-checklist-before-publishing)

## 1. Pick a runtime

| Runtime | Use it when | This repository |
|---|---|---|
| `web` | Everything runs in the page (iframe): a tool, a dashboard over Deplao's API. | no |
| `local` | You need background logic on the user's machine: workflow nodes, commands called from the UI, routes, schedules, event handlers, calls to other services. | **yes** |
| `remote` | Your logic lives on your own server; Deplao calls it over signed HTTPS. | no |

A `local` app runs its backend in a separate Node process managed by Deplao (256 MB heap, `require('electron')` and
`process.exit` blocked, `console.*` goes to the app's log). It is restarted after a crash (2 s, 10 s, 60 s, then the app
is disabled) and after three unanswered pings. Deplao only gives it data allowed by the approved permissions, but it is
still Node code on the user's machine: keep it small and dependency free.

## 2. Start a new app from this template

1. **Copy the repository** (without `.git`, `node_modules`, `dist`, `vendor/fintrack/*`).
2. **Choose the id**: reverse-DNS, lowercase, e.g. `io.github.you.inventory`. The last segment (`inventory`) is your
   prefix: workflow node types must start with it (`inventory.lookup`), and Cloudflare resources created through Deplao
   must be named exactly the prefix or `<prefix>-…`. It must not clash with built-in node prefixes (`zalo`, `fb`,
   `trigger`, ...).
3. **Rename** in one go:
   - `deplao-plugin.json`: `id`, `name`, `version` (`0.1.0`), `description`, `author`, `homepage`, `icon`,
     `permissions`, `contributes`.
   - `package.json`: `name`, `version`, `description`, `keywords`, URLs.
   - `backend/lib/constants.js`: `PLUGIN_ID`, `PLUGIN_VERSION`, `USER_AGENT`, node types, `RESOURCE_NAME`, storage keys.
   - `scripts/lib/manifest-check.mjs`: the `CONTRACT_*` constants describe what *this* app must declare (id, permissions,
     node types and outputs). Replace them with your app's contract so `npm run validate` keeps you honest.
   - `README.md` (English, for GitHub), `README.vi.md` (Vietnamese, shown in Deplao's install dialog),
     `CHANGELOG.md`, `SECURITY.md`, `LICENSE`, `.github/` links.
4. **Keep the generic infrastructure** and delete what is FinTrack specific:

   | Keep (generic) | Replace or delete (FinTrack specific) |
   |---|---|
   | `backend/index.js` (entry, `guard` for nodes) | `lib/record.js`, `lib/message.js`, `lib/reply.js`, `lib/money.js` (Zalo expense recording) |
   | `lib/commands.js` `wrap()` and the `status` pattern | `lib/proxy.js`, `lib/accounts.js` (FinTrack sessions and accounts) |
   | `lib/errors.js`, `lib/util.js`, `lib/jobs.js`, `lib/constants.js` | `lib/fintrackClient.js` (FinTrack's integration API) |
   | `lib/state.js` (locking and strict reads) | the FinTrack keys in `lib/state.js` |
   | `lib/deploy.js`, `lib/cloudflare.js`, `lib/domain.js` (only if you deploy a Worker) | |
   | `ui/lib.js` (`FT.*` helpers), `ui/style.css` | most of `ui/app.js` |
   | `scripts/` (pack, zip, validate, vendor, preview harness) | FinTrack paths in `vendor-fintrack.mjs`, `with-fintrack.mjs`, `e2e-fintrack.mjs` |
   | `test/helpers/fakes.js` (`createFakeDeplao`) | the fake FinTrack in the same file, most tests |

5. Run `npm run check`, then load the folder in Deplao: **Tools → Apps, API & Webhook → Develop apps → Add a folder in
   development**. Backend edits reload the backend automatically; reload the page after UI edits.

## 3. The manifest

`deplao-plugin.json` (see this repository's file for a full example):

| Field | Notes |
|---|---|
| `id`, `name`, `version`, `apiVersion: 1` | Semver `version`; Deplao only installs a zip whose version is higher than the installed one. |
| `minDeplaoVersion` | The lowest **released** Deplao with every API you call. Here 26.11.0: Cloudflare deployment for apps, `aiChat` with `raw_system`, `downloadMessageMedia`, the assistant picker in nodes. Optional features you detect at runtime (custom domains need 26.10.4) do not raise it. |
| `runtime` | `local` here (needs `backend.entry`). |
| `permissions` | API scopes plus app permissions. Ask for the minimum and explain each one in the README. Never `admin`, `plugins:manage`, `employees:manage`, `settings:write` (refused). |
| `ui.entry` | The HTML page Deplao opens. `ui.connectSrc` / `ui.imgSrc` allow direct fetches or external images (need `network`); this app needs neither because the backend does all networking. |
| `contributes.pages` | Pages in Deplao's navigation (`path` is a hash route inside `ui.entry`). |
| `contributes.settings.schema` | A JSON Schema rendered as a form by Deplao (string, number, integer, boolean, enum; `x-secret` values are encrypted, `x-multiline`). Read them as `ctx.settings` / `deplao.settings.get()`. |
| `contributes.workflowNodes` | `{ type, label, group, icon, description, configSchema, outputs }`; see [Workflow nodes](#6-workflow-nodes). |
| Other extension points | `chatPanels`, `composerButtons`, `triggers`, `routes`, `schedules`, `events` (not used here). |

App permissions used by this repository: `storage` (`deplao.storage`, 1 MB per value, 20 MB per app),
`ui:pages`, `ui:microphone` (the frame gets `allow="microphone"`), `workflow:nodes`, `network`
(`deplao.http.fetch`), `cloudflare:workers` (`deplao.cloudflare`). API scopes: `accounts:read`, `chat:read`,
`chat:send`, `media:read`, `ai:use`.

## 4. Backend

### Entry point

```js
// backend/index.js
module.exports = {
  async activate() { /* start-up work: keep it short */ },
  async onSettingsChanged() { /* drop caches that depend on settings */ },
  nodes: { 'inventory.lookup': guard(lookup, { found: false }) },   // 60 s per run
  commands: require('./lib/commands'),                               // UI calls, 30 s per call
};
```

Every Deplao call goes through the `ctx.deplao` object Deplao passes in (`ctx = { deplao, settings, ... }`). Never import
it globally: tests replace it with a fake (section 8).

### Commands (UI → backend)

The UI calls `deplao.backend.call(name, params)` and Deplao invokes `commands[name](params, ctx)`. Rules used here:

- Wrap every command (`wrap()` in `lib/commands.js`): it validates `params` is an object and turns the result into
  `{ ok: true, ...data }` or `{ ok: false, error: { code, message } }`. User-facing messages come from `PluginError`
  (`lib/errors.js`), with a code the UI can branch on and a Vietnamese sentence that says what to do next.
- **Deplao cuts a UI call after 30 seconds.** Multi-step commands carry a budget (`createDeadline(25_000)` in
  `lib/util.js`) and degrade per section: `status` returns `{ error }` for a part that timed out instead of failing whole.
- **Long work runs as a background job** (`lib/jobs.js`): `startJob(kind, fn, { exclusive, onChange, keepMs })`
  returns at once; the UI polls `job` (here `deployStart` → `job`, and `api` returns `{ pending: id }` after about 20 s,
  then `apiResult`). Persist progress to storage when a restart of the backend must not lose it (`deploy.job`).

### Storage

- Keep every key in `constants.js` (`KEYS`) and document it (ARCHITECTURE.md has the table).
- **Read-modify-write under a lock**: `lib/state.js` serialises updates of the same key with a mutex (no nested locks),
  so two concurrent node runs cannot lose each other's write.
- **Strict reads**: when a read fails, do not write a default over existing data; throw and let the caller retry.
- Bound everything you append: `seen` keeps 7 days / 5000 entries, `replies` 7 days / 300 entries. A value is limited
  to 1 MB.
- Secrets (integration secret, session tokens) stay in storage or in `x-secret` settings; never send them to the UI and
  never log them.

### Network

`deplao.http.fetch(url, init)` (permission `network`) blocks private networks, returns at most 5 MB, and gives `text` or
`base64` by content type (`init.responseType` forces one). Wrap calls with a timeout (`withTimeout` in `lib/util.js`)
and treat a non-JSON answer as "wrong address or outdated service" with a clear message
(`lib/fintrackClient.js`, `lib/proxy.js`).

### Calling Deplao's AI

`ctx.deplao.ai.aiChat({ messages, max_tokens, assistant_id?, raw_system })` (scope `ai:use`). `raw_system: true` sends
your messages as they are, without the assistant's own prompt; at most 100 messages of 100,000 characters,
`max_tokens` ≤ 8000; the answer carries `result` and token counts. `listAiAssistantOptions()` lists assistants for a
picker (no prompts, no keys). This app uses it to let a web service (FinTrack) delegate a turn to Deplao's assistant
(HTTP 428 → `aiChat` → resend with `delegated`), see `lib/proxy.js` and CONTRACTS §2.3.

## 5. UI pages

- Load the SDK from the app's own origin, before your script: `<script src="/__deplao/sdk.js"></script>`. Inline
  scripts are blocked by the CSP; scripts, styles and fonts from CDNs are blocked too, so bundle everything.
- `ui/index.html` is the **entry page**: it calls `status` once and either redirects to the main UI (here the FinTrack
  web app in `vendor/fintrack/app/`) or shows the setup page. The same file with `#options` is the **Options page**
  ("Tuỳ chọn"). One entry, two routes, no flash of setup UI for users who are ready.
- `ui/lib.js` holds small helpers: `FT.h(tag, attrs, ...children)` builds DOM with `textContent` (never `innerHTML`
  with data), `FT.mount` re-renders a section while keeping focus and the caret of the input being typed in,
  `FT.call` wraps `backend.call`, `FT.pollJob` polls background jobs, `FT.confirm` shows a confirmation dialog.
- Theme: Deplao sets CSS variables (`--dp-bg`, `--dp-surface`, `--dp-text`, `--dp-text-muted`, `--dp-accent`,
  `--dp-border`, ...) on the page; `deplao.ui.theme()` / `onTheme()` give the same in JS.
- Pass state between your pages with `sessionStorage` (same origin `deplao-plugin://<id>`): the entry page here writes
  `fintrack-update-available` so the main UI can show "Có bản FinTrack mới".
- Open external links with `deplao.ui.openExternal(url)`; the iframe cannot navigate the app or open popups.

## 6. Workflow nodes

```jsonc
{
  "type": "fintrack.record",             // <prefix>.<name>
  "label": "FinTrack: ghi chi tiêu từ tin nhắn",
  "configSchema": { "properties": {
    "account": { "type": "string", "x-widget": "account" },        // also thread | label | assistant
    "mode": { "type": "string", "enum": ["draft", "auto"], "default": "draft" }
  } },
  "outputs": [ { "name": "recorded", "label": "Số khoản đã ghi" }, { "name": "skipped", "label": "Lý do bỏ qua" } ]
}
```

The backend handler is `nodes[type](cfg, run, ctx)` and has 60 seconds. Patterns from `lib/record.js`:

- **Never throw for bad input**: return the outputs with `skipped: '<reason>'` (`no_message`, `duplicate`, ...).
  `guard()` in `backend/index.js` turns unexpected exceptions into `skipped: 'internal_error'` so one bad message never
  breaks the user's workflow.
- **Budget the run** (52 s here) and reserve time for the slow step (the AI answer) after downloads and transcription.
- **Cheap filters first**: skip messages that cannot matter (no amount in the text) before any storage write or AI call.
- **Deduplicate** by a stable key (`zalo:<threadId>:<msgId>`), shared by every account that may receive the same
  message, with a TTL; unmark it when the run fails for a temporary reason so a retry can work.
- **Recognise your own replies** (ids of messages you just sent, plus reply markers such as ✅ 📝) so the workflow does
  not loop on itself.
- **Report errors to users sparingly**: temporary errors at most once every 10 minutes per chat; configuration problems
  are silent in chats and visible on the Options page.
- The trigger payload is flat (`run.trigger.content`, `threadId`, `msgId`, `isGroup`, ...); media and quotes are read
  with `chat.getMessage` and `downloadMessageMedia` when needed.

## 7. Shipping a web app to the user's Cloudflare (optional)

FinTrack shows how an app can run a full web service on the user's own Cloudflare account, with no server of yours in
between. Pieces involved:

1. **A prebuilt bundle** in `vendor/<name>/` described by `bundle.json` (`mainModule`, `modules`, `compatibilityDate`,
   `compatibilityFlags`, `assets`, `migrations`, plus your own fields). Limits: 50 MB total, 5000 assets, 25 MiB per
   asset, safe relative paths. `scripts/vendor-fintrack.mjs` validates a bundle, copies it into a temporary folder and
   swaps it in atomically, then writes `vendor/<name>.vendor.json` (version, file count, sha256).
2. **Deployment** (`lib/deploy.js`) through `ctx.deplao.cloudflare` (permission `cloudflare:workers`; the Cloudflare
   token never reaches the app): `status()` → `d1.ensure(name)` → `d1.migrate(name, dir)` (wrangler compatible, already
   applied files are skipped) → `workers.deployBundle({ name, bundleDir, bindings, secrets, workersDev })` → health check.
   Ask for confirmation before overwriting an existing Worker. Every call counts against Deplao's budget of 100
   Cloudflare requests per 5 minutes per app.
3. **An integration secret** generated by the app (≥ 32 random bytes) and set as a Worker secret. The service accepts it
   as `Authorization: Bearer` (constant-time comparison) **only** on its integration routes; everything else keeps
   normal user sessions.
4. **Update detection**: compare the version reported by the service's health route with the bundled version, and the
   bundle's sha256 (`build`) with the one stored at the last deployment. Installing a new app zip never redeploys by
   itself; tell the user (Options page and inside the web app) and let them click update.
5. **Custom domains** (Deplao 26.10.4+): `zones()`, `workers.domains.attach/detach/list`. Deplao asks the user before
   attaching (`CF_DECLINED` if refused); poll the new hostname before switching to it (`lib/domain.js`).
6. **The UI in Deplao**: build the web app a second time for the iframe (FinTrack: `vite build --mode deplao`,
   `base: './'`), load the SDK, and send API calls through the backend (`commands.api`) instead of `fetch`, so the
   backend can attach sessions and headers and the page needs no `connectSrc`.

## 8. Testing

- **Unit tests** use `node:test` with no dependencies (`npm test`). `test/helpers/fakes.js` provides
  `createFakeDeplao(opts)`: in-memory `storage`, `http.fetch` routed to a fake service, `chat`, `ai.aiChat`,
  `system.info`, an optional fake `cloudflare` (`opts.cloudflare`), and a log of every call (`env.calls`) to assert on. Write a fake for the service your app
  talks to (here `createFakeFinTrack`) and test commands and nodes through their public entry points.
- **End-to-end** (`npm run e2e`, `scripts/e2e-fintrack.mjs`): the real FinTrack API and D1 (Miniflare) behind a real
  HTTP server, the real backend, a fake Deplao. It walks the user journeys (deploy status, accounts, assistant
  delegation, group messages, "ok" / "huỷ") step by step.
- **Preview and screenshots** (`npm run preview`, `npm run shots`): `scripts/dev-preview.mjs` serves the UI with a fake
  SDK whose `backend.call` reaches the real backend, with modes `--fresh`, `--demo`, `--undeployed`;
  `scripts/readme-shots.mjs` drives headless Chrome over the DevTools protocol to regenerate `docs/images/*.jpg` from
  demo data, so README images always match the current UI.
- Test on Windows too (CI does): Deplao users are mostly on Windows, which catches path and line-ending bugs.

## 9. Packaging, CI and releases

- `npm run pack` (`scripts/pack.mjs`, `scripts/lib/zip.mjs`) builds `dist/<name>-<version>.zip`: only the files the
  app needs, sorted entries and a fixed timestamp (**reproducible**: the same sources give the same sha256), Deplao's
  limits checked (50 MB zip, 200 MB unpacked, 5000 entries, no absolute paths, `..` or symlinks). Deplao shows the
  package README as plain text in its install dialog, so pack strips HTML from it and uses `README.vi.md` when present.
- `npm run validate` (`scripts/validate-manifest.mjs`): manifest rules, matching versions in the manifest,
  `package.json` and `constants.js`, every JSON file valid; with `DEPLAO_REPO=<Deplao repository>` it also runs Deplao's
  official manifest checks.
- CI (`.github/workflows/ci.yml`): unit tests on Node 20 / 22 / 24 (Linux) and Node 22 (Windows), manifest checks, a
  test pack without the bundle.
- Release: CHANGELOG entry, version bump in three places, vendor the matching bundle, `npm run check`, `npm run e2e`,
  `npm run pack`, tag `vX.Y.Z`, attach the zip and its sha256 to a GitHub Release (CONTRIBUTING.md has the full list).

## 10. Checklist before publishing

- [ ] Least permissions, each explained in the README's permission table.
- [ ] `minDeplaoVersion` = lowest released Deplao with every API you call; optional features detected at runtime.
- [ ] No secrets, tokens, passwords, message content, audio or images in logs; secrets never reach the UI.
- [ ] Every input from messages, services or the UI checked for type and length.
- [ ] Nodes never throw; commands return `{ ok: false, error }` with an actionable Vietnamese message.
- [ ] User-facing text in Vietnamese, short, without the em dash; code comments and developer docs in English.
- [ ] Demo data that makes every screen meaningful (preview `--demo`), README screenshots regenerated from it.
- [ ] `README.md` (English) and `README.vi.md` (shown in Deplao), CHANGELOG, SECURITY, LICENSE and third-party notices.
- [ ] `npm run check` and `npm run e2e` green, CI green on Windows, reproducible `npm run pack`.
