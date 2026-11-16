# Architecture

A Deplao app with runtime `local`: the UI runs in an iframe at `deplao-plugin://io.github.babyvibe.fintrack/…`, and a
Node backend runs in a separate process managed by Deplao. The boundaries between the three parts (Deplao · FinTrack ·
this app) are fixed in [CONTRACTS.md](CONTRACTS.md): read it before changing the protocol, the permissions or the bundle
format. Minimum Deplao version: 26.11.0 (custom domains need 26.10.4).

## Overview

```
┌─────────────────────────────── Deplao (user's machine) ────────────────────────────────┐
│ iframe deplao-plugin://<id>                                                            │
│   ui/index.html ── status ──► ready? ── yes ──► vendor/fintrack/app/index.html         │
│        │ no / #options                          (FinTrack UI, Deplao build)            │
│        ▼                                                  │ api() →                    │
│   setup page / Options page                               │ deplao.backend.call        │
│                                                           ▼ ('api', 'login', …)        │
│ ┌────────────────────────────── app process (backend/) ──────────────────────────────┐ │
│ │ commands ── api → jobs (wait ≤ 20 s, keep result 5 min) → proxy.forward            │ │
│ │          ── accounts / login / register / switchAccount / logout (lib/accounts)    │ │
│ │          ── status / deploy* / domain* / share* (entry and Options pages)          │ │
│ │ proxy: per-account sessions ─missing─► POST /api/integration/session               │ │
│ │        Cookie fintrack_session + X-FinTrack-Client + X-FinTrack-AI (+ assistant)   │ │
│ │        428 delegate → deplao.ai.aiChat(raw_system) → resend with delegated ────────┼─┼─► Deplao AI assistant
│ │ nodes: fintrack.record / fintrack.transcribe (Zalo group workflows)                │ │
│ │ deploy*, domain* → deplao.cloudflare (D1, migrations, Worker, secret, domain)      │ │
│ └───────────────────────────────────────┬────────────────────────────────────────────┘ │
└─────────────────────────────────────────┼──────────────────────────────────────────────┘
                                          ▼ deplao.http.fetch (HTTPS, ≤ 5 MB per response)
            ┌────────────────── user's Cloudflare account ──────────────────┐
            │ Worker "fintrack": /api/* (regular routes = sign-in session;  │
            │   /api/integration/* = secret), web assets, D1, Workers AI    │──► OpenAI / Gemini / DeepSeek
            └───────────────────────────────────────────────────────────────┘    (FinTrack's assistant)
```

## Backend modules

