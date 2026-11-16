# Security

## Reporting a vulnerability

Do not open a public issue. Use **GitHub → Security → Report a vulnerability** (a private report) on the
`babyvibe/fintrack-deplao-app` repository, and describe how to reproduce the problem and which versions of the app /
Deplao / FinTrack you use. We respond within 7 days and credit the reporter (if you wish) when the fix is released.

Supported versions: the latest release (`0.x`: only the latest release gets fixes).

## Data flows

| Data | Where it goes | Where it is stored |
|---|---|---|
| Every request of the FinTrack UI inside Deplao | iframe → `deplao.backend.call('api')` → app backend → the user's FinTrack Worker (HTTPS) | D1 on the user's Cloudflare account |
| Assistant prompt + context (built by FinTrack: categories, wallets, conversation history), **FinTrack's assistant** | FinTrack Worker → OpenAI / Gemini / DeepSeek with the API key you entered in FinTrack (as in the standalone version) | Subject to the AI provider's policy |
| Same, **Deplao's assistant** | Worker → (428) → app backend → Deplao's AI assistant (`aiChat`, `raw_system`) → the provider you configured in Deplao | Deplao's AI usage log (on the machine) |
| Zalo group messages (optional: text, voice, images) | Workflow node → FinTrack's AI assistant as above (images only with FinTrack's assistant) | `assistant_messages` + `assistant_drafts` (drafts awaiting confirmation) in your D1; `deplao.storage` only remembers which reply message belongs to which draft |
| Voice messages (≤ 5 MB) | Downloaded by Deplao with the account's session → Worker → Workers AI (Whisper) | Not stored |
| Images in groups (≤ ~4.4 MB) | Downloaded by Deplao → Worker → the AI provider of FinTrack's assistant | Images are not stored (only the text draft) |

The app has no server of its own and sends data to no third party other than the ones listed above.

## FinTrack integration secret

- `DEPLAO_INTEGRATION_SECRET` is 32 random bytes (`crypto.randomBytes`, base64url) generated at deploy time and set on
  the Worker through Cloudflare's secrets API (via Deplao). Redeploying keeps the Worker's other secrets
  (`keep_bindings`).
- The secret is used **only** for `/api/integration/*` (health, workspaces, getting a workspace-owner session, creating
  accounts from Deplao, speech-to-text). Regular FinTrack routes only accept a sign-in session; the proxy blocks every
  `/integration/*` path coming from the UI (403) and never sends the secret with regular routes.
- The copy used to call FinTrack lives in **`deplao.storage`** (key `integration.secret`): the app's private store
  inside the Deplao workspace database **on this machine**, which Deplao does not encrypt separately. To have it
  encrypted, enter it in the *Secret tích hợp* (integration secret) field of the app's settings (an `x-secret` field
  that Deplao stores encrypted; it always takes precedence and is never copied into storage).
- Rotating the secret: Options page ("Tuỳ chọn") → tick "Tạo secret tích hợp mới" (Create a new integration secret) →
  *Cập nhật FinTrack* (Update FinTrack); the new secret is saved only after the Worker has accepted it. When the secret
  comes from the app settings this checkbox is disabled: change the value in the settings, then run *Cập nhật
  FinTrack*. A leaked secret can be used to get workspace-owner sessions, so rotate it right away.

## Accounts and sign-in sessions

- **Passwords are never stored.** Signing in / creating an account inside Deplao sends the password once to FinTrack
  (HTTPS, through the app backend; never logged). FinTrack limits wrong passwords (5 attempts / 15 minutes per email +
  IP).
- Session tokens (`fintrack_session`, valid 30 days) are stored per account in `deplao.storage` (key `sessions`); they
  are never returned to the UI (the `status` / `accounts` commands only report accounts, never tokens) and never logged.
- **"Ghi nhớ mật khẩu trên Deplao này"** (Remember password on this Deplao) = the account goes into the `accounts`
  list: when its session expires, the app gets a new session with the integration secret, so switching accounts does
  not ask for the password again. The app uses the secret to get sessions **only for remembered accounts**: other
  accounts must sign in with their password, and a non-remembered account whose session expires must sign in again
  (until then the workflow node skips messages as `not_configured`). Note: anyone who holds the secret (whoever
  controls this Deplao machine) can technically get a session for every ledger; that is why the secret must be kept
  private (see above).
