# Three-party contract: Deplao · FinTrack · fintrack-deplao-app

This document is the source of truth for all three parts. Anything changed here must be changed in all three at the
same time.

**The app is the full FinTrack running inside Deplao.** Opening the "FinTrack" app from Deplao's Apps page shows the
complete FinTrack UI with every feature (same UI code, same API, same business logic). It differs from standalone
FinTrack in exactly three ways:

1. **Cloudflare comes from Deplao**: the Worker + D1 + Workers AI are deployed to the Cloudflare account connected in
   Deplao (no wrangler, no separate configuration). Data and business logic still run on the user's own Worker, as in
   the standalone version; opening it in a browser / on a phone (PWA) still works.
2. **AI assistant of your choice**: each account picks either FinTrack's own assistant (OpenAI / Gemini / DeepSeek
   profiles, works exactly as in the standalone version, reads images) **or** Deplao's AI assistant (delegation, §2.3:
   text + voice, no images yet). Prompt, action catalog, drafts + confirmation, validation and so on keep FinTrack's
   logic.
3. **Accounts held by Deplao**: sign in / create an account right inside Deplao; "ghi nhớ mật khẩu" (remember password)
   means Deplao keeps the session and mints a new one with the integration secret when it expires (**no password is
   stored**), with quick switching between remembered accounts. On first run (FinTrack has exactly one account and the
   user never signed out) that account opens automatically; a FinTrack with no accounts shows the create-account screen
   (the first account is the admin).

Optional extras (nodes you add to your own Deplao workflow; there is no setup step in the app): capture Zalo messages
(create drafts awaiting confirmation, or record automatically) and turn voice messages into text.

---

## 1. Deplao (existing)

### 1.1 `deplao.cloudflare` for plugins (backend, permission `cloudflare:workers`)

- Worker / D1 names must **equal the plugin prefix** (`pluginShortName`, here `fintrack`) or start with `fintrack-`;
  any other name → `CF_NAME_FORBIDDEN`. The Cloudflare token never reaches the plugin.
- `status()`, `d1.ensure(name)`, `d1.migrate(name, dir)` (like `wrangler d1 migrations apply`, table `d1_migrations`),
  `d1.query(name, sql, params)`, `workers.get(name)`, `workers.deployBundle({ name, bundleDir, bindings: { d1, ai,
  vars }, secrets, workersDev })`. Redeploying keeps existing secrets (`keep_bindings`). Every call counts toward
  Deplao's budget of 100 requests / 5 minutes.
- Errors: `CF_NOT_CONNECTED`, `CF_PERMISSION`, `CF_NAME_FORBIDDEN`, `CF_BUNDLE_INVALID`, `CF_API`, `PLUGIN_PERMISSION`.
- Custom domains (Deplao 26.10.4+; older versions do not have these functions): `zones()` → `[{ id, name }]`, the
  account's active zones; `workers.domains.list(name)` → `[{ id, hostname, zoneId, zoneName }]`;
  `workers.domains.attach(name, hostname)` → `{ …, created }`; `workers.domains.detach(name, hostname)` →
  `{ removed }`. Deplao only attaches a **new subdomain** of a zone in the account: the apex domain →
  `VALIDATION_ERROR`, a name that already has a DNS record or is attached to another Worker → `CONFLICT`, already
  attached to this Worker → `created: false`. Before writing anything, Deplao asks the user in its own dialog: clicking
  "Không" (No) → `CF_DECLINED` (Deplao asks again only after 60 seconds; one dialog per app at a time). Cloudflare
  creates the DNS record + certificate itself; the new name answers over HTTPS a few minutes later. Detaching only
  touches names of that same Worker. Extra token permissions: Zone · Zone · Read, Zone · DNS · Read (Deplao's token
  template link already includes them).

### 1.2 Prebuilt Worker bundle (`bundle.json`)

```jsonc
{
  "mainModule": "worker.js",
  "modules": [{ "name": "worker.js", "type": "esm" }],          // <bundleDir>/worker/
  "compatibilityDate": "2026-10-05",
  "compatibilityFlags": ["nodejs_compat"],
  "assets": { "dir": "assets", "binding": "ASSETS",
              "config": { "not_found_handling": "single-page-application", "run_worker_first": ["/api/*"] } },
  "migrations": "migrations",                                     // <bundleDir>/migrations/*.sql
  "crons": ["*/5 * * * *"],                                       // optional, Deplao > 26.11.0: the Worker's Cron Triggers
  "app": "app",                                                   // <bundleDir>/app/ = FinTrack UI, Deplao build (§2.4); Deplao does not read it
  "fintrackVersion": "0.1.0"                                      // Deplao does not read it; the plugin compares it with health.version (§2.2)
}
```