| File | Responsibility |
|---|---|
| `backend/index.js` | Entry point: `nodes` (`fintrack.record`, `fintrack.transcribe`, wrapped so an unexpected error never breaks the workflow), `commands`, `onSettingsChanged`. |
| `lib/commands.js` | UI commands: `api` / `apiResult`, `status`, `aiAssistants` / `setAiAssistant`, `deployCheck` / `deployStart` / `deployStatus` / `job`, `domainZones` / `domainAttach` / `domainUse` / `domainDetach`; the account commands come from `lib/accounts.js`, `shareSettings` / `setShareSettings` from `lib/sharing.js`. No draft commands (drafts live in FinTrack: Overview → "Chờ xác nhận"). No commands to pick / create Zalo groups or to create workflows (users add the node to their own workflow). Every command returns `{ ok, … }` / `{ ok: false, error }`; multi-step commands (`status`, `switchAccount`) are bounded to ~25 s because Deplao cuts UI commands off after 30 s. |
| `lib/accounts.js` | FinTrack accounts in Deplao: `accounts`, `login`, `register` (`/api/integration/accounts`), `switchAccount`, `forgetAccount`, `logout`. |
| `lib/sharing.js` | "Chia sẻ FinTrack" (Share FinTrack) on the Options page: `shareSettings` / `setShareSettings` read and save FinTrack's public sign-up (`GET` / `PUT /api/admin/settings`, the same settings as FinTrack → Settings → Accounts) through `proxy.forward` with the session of the open account; FinTrack decides whether it is an admin. |
| `lib/proxy.js` | Proxy from the UI / node to the Worker: path validation (blocks `/integration`), per-account sessions, sign-out, 401 handling, assistant headers, Deplao assistant delegation (428 / 502). |
| `lib/record.js` | The node that records spending from Zalo messages, step by step (`recordMessage` → `processMessage`): filter → dedup → input (text / voice / image) → FinTrack's AI assistant (with `inbox`, so FinTrack keeps the draft) → auto-record / await confirmation → reply and remember reply ↔ draft. "ok" / "huỷ" in the group (`commandTarget` → `runCommand`): quoting an assistant reply, or the sender's latest reply → `POST /api/assistant/drafts/:id/confirm` / `undo`. One pass = a `Turn` (node config, 52 s budget, replies / error notices in the group). |
| `lib/fintrackClient.js` | Integration routes (Bearer secret): `health`, `workspaces`, `session`, `createAccount`, `transcribe`. |
| `lib/state.js` | `deplao.storage`: secret, deploy, custom domain, accounts (open / remembered / signed out), sessions, assistant per account, reply ↔ draft, processed keys. Every read-modify-write runs inside one lock (a mutex that must not be nested) with strict reads: a failed read never overwrites stored data. |
| `lib/deploy.js`, `lib/cloudflare.js` | Checks + deploy through `deplao.cloudflare`; `readBundleInfo()` reads `vendor/fintrack/bundle.json` and the bundle build id from `vendor/fintrack.vendor.json`. |
| `lib/domain.js` | Custom domain for the Worker through `deplao.cloudflare` (`zones`, `workers.domains.*`): attach as a background job (Deplao's confirmation dialog, then `https://<hostname>/api/integration/health` every 10 s for up to 15 min), recheck / use, detach. |
| `lib/message.js`, `lib/money.js`, `lib/reply.js` | Reading the trigger message + dedup key + image type; Vietnamese money amounts (quick filter, auto-record condition); the 📝 / ✅ / ❓ / ⚠️ / 🎙️ / ↩️ replies and the "ok" / "huỷ" words. |
| `lib/jobs.js`, `lib/util.js`, `lib/errors.js`, `lib/constants.js` | Background jobs; utilities; errors with a code + a Vietnamese message; constants and storage keys. |

## UI ↔ backend

- `api({ method, path, body })`: `path` is relative to `/api`. Returns `{ ok: true, status, body }`,
  `{ ok: true, pending }` (not done after ~20 s → the UI polls `apiResult` every ~400 ms and gives up after 5 minutes)
  or `{ ok: false, error }` (not deployed, network, response > 5 MB…). `/integration/*` → `{ ok: true, status: 403 }`.
- Account and assistant commands: see CONTRACTS §3.2.
- Forwarded headers are ASCII only: `Cookie: fintrack_session=<URI-encoded token>`, `X-FinTrack-Client: deplao`;
  `/assistant/*` routes add `X-FinTrack-AI: deplao | fintrack` and
  `X-FinTrack-Assistant: encodeURIComponent(<Deplao assistant name>)`.
- Entry and Options pages (`ui/`): plain HTML/CSS/JS, no inline script (CSP). The entry page calls
  `status { quick: true }`: when FinTrack is ready it replaces itself with the FinTrack UI, otherwise it shows the setup
  page and loads the full `status` (if the quick check takes more than 4 s, the page is shown while it waits). The
  Options page ("Tuỳ chọn") has three sections: *Chia sẻ FinTrack* (Share FinTrack, shown while FinTrack answers: the
  address to send with a copy button, the public sign-up switch and the account limit), *FinTrack trên Cloudflare*
  (FinTrack on Cloudflare: status, deploy / update, custom domain, address) and *Tài khoản FinTrack* (FinTrack
  accounts). Each section redraws its whole block
  when the status changes (`FT.mount` keeps the focus and caret of the field being edited); `refresh()` reads `status`
  again, and a call made while a read is in progress triggers exactly one more read. Lazily loaded data: the sign-up
  settings (`shareSettings`, read again after every status load while FinTrack answers, since they depend on the open
  account) and the list of Cloudflare zones for the custom-domain form (`domainZones`, loaded when the form opens); a
  failed load shows a retry button.

## Accounts and sessions

Each FinTrack account has its own workspace (ledger); the app keeps one session per workspace.

1. The **open account** (`workspace`) is the account the UI uses. When no account is open: on first run (nobody
   remembered, never signed out) and with exactly one FinTrack account, that account opens automatically; otherwise
   requests go out without a cookie so FinTrack shows its sign-in / create-account screen (a FinTrack with no accounts
   shows the create-account screen).
2. A session that is still valid (> 2 minutes left) is used. Expired / missing → `POST /api/integration/session`
   **only if** the workspace is a **remembered** account (`accounts`); a non-remembered account whose session expired
   is treated as signed out.
3. Sign in (`login` → `POST /api/auth/login`) / create an account (`register` → `POST /api/integration/accounts`) →
   store the session, open the account, remember it if requested. **No password is stored.**
4. Sign out (`logout`, or `POST /auth/logout` from the UI) → ends the session in FinTrack, deletes the token, sets
   `signedOut` (no automatic sign-in); the account stays in the remembered list until *Quên* (Forget).
5. 401 while using a session (except `/auth/login`, `/auth/register`) → delete the session (only if the stored token is
   that same token: a slow request does not delete a newer session), get a new one once if allowed, resend.
6. Errors when getting a session: `404 workspace_not_found` → the account no longer exists and is removed from the
   remembered list; `403 account_disabled` → the UI treats it as signed out; a 404 from an old Worker → the user is
   asked to update FinTrack, the account is kept.
7. The workflow node uses the open account's session the same way (including the first-run automatic opening); when it
   has no usable session it skips the message as `not_configured`.

## AI assistant

The choice is stored per workspace (`ai.choice`): **FinTrack's assistant** (the default OpenAI / Gemini / DeepSeek
profile in FinTrack, `X-FinTrack-AI: fintrack`; FinTrack calls the provider itself and can read images) or **Deplao's
assistant** (`X-FinTrack-AI: deplao` → FinTrack returns 428 with the prompt, the app calls `aiChat` with
`raw_system: true` and resends the answer for FinTrack to validate; `bad_output` → one more attempt). With nothing
chosen, Deplao's default assistant answers. A workflow node can name its own Deplao assistant (`assistantId`).