- Signing out ends the session in FinTrack and deletes the token, with no automatic sign-in; the account stays in the
  remembered list until × / *Quên* (Forget) is clicked. An account disabled by the admin → FinTrack refuses to issue
  sessions for it (403 `account_disabled`).
- Creating an account in Deplao goes through `POST /api/integration/accounts` (secret). Public sign-up on FinTrack's
  web UI is closed after the first account unless the admin turns on *Đăng ký tài khoản* (account sign-up, in Settings
  → Accounts); when it is on, people who sign up get a regular account with its own ledger, within the limits the admin
  sets.
- Uninstall the app with the delete-data option ("Xoá dữ liệu") to remove the secret and the tokens from the machine.

## Cloudflare token

The app **never** receives the Cloudflare token. Every Worker / D1 operation goes through `deplao.cloudflare` in
Deplao's main process, only on resources named `fintrack` or `fintrack-*` (permission `cloudflare:workers`).

Custom domain: the app can only ask Deplao to attach a **new subdomain** (e.g. `fintrack.<your domain>`) to the
`fintrack` Worker. Deplao checks the name (never the apex domain, never over an existing DNS record, never a name of
another Worker) and **asks you in a Deplao dialog** before writing anything; clicking "Không" (No) changes nothing.
Detaching only touches names of the `fintrack` Worker.

## Defenses in the code

- **Proxy**: allow-listed methods; the path must start with `/` and contain no `..`, `\`, `#` or control characters;
  `/integration` is blocked even when upper-cased / percent-encoded; forwarded headers are ASCII only (the assistant
  name is percent-encoded); responses > 5 MB are rejected with a hint to open FinTrack in a browser.
- **AI assistant**: the assistant's answer is only a proposal. FinTrack validates it again (schema, wallets,
  categories), and every write goes through `POST /api/assistant/commit` → the business API (idempotent per draft).
  `bad_output` → at most one retry.
- **Auto mode**: only income / expense / transfer items whose amount **appears in the text** (images: in the caption),
  with the wallet set (plus the category for income / expense, the destination for transfers) and no field marked
  `unsure`; everything else awaits confirmation.
- **"ok" / "huỷ" in the group** ("huỷ" = cancel): only the sender of the original message or the ledger owner (a Zalo
  account on this Deplao); other members only get a notice. "ok" records exactly the items FinTrack kept (amount,
  wallet and category are not changed); "huỷ" only reverses entries recorded from that same draft, and entries already
  edited / cancelled in FinTrack are left alone. A dismissed draft cannot be recorded any more.
- **Zalo groups**: dedup per message (7 days); the app's own replies are skipped (an id it just sent, or ✅ ❓ ⚠ 🎙 📝 ↩
  from a Zalo account on this Deplao); errors are reported in the group at most once / 10 minutes and never include
  technical details. Fallback downloads of voice / images go **only** over HTTPS from the Zalo CDN (`*.zdn.vn`,
  `*.zadn.vn`, `*.dlfl.vn`); images are checked by their first bytes (JPG / PNG / WebP) and by size before they are
  sent.
- **UI**: no inline script; no external images (the manifest declares no `ui.imgSrc`, so Deplao's CSP only allows
  `'self'`, `data:` and `blob:` images); displayed text is inserted as text (`textContent`), never as HTML.
- **Release package**: only the files needed at runtime plus the user and legal documents (manifest, icon, `backend/`,
  `ui/`, `vendor/fintrack/`, `vendor/fintrack.vendor.json` without its `source` and `vendoredAt` fields, `README.md`,
  `LICENSE`, `SECURITY.md`, `CHANGELOG.md`); file names and limits are checked like Deplao's installer does; no paths or
  timestamps from the packing machine (the package is reproducible and can be verified by its sha256).
- **Dev tools**: `npm run preview` listens on `127.0.0.1` only and serves only `ui/` and `vendor/fintrack/app/`; the
  Miniflare-based tests use a placeholder `request.cf` (no calls to Cloudflare).