Limits: total ≤ 50 MB, ≤ 5000 assets, each asset ≤ 25 MiB, safe relative paths.

`crons` (optional): at most 3 five-field cron expressions in UTC. Declared → `deployBundle` replaces the Worker's
schedules with exactly this list (`[]` turns them all off) and its result carries `crons` = the active schedules; not
declared → schedules are left untouched and the result has no `crons`. When Cloudflare refuses the schedules (e.g. the
account's trigger limit), the deploy still succeeds: the result has `cronsError` (a message for the user) and no `crons`.
Older Deplao versions ignore the field, so an app must keep a plugin-side fallback (`contributes.schedules`) whenever the
result has no `crons`. Cloudflare's Free plan allows
only 5 Cron Triggers per account: use one per Worker and dispatch jobs inside it. FinTrack declares none today.

### 1.3 Other API functions used

- `aiChat({ messages, max_tokens, temperature?, assistant_id?, raw_system })`: `raw_system: true` = send exactly
  `messages` (including `system`) to the model, without adding the Deplao assistant's system prompt / knowledge. Each
  message ≤ 100,000 characters, ≤ 100 messages, `max_tokens` ≤ 8000. Returns `{ result, total_tokens, … }`. No image
  input yet.
- `getDefaultAiAssistant()` → `{ id, name, platform, model, enabled, has_api_key }` or `null`.
- `listAiAssistantOptions()` → `[{ id, name, platform, model, enabled, is_default }]`: assistants to choose from (scope
  `ai:use`, no system prompt, no key). Older Deplao versions without this function → `NOT_FOUND` (only the default
  assistant can be used).
- `downloadMessageMedia({ accountId, threadId, msgId })` → `{ name, mime, size, base64 }` (≤ 25 MB, permission
  `media:read`); for a Zalo voice message that is not on the machine yet, Deplao downloads it itself with the account's
  session.
- `deplao.backend.call(name, params)` from the UI to the backend's `commands[name]`: **cut off after 30 seconds**.

---

## 2. FinTrack

### 2.1 Integration authentication

- Worker secret `DEPLAO_INTEGRATION_SECRET` (the plugin generates ≥ 32 random bytes, base64url, when it deploys). No
  secret → every integration route is disabled (401).
- `Authorization: Bearer <secret>` (constant-time comparison) works **only** for `/api/integration/*`. Add
  `X-FinTrack-Workspace: <workspaceId>` to act with the workspace owner's rights; the audit log records the actor
  `integration:deplao`.
- Without the workspace header → only `GET /api/integration/workspaces`, `GET /api/integration/health`,
  `POST /api/integration/accounts`.
- Every other route accepts only a sign-in session (cookie `fintrack_session`).

### 2.2 Integration endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/integration/health` | `{ ok: true, version, speechAvailable }`, no workspace needed. `version` = FinTrack's `package.json` version; the plugin compares it with the bundled `fintrackVersion` to report "Có bản FinTrack mới" (a newer FinTrack is available). When the Worker is not older and was deployed by the app (workers.dev / custom domain), the plugin compares the bundle build id instead (`build` = first 16 hex characters of `sha256` in `vendor/fintrack.vendor.json`) with the `build` stored at the last deploy; a different or missing `build` also counts as an update |
| GET | `/api/integration/workspaces` | `[{ id, name, ownerEmail, currency }]`, no workspace needed |
| POST | `/api/integration/session` | Creates a regular sign-in session (same `sessions` table, valid 30 days) for the **owner** of the workspace in `X-FinTrack-Workspace` → `201 { token, expiresAt, user: { id, email, displayName, workspaceId, role } }`. Audit `integration_session` (the token is not logged). Workspace without an owner → 404 `workspace_not_found`. |
| POST | `/api/integration/accounts` | Creates an account (with its own ledger) from Deplao, no workspace needed: `{ email, displayName, password }` (validated like `/auth/register`) → `201 { user: { id, email, displayName, workspaceId, role, isAdmin, mustChangePassword: false }, session: { token, expiresAt } }`. The first FinTrack user is the admin, later ones are regular accounts. Email already registered → 409 `conflict`. Audit `account_created` `{ email, by: 'deplao' }` (the password is not logged). The public `/api/auth/register` still closes after the first account. |
| POST | `/api/integration/transcribe` | `{ audio: base64, mime }` (≤ 5 MB) → `{ text, model }` via Workers AI Whisper; counts toward the daily AI calls |
| GET | `/api/integration/context` | Ledger context (wallets, categories, default wallet, time zone); not used by the app |
| POST | `/api/integration/transactions` | Records a transaction directly, idempotent by `externalId`; not used by the app (every write goes through an assistant draft + `commit`) |

Integration errors: JSON `{ error: { code, message } }`.

**Multiple accounts (FinTrack migration 036).** One FinTrack instance can hold several accounts, each with its own
workspace (same Worker / D1). On the web, the admin (the first person who registered) creates accounts in Settings →
Accounts, or turns on public sign-up on the same page (off by default, FinTrack migration 038); inside Deplao, accounts
are created through `POST /api/integration/accounts`. The plugin only opens accounts that were signed in with a password
or created on this Deplao (§3.3); it gets new sessions with `X-FinTrack-Workspace` + `POST /api/integration/session`.
Workspace owner disabled → the session call returns **403 `account_disabled`**. Sessions and `/api/auth/session` also
carry `user.isAdmin` and `user.mustChangePassword` (inside Deplao the temporary-password change screen is not shown).
To guide new users, the Deplao build of the UI reads the FinTrack address through
`backend.call('status', { quick: true })` → `.fintrack.url`.

### 2.3 Calls from Deplao: header `X-FinTrack-Client: deplao`

The plugin adds these headers to requests from the FinTrack UI inside Deplao (the last two only on `/assistant/*`
routes, §3.3):

- `X-FinTrack-Client: deplao`
- `X-FinTrack-AI: deplao | fintrack`: the assistant chosen for the account in Deplao. **`fintrack`** = FinTrack's own
  assistant (the default OpenAI / Gemini / DeepSeek profile): the AI works **exactly as in the browser version** (API
  key, daily call limit, image reading per profile, voice per `speech_source`, model list), with no delegation; GET
  settings adds `client: "deplao"`, `aiSource: "fintrack"`. **`deplao`** or missing = the table below.
- `X-FinTrack-Assistant: <name of the Deplao AI assistant>` (optional, ≤ 80 printable characters; the server truncates
  / sanitizes it)

This header **only changes the behavior of the `/api/assistant/*` routes**; other routes are unchanged. Without the
header everything works as in the standalone version (browser / phone use the OpenAI / Gemini / DeepSeek assistant
configured in FinTrack).

| Route | With `X-FinTrack-Client: deplao` and a Deplao assistant (`X-FinTrack-AI` other than `fintrack`) |
|---|---|
| `GET /api/assistant/settings` | As before, except the current assistant configuration: `provider: "deplao"`, `name: <X-FinTrack-Assistant or "Trợ lý AI của Deplao">` ("Deplao's AI assistant"), `configured: true`, `supportsImages: false`, `speechSource: "cloudflare"`, `speechAvailable` = `supportsAudio` = an AI binding exists, plus `client: "deplao"`. `profiles`, `actions`, `contextTurns`, `maxDailyCalls`, `defaultAccountId`, `instructions`… are unchanged (editable, shared). |
| `PUT /api/assistant/settings`, profiles | Unchanged (the OpenAI / Gemini / DeepSeek profiles can be edited inside Deplao too). |
| `GET /api/assistant/models` | `{ models: [] }` (with `?profileId` → that profile's model list, for editing the profile). |
| `POST /api/assistant/chat`, `POST /api/assistant/test` | **Delegation (2 steps)**, see below. `test` with `profileId` → always tests that profile (no delegation). |
| `POST /api/assistant/transcribe` | Always Cloudflare Whisper (AI binding), ignores `speech_source`; no binding → 503. Counts as an AI call. (`mode: 'test'` + `profileId` → follows the profile.) |
| `POST /api/assistant/commit`, `GET/DELETE /api/assistant/history` | Unchanged. |

**Assistant delegation (chat / test):**

1. The request is sent as before (no `delegated`). The server validates the input (an `image` → 400 `"Trợ lý AI của
   Deplao chưa đọc được ảnh. Nhập bằng chữ hoặc giọng nói."`, i.e. "Deplao's AI assistant cannot read images yet. Use
   text or voice."), **counts 1 AI call** (no API key needed), builds the context + history exactly as today, then
   returns **HTTP 428**:

   ```json
   { "error": "Cần trợ lý AI của Deplao để trả lời.", "code": "delegate",
     "delegate": { "messages": [ { "role": "system", "content": "…" }, …history…, { "role": "user", "content": "<text>" } ],
                   "maxTokens": 4000 } }
   ```

   `error` reads "Deplao's AI assistant is needed to answer." `system` = exactly the prompt of the current JSON-mode
   branch (DeepSeek): `assistantPrompt + "\nJSON schema: " + schema + "\nJSON example: " + example + "\nContext: " +
   context`. History: the turns `{ role: "user" | "assistant", content: string }` as in the current branch (chat: from
   the DB according to `contextTurns`; test: from `history` in the body).
2. The plugin calls the Deplao assistant (`aiChat`, `raw_system: true`) with `delegate.messages`, then resends **the
   same route with the same body** plus `delegated: { output: string (≤ 60,000), model?: string (≤ 100), usage?: {
   inputTokens?, outputTokens?, totalTokens? } }`. The server **does not count another call**, rebuilds the context and
   reads `output`: it takes the first JSON object (a ```json block or surrounding text is accepted), missing action
   keys → `null`, then runs `assistantAnswer.parse` + `resolveAssistantWallets` and continues **exactly like the current
   branch** (chat: stores `assistant_messages` with `provider: "deplao"`, `model: delegated.model || "deplao"`,
   `assistant_name` = the name from the header; test: stores nothing). Invalid `output` → **502** `{ "error": "Trợ lý
   AI của Deplao không trả bản nháp JSON hợp lệ. Chưa ghi giao dịch nào.", "code": "bad_output" }` ("Deplao's AI
   assistant did not return a valid JSON draft. No transaction was recorded.").

`delegated.usage` (integers ≥ 0, taken from the `prompt_tokens` / `completion_tokens` / `total_tokens` that `aiChat`
returns) is added to the token count of `deplao:<assistant name>` (`GET /api/assistant/usage`, FinTrack → Settings →
AI assistant); without it only the call is counted.

`delegated` is read only when the Deplao header is present; without the header it is ignored. Drafts still have to go
through `commit` (fully revalidated by the business API), so letting the client send `output` grants no extra rights.

### 2.4 FinTrack UI, Deplao build

A separate build from the same `apps/web` code (`vite build --mode deplao`, `base: './'`) into `<bundle>/app/`
(index.html + assets). The regular web build (the Worker's assets) is unchanged. In `deplao` mode
(`import.meta.env.MODE === 'deplao'`):

- **Loads the Deplao SDK** before rendering: inserts `<script src="/__deplao/sdk.js">` (absolute path: Deplao serves it
  at the root of the `deplao-plugin://<id>` origin) and waits for `onload`.
- **`api()` goes through the plugin backend** (§3.2) instead of `fetch('/api…')`, with the same semantics: status
  ≥ 400 → `throw new Error(body?.error ?? 'Không thể xử lý yêu cầu')`, 204 → `undefined`.
- No service worker / PWA registration; the install-app entry is hidden.
- The **"Tuỳ chọn Deplao"** (Deplao options) entry in Settings → `location.href = location.origin +
  '/ui/index.html#options'`.
- **Account button** at the top of the page (in the browser version too): name + email; inside Deplao it also lists the
  remembered accounts (click = `switchAccount`), "Thêm tài khoản" (Add account) and "Đăng xuất" (Sign out, `logout`).
  After every account action → `location.reload()`.
- Opening `app/index.html#add-account` (the *Thêm tài khoản* button on the plugin's Options page) → goes straight to the
  sign-in / create-account screen, like "Thêm tài khoản"; the hash is removed right away so reloading the page returns
  to the app.
- **Sign-in screen inside Deplao** (`/auth/session` returns `user: null`): a FinTrack with no accounts (`needsSetup`) →
  straight to "Tạo tài khoản FinTrack" (Create a FinTrack account, `register`; the first account is the admin).
  Otherwise: the remembered accounts (click = open, × = `forgetAccount`), the sign-in form (`login`) with the
  **"Ghi nhớ mật khẩu trên Deplao này"** (Remember password on this Deplao) checkbox (on by default), and "Tạo tài
  khoản mới" (Create a new account, `register`).
- Settings → AI assistant inside Deplao: **a single list** with "Trợ lý của FinTrack" (FinTrack's assistant: the OpenAI /
  Gemini / DeepSeek profiles; a profile without a key shows "Thêm API key", Add API key) and "Trợ lý của Deplao"
  (Deplao's assistant: Deplao's default + each assistant, disabled assistants dimmed); choosing = `setAiAssistant`, then
  `/assistant/settings` is read again. The shared items (daily calls, default wallet, custom rules, context turns) stay
  editable. The image / camera buttons follow the server's `supportsImages` (hidden when `provider === "deplao"`).
- CSP of the plugin page: `script-src 'self'` (no inline script), `connect-src 'self'`, `img-src 'self' data: blob:`
  (this plugin declares no `ui.imgSrc`: the Options page shows no external images), `font-src 'self' data:`,
  `style-src 'self' 'unsafe-inline'`, no external `frame-src`. The Inter font is bundled.

---

## 3. Plugin `io.github.babyvibe.fintrack`

- Runtime `local`; permissions: `storage`, `ui:pages`, `ui:microphone` (voice input in FinTrack's AI assistant),
  `workflow:nodes`, `network`, `cloudflare:workers`, `accounts:read`, `chat:read`, `chat:send`, `media:read`, `ai:use`.
  The plugin does not pick / create Zalo groups and does not create workflows: users add the node `fintrack.record` to
  their own workflow (the trigger decides which messages reach the node).
- Minimum Deplao version (`minDeplaoVersion`): 26.11.0. The custom-domain functions (§1.1) need Deplao 26.10.4; on older
  versions the Options page asks the user to update Deplao.

### 3.1 Layout

| Path | Content |
|---|---|
| `ui/index.html` | Entry page (manifest `ui.entry`): checks the status → when ready, switches straight to the FinTrack UI; otherwise shows the setup screen. `#options` = the **Options** page ("Tuỳ chọn"). |
| `vendor/fintrack/` | Bundle from FinTrack: `bundle.json`, `worker/`, `assets/`, `migrations/`, `app/` (Deplao build of the UI), `LICENSE`, `THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_LICENSES.md`. |
| `vendor/fintrack/app/index.html` | FinTrack UI inside Deplao (navigation stays within the same `deplao-plugin://<id>` origin). |
| `vendor/fintrack.vendor.json` | Written by `npm run vendor`: FinTrack version, file count, `sha256` of the bundle (its first 16 hex characters are the bundle `build` id, §2.2). The release package keeps it without `source` and `vendoredAt`. |

### 3.2 UI ↔ backend protocol (`deplao.backend.call`)

- `api`: `{ method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE', path: string, body?: any }`; `path` starts with `/` and is
  relative to `/api` (e.g. `/auth/session`, `/transactions?page=2`). Returns:
  - `{ ok: true, status, body }`: done (body = parsed JSON, `null` for 204 / empty);
  - `{ ok: true, pending: '<id>' }`: not done after ~20 seconds (AI assistant…);
  - `{ ok: false, error: { code, message } }`: plugin-side error (not deployed, network…).
- `apiResult`: `{ id }` → the same shapes as above (`pending` if still running). The UI polls every ~400 ms and gives
  up after 5 minutes.
- `aiAssistants`: `{}` → `{ ok, supported, assistants: [{ id, name, platform, model, enabled, isDefault }], selectedId,
  defaultAssistant, fintrack: { available, profiles: [{ id, name, provider, model, configured }], defaultProfileId },
  choice: { source: 'deplao' | 'fintrack', id } }` for the **account currently open** (`selectedId` empty = Deplao's
  default).
  `setAiAssistant`: `{ source: 'fintrack', profileId }` (sets the default profile through
  `POST /assistant/profiles/:id/default`; FinTrack rejects a profile without a key) or `{ source: 'deplao', id | null }`
  → `{ ok, choice, assistant: { source, id, name, model, chosen? } }`; a disabled / removed Deplao assistant → error; no
  account open → `NOT_CONFIGURED`.
  The choice is stored per account and applies to the assistant inside FinTrack and to the node writing to that ledger
  (a node with its own `assistantId` uses that Deplao assistant).
- Accounts (lib/accounts):
  - `accounts`: `{}` → `{ ok, active: { workspaceId, email, name, remembered } | null, accounts: [{ workspaceId, email,
    name, active }], signedOut }` (remembered accounts; no tokens).
  - `login`: `{ email, password, remember = true }` → `{ ok, account }` (through `POST /api/auth/login`, which limits
    failed attempts; FinTrack's error messages are passed through unchanged).
  - `register`: `{ displayName, email, password, remember = true }` → `{ ok, account }` (through
    `POST /api/integration/accounts`).
  - `switchAccount`: `{ workspaceId }` → `{ ok, account }`: remembered accounts only; checks the session and, if it is
    no longer valid, gets a new one once.
  - `forgetAccount`: `{ workspaceId }` → `{ ok }` (forgetting the open account = signing out). `logout`: `{}` →
    `{ ok }`.
- `status`: `{ quick?: boolean }` → status for the entry / Options pages, bounded to ~25 s; a part that fails / times out
  only turns that part into `{ error: { code, message } }`:

  ```jsonc
  { "ok": true, "ready": true, "reason": "",          // '' | not_deployed | unreachable | bundle_incomplete
    "appPath": "vendor/fintrack/app/index.html",
    "plugin": { "id", "version" }, "deplao": { "appVersion", "apiVersion" },
    "cloudflare": { "supported", "connected", "accountName", "workersSubdomain", "missing": [], "worker": { "exists", "modifiedOn", "url" }, "workerError"? },
    "bundle": { "present", "version", "build", "migrationCount", "hasApp", … },
    "fintrack": { "url", "urlSource", "hasSecret", "secretSource", "health": { "ok", "version", "speech" },
                  "updateAvailable",                  // the Worker is older than the bundle, or a Worker deployed by the
                                                      // app (workers.dev / custom domain) has a build other than
                                                      // bundle.build (or none); the entry page writes sessionStorage
                                                      // fintrack-update-available = "1" → Overview shows "Có bản FinTrack mới"
                  "workspaceState",                   // linked | signed_out | none | single | multiple
                  "workspaceCount", "error"? },
    "account": { "workspaceId", "email", "name" } | null, "accounts": [{ …, "active" }], "signedOut",
    "session": { "active", "expiresAt" },
    "deployJob": { … } | null }
  ```

  `quick: true` (entry page): when an address is already known, `cloudflare` is skipped (returned as `null`).
  The response also carries `deploy` (the stored deploy record, including `fintrackVersion` and `build`), `domain`
  (`{ hostname, zoneName, verifiedAt }` or `null`) and `domainJob` (the latest custom-domain job); `cloudflare` also has `accountId`, `prefix` and `domains: { supported, list, error? }`, and
  `fintrack` may have `domainDown` (§3.4).
- No draft commands: drafts created from groups live in FinTrack (`GET /api/assistant/drafts`, Overview → "Chờ xác nhận"
  (pending drafts), see §3.5).
- A `path` under `/integration/` is blocked (403); the integration secret is never sent on regular routes.

### 3.3 Backend (proxy to the Worker)

- Address: the `fintrackUrl` setting > the custom domain once it answers (`verifiedAt`, §3.4) > the workers.dev address
  of the last deploy.
- Accounts: `workspace` = the account open in the UI; `accounts` = **remembered** accounts (signed in / created on this
  Deplao with "Ghi nhớ mật khẩu"); `sessions` = `{ [workspaceId]: { token, expiresAt } }`; `signedOut` after "Đăng
  xuất". **No password is stored.**
- Session for a request: the UI and the workflow node use the open account; "ok" / "huỷ" in a group use the ledger that
  created the draft. Missing / expired → `POST /api/integration/session` **only** for remembered accounts; a
  non-remembered account whose session expired is treated as signed out (the UI shows the sign-in screen; the node skips
  the message as `not_configured`). No account open: on first run (nobody remembered, never signed out) with exactly
  1 FinTrack account → that account opens automatically; otherwise the request is forwarded without a cookie (FinTrack
  shows create account / sign in).
- Forwarded headers: `Content-Type`/`Accept: application/json`, `Cookie: fintrack_session=<token>`,
  `X-FinTrack-Client: deplao`; `/assistant/*` routes add `X-FinTrack-AI: deplao | fintrack` and `X-FinTrack-Assistant:
  <Deplao assistant name>` (only with `deplao`, percent-encoded). All headers are ASCII only.
- `set-cookie` in a response: sign-in / sign-up through the FinTrack form → that account is opened (a sign-up, normally
  the first account, is also remembered); a cleared cookie → that account's session is deleted. `POST /auth/logout` from
  the UI = the `logout` command (ends the session in FinTrack, no automatic sign-in afterwards).
- 401 while using a session → delete the session (only if the stored session is exactly the token that got the 401: a
  slow request does not delete a newer session), get a new one **once** (if allowed) and resend. Getting a session:
  `404 workspace_not_found` → the account is removed from the remembered list; `404 not_found` / a body that is not a
  JSON error → old Worker (`FT_NO_INTEGRATION`, the user is asked to update FinTrack), the account is kept.
- 428 `code: "delegate"` → `aiChat({ messages: delegate.messages, max_tokens: delegate.maxTokens, raw_system: true,
  assistant_id? })` → resend with `delegated: { output, model, usage }`; 502 `code: "bad_output"` → ask the assistant
  once more (with an extra instruction to return JSON only; `usage` adds up both calls); after that the error goes back
  to the UI.
- Each `api` call runs as a background job; its result is kept for 5 minutes.

### 3.4 Options page (`ui/index.html#options`)

**Share FinTrack** (shown while FinTrack answers; see below), FinTrack on Cloudflare (status, deploy / update, notice of
a newer FinTrack, **custom domain**, address), **FinTrack accounts** (the open account, remembered accounts: "Mở" (Open) / "Quên" (Forget); *Thêm tài khoản* (Add account) →
`app/index.html#add-account`; *Đăng xuất* (Sign out) with confirmation); the **"Mở FinTrack"** (Open FinTrack) button.
There is no draft list (drafts live in FinTrack: Overview → "Chờ xác nhận"), no AI assistant section (chosen in
FinTrack → Settings → AI assistant) and no step to pick / create Zalo groups or create workflows: recording mode (draft
/ auto), replies in the group, voice, images and the assistant are settings of the `fintrack.record` node in the
workflow.

Custom domain (the row right under the Worker; the attach form opens in place): commands `domainZones` (the account's
zones for the picker), `domainAttach { sub, zone }` (background job `domain`: Deplao attaches the name after its
confirmation dialog → `https://<name>/api/integration/health` is tried every 10 seconds for up to 15 minutes →
`verifiedAt` is saved only once it answers), `domainUse { hostname }` (recheck / use a name that is already attached),
`domainDetach { hostname }`. Storage key `domain` = `{ hostname, zoneName, attachedAt, verifiedAt }`. FinTrack address:
the **"Địa chỉ FinTrack"** (FinTrack address) setting > the custom domain that answered (`verifiedAt`) > workers.dev.
`status` drops names that are no longer attached to the Worker; if the name in use does not answer while workers.dev
works → `verifiedAt` is cleared (workers.dev is used for now, `fintrack.domainDown`). Deploy: if the address in use does
not answer while workers.dev works → the verify step says exactly what to fix.

Share FinTrack ("Chia sẻ FinTrack", first section): the address to send (`status.fintrack.url`: the custom domain in
use, else workers.dev) with a copy button, then FinTrack's public sign-up, the same instance settings as FinTrack →
Settings → Accounts → "Đăng ký tài khoản", as lines under their rows: the switch "Cho người khác tự tạo tài khoản"
(`registrationOpen`; off → a hint that the address only signs in existing accounts) and "Tối đa tài khoản"
(`maxAccounts`, 0 = no limit) with the current number of accounts. Commands (lib/sharing), through `proxy.forward` with
the session of the **account open** in Deplao (FinTrack checks that it is an admin):
- `shareSettings`: `{}` → `{ ok, access: 'admin', settings: { registrationOpen, maxAccounts, signupsPerIpHour,
  aiDailyCap, accounts } }` (`GET /api/admin/settings`) | `{ ok, access: 'not_admin', message }` (FinTrack's 403
  message) | `{ ok, access: 'signed_out', message }` (no account open: FinTrack is not called; or the session is gone).
- `setShareSettings`: `{ registrationOpen?: boolean, maxAccounts?: integer 0 to 1,000,000 }` → `{ ok, access: 'admin',
  settings }` (`PUT /api/admin/settings` with only the given fields); FinTrack's error message is passed through
  (`FT_FORBIDDEN` for a regular account), no account open → `NOT_SIGNED_IN`, invalid value → `VALIDATION_ERROR`.
- Both: not deployed → `NOT_DEPLOYED`; a Worker without the route (404) → `FT_OUTDATED` (update FinTrack).

### 3.5 Workflow nodes

- **`fintrack.record`**: "FinTrack: ghi chi tiêu từ tin nhắn" (FinTrack: record spending from messages). Text, voice
  (`downloadMessageMedia` → `/api/integration/transcribe`) or **image** messages go through **FinTrack's AI assistant**
  (§2.3; session of the **account open** in FinTrack on Deplao; the assistant follows that ledger's choice) in a separate
  conversation per group. Content sent: `Người gửi: <tên>\n<tin>` ("Sender: <name>" + the message), with `inbox: {
  channel: "zalo", group, sender, text }` → FinTrack keeps an answer that contains items as a **draft** (table
  `assistant_drafts`, migration 039) in that ledger: Overview counts them (`GET /api/dashboard` → `assistantDrafts`),
  **"Chờ xác nhận"** lists them (`GET /api/assistant/drafts`), the confirmation cards record each item with
  `POST /api/assistant/commit` (the draft closes once its last item is recorded), *Bỏ qua* (Dismiss) =
  `POST /api/assistant/drafts/:id/dismiss`. An old Worker does not return `draft` → the plugin logs a hint to run
  "Cập nhật FinTrack" (Update FinTrack).
  - Message type: the flattened trigger payload has no `msgType` → a message without text, or with `$trigger.images`,
    is looked up with `getMessage` (`chat.voice` → voice, `chat.photo` → image; `chat.gif` / sticker → skipped). The
    trigger (set up by the user in the workflow) should accept text, voice and image messages of the groups to record.
  - **Images** (`images`, on by default): only when the ledger's assistant is **FinTrack's assistant** and can read
    images (`GET /assistant/settings` → `supportsImages`: OpenAI, Gemini, DeepSeek Flash); a Deplao assistant / a model
    that cannot read images → skipped (`skipped: image_unsupported_ai`) with a notice in the group (at most once / 10
    minutes / group). The image is fetched with `downloadMessageMedia`; too large / another format / an error → the image
    link in the message (`href`, `params.hd`, Referer chat.zalo.me); JPG / PNG / WebP only (detected from the first
    bytes), ≤ ~4.4 MB → `POST /api/assistant/chat` `{ text: "Người gửi: <tên>\n[Ảnh] <chú thích>", image:
    "data:image/…;base64,…" }` (`[Ảnh] <chú thích>` = "[Image] <caption>"). Images are always sent to the assistant (no
    "mentions money" filter); auto mode only records when the amount appears in the image caption.
  - `assistantId` (optional, `x-widget: "assistant"`: Deplao shows an assistant picker with a "Mặc định" (Default)
    option): a dedicated Deplao assistant for the node; if it no longer exists in Deplao → falls back to the ledger's
    choice.
  - `draft` mode (default): drafts await confirmation; reply "📝 Bản nháp: … Trả lời “ok” để ghi, “huỷ” để bỏ." ("Draft:
    … Reply 'ok' to record, 'huỷ' to drop.")
  - `auto` mode: records right away (through `POST /api/assistant/commit`) the income / expense / transfer drafts whose
    amount appears in the message, with the wallet set (income / expense: category set too) and no field listed in the
    assistant's `unsure`; everything else awaits confirmation. Replies "✅ … Sai thì trả lời “huỷ”." ("If wrong, reply
    'huỷ'.") / "❓ <câu hỏi của trợ lý>" (the assistant's question).
  - **"ok" / "huỷ" in the group** ("huỷ" = cancel): the plugin remembers which reply belongs to which draft (storage
    `replies`: `{ ids: [msg_id, cli_msg_id], threadId, senderId, workspaceId, messageId, pending, at }`, 7 days, ≤ 300).
    A text message that consists only of a command word (ignoring punctuation and particles such as "ạ", "nhé", "đi"…)
    is a command when it replies to (quotes) an assistant message (the quote comes from the trigger, otherwise from
    `getMessage` → `quote`; quoted commands also accept short words such as "ừ", "đúng", "sai", "không" (yes, right,
    wrong, no), 👍…), or, without a quote, when it is an unambiguous word (confirm: ok, oke, xác nhận, đồng ý, ghi;
    cancel: huỷ, hủy, xoá, bỏ) sent within 30 minutes after the assistant answered the sender's own message ("ok" → the
    latest draft that is still pending, "huỷ" → the latest reply). Only the sender of the original message or the
    ledger owner (messages from the user's own Zalo accounts on this Deplao) may confirm / cancel; anyone else replying
    to the assistant's message → "⚠️ Chỉ người gửi…" ("Only the sender…", `not_allowed`). "ok" →
    `POST /api/assistant/drafts/:id/confirm` (FinTrack records every pending item exactly as
    drafted; missing note → the message text, missing date → the message's date; missing category / wallet / amount →
    an error result, reply "⚠️ Chưa ghi …: <chỗ thiếu>. Chọn nốt trong FinTrack…" ("Not recorded …: <what is missing>.
    Finish it in FinTrack…")). "huỷ" → `POST /api/assistant/drafts/:id/undo` (reverses the income / expense / transfer
    entries already recorded with `/api/transactions/:id/reverse` and drops the pending part; entries already edited /
    cancelled in FinTrack are left alone). Repeats: `already` → when quoted, "✅ Khoản này đã ghi rồi." ("Already
    recorded.") / "↩️ Khoản này đã huỷ rồi." ("Already cancelled."), unquoted → silent; a dismissed draft → 409. New
    replies are remembered as well (quote "✅ Đã ghi" to cancel it). Quoting a message that is not from the assistant →
    ordinary chat.
  - Every action of FinTrack's assistant has `unsure`: names of the fields the assistant guessed / could not read
    (`type`, `accountId`, `destinationAccountId`, `categoryId`, `instrumentId`, `amount`, `date`, `note`; missing or
    null in older versions). An image without text still becomes a draft (e.g. a bank transfer screenshot
    "NGUYEN VAN A chuyen tien": expense, `categoryId` null, `unsure` contains `categoryId`); the assistant only asks
    back when it cannot read the amount.
  - A text message that does not mention money → skipped immediately (`no_amount`), before any storage write.
  - Dedup per Zalo message (`zalo:<threadId>:<msgId>`, shared by every Zalo account that receives the same message;
    kept 7 days, at most 5000 messages); the plugin's own replies are skipped: the exact id of a message it just sent
    (even when another of the user's Zalo accounts receives it), or a message starting with ✅ ❓ ⚠ 🎙 📝 ↩ from a Zalo
    account on this Deplao.
  - Errors: setup not finished (not deployed / no account open, wrong secret, old Worker, ledger owner disabled) →
    skipped silently (`not_configured`); temporary errors → reported in the group at most once / 10 minutes / group
    (FinTrack / assistant not answering, out of calls 429, assistant without an API key 400). In both cases the processed
    mark is removed so the message can run again.
  - Outputs: `recorded` (number of items recorded), `drafts` (number of items awaiting confirmation), `items`, `text`,
    `reply`, `skipped` (commands: `not_allowed`, `already`, `draft_gone`).
- **`fintrack.transcribe`**: "FinTrack: ghi âm thành chữ" (FinTrack: voice to text). Outputs `text`, `durationSec`,
  `skipped`, for further processing in the workflow.