## Node `fintrack.record`

```
message → our own reply? (id just sent, or ✅❓⚠🎙📝↩ from a Zalo account on this Deplao) → own_reply
    → plain-text “ok” / “huỷ” for an assistant reply (quoted, or ≤ 30 min after a reply to the sender)? → command
    → plain text that mentions no money (and is not a command) → no_amount   (no storage write, no AI call)
    → key zalo:<thread>:<msg> already processed (7 days; shared by every Zalo account receiving it)? → duplicate
    → command? → runCommand (below)
    → message type (the trigger has no msgType → getMessage when there is no text or there is an image link)
    → ledger = the account open in FinTrack on this Deplao (no group selection step)
        voice → downloadMessageMedia (fallback: Zalo CDN link) → /api/integration/transcribe → must mention money
        image → can the ledger's assistant read images? no → notice in the group (≤ 1 per 10 min) → image_unsupported_ai
                → downloadMessageMedia (fallback: Zalo CDN link) → JPG / PNG / WebP ≤ ~4.4 MB
    → POST /api/assistant/chat { conversationId = UUIDv5(zalo:<acc>:<thread>), text: "Người gửi: <tên>\n<tin>",
                                 image?, inbox } with the ledger's session
    → no items: the answer contains "?" → ❓; otherwise silent (not_transaction)
    → FinTrack keeps the items as a draft in its D1 (Overview → "Chờ xác nhận")
        draft mode: 📝 · auto mode: commit eligible income / expense / transfer items → ✅ (the rest stay pending)
    → reply in the group; remember reply ↔ draft in storage "replies" (for “ok” / “huỷ”)

runCommand: only the original sender or the ledger owner (otherwise not_allowed)
    → POST /api/assistant/drafts/:id/confirm (“ok”) | /undo (“huỷ”) on the ledger that created the draft
    → reply ✅ / ↩️ / ⚠️ and update the remembered reply (still pending or not)
```

Auto mode only commits an item when its amount appears in the text (images: in the caption), the wallet is set (plus
the category for income / expense, the destination for transfers) and the assistant marked nothing as `unsure`.

Errors: setup not finished (not deployed / no account open, wrong secret, old Worker, ledger owner disabled) → skipped
silently (`not_configured`). Temporary errors → reported in the group at most once / 10 minutes / group, with a message
for the kind of error: FinTrack not answering / too slow, assistant error, assistant out of calls (429), the ledger's
assistant has no API key (400). In both cases the processed mark is removed so that a rerun (e.g. *Chạy thử*, Test run,
in the workflow) can still process the message.

`skipped` is empty when the message was handled; otherwise it is one of `no_message`, `own_reply`, `no_amount`,
`duplicate`, `unsupported_message`, `voice_disabled`, `images_disabled`, `not_configured`, `voice_failed`,
`empty_transcript`, `image_unsupported_ai`, `image_failed`, `fintrack_error`, `ai_error`, `not_transaction`, `unclear`
(the assistant asked a question), `internal_error`, and for "ok" / "huỷ": `not_allowed`, `already`, `draft_gone`.

## Workflows

The app does not create or edit workflows (CONTRACTS §3). Users add `fintrack.record` (and, if they want the text of
voice messages, `fintrack.transcribe`) to their own workflow, usually after a Zalo message trigger (`trigger.message`)
limited to the groups to record; the trigger decides which messages reach the node, so it should accept text, voice and
image messages. Node settings (manifest `configSchema`): `account` (Zalo account that replies; empty = the workflow's
account / the account that received the message), `mode` (`draft` | `auto`), `replyInGroup`, `quoteReply`, `voice`,
`images`, `assistantId`. Entries always go to the FinTrack account open in Deplao.

## Deploy and updates

- `deployCheck` checks that this Deplao supports `deplao.cloudflare`, that Cloudflare is connected with the required
  token permissions and that the bundle is present, and reports whether the `fintrack` Worker already exists; the UI
  then asks for confirmation (updating an existing Worker needs an extra tick).
- `deployStart` runs the background job `deploy` (one at a time; progress is saved in `deploy.job` so a reopened page
  still shows it, and a job cut off by a restart is reported as `INTERRUPTED`): `d1.ensure` → `d1.migrate` (applied
  migrations are skipped) → `workers.deployBundle` (D1 binding `DB`, Workers AI binding `AI`, secret
  `DEPLAO_INTEGRATION_SECRET`, workers.dev on) → `/api/integration/health` on the address the app will use. The
  secret comes from the app settings, otherwise it is the stored one (a new random one on the first deploy, or when
  "Tạo secret tích hợp mới" (Create a new integration secret) is ticked); the app stores it only after the Worker
  accepted it. The deploy record (`deploy`) stores the URL, `fintrackVersion` and the bundle `build`.
- Update detection (`status` → `fintrack.updateAvailable`): the Worker reports an older `version` than the bundled
  `fintrackVersion`, or the Worker was deployed by the app (workers.dev / custom domain) and the `build` in the deploy
  record is missing or differs from `readBundleInfo().build` (the first 16 hex characters of `sha256` in
  `vendor/fintrack.vendor.json`). The Options page then shows a notice and highlights "Cập nhật FinTrack" (Update
  FinTrack); when the app opens FinTrack it writes sessionStorage `fintrack-update-available` = "1", and FinTrack's
  Overview shows a "Có bản FinTrack mới" (a new FinTrack version is available) row.

## Storage (`deplao.storage`)

| Key | Content |
|---|---|
| `integration.secret` | Integration secret (see SECURITY.md) |
| `deploy`, `deploy.job` | Last deploy (`url`, `fintrackVersion`, `build`, D1, migrations…) + its progress |
| `domain` | Custom domain of the Worker in use / waiting for DNS and certificate (`verifiedAt` = 0): `{ hostname, zoneName, attachedAt, verifiedAt }` |
| `workspace` | Open account `{ id, name, email, linkedAt }` |
| `accounts` | Remembered accounts `[{ workspaceId, email, name, rememberedAt }]` (≤ 20) |
| `sessions` | Sessions per workspace `{ [workspaceId]: { token, expiresAt, savedAt } }` |
| `signedOut` | `true` after signing out (no automatic sign-in) |
| `ai.choice` | Assistant per workspace `{ [workspaceId]: { source: 'deplao' \| 'fintrack', id, savedAt } }` |
| `replies` | Assistant replies in groups → FinTrack drafts `[{ ids, threadId, senderId, workspaceId, messageId, pending, at }]` (7 days, ≤ 300) |
| `seen` | Processed message key → timestamp (7 days, ≤ 5000) |
