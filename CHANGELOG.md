# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-11-13

Ships FinTrack 0.1.0 (unchanged). Requires Deplao 26.11.0 or later.

### Added

- **Share FinTrack** (*Chia sẻ FinTrack*) at the top of the Options page, once FinTrack answers: the address to send
  (the custom domain in use, otherwise workers.dev) with a copy button; the switch *Cho người khác tự tạo tài khoản*
  (public sign-up: people create their own account on the sign-in page, each with separate finances); *Tối đa tài
  khoản* (account limit, 0 = no limit) with the current number of accounts. While the switch is off, the page says the
  address only signs in existing accounts. Same settings as FinTrack → Settings → Accounts → *Đăng ký tài khoản*,
  changed by the admin account open in Deplao; another account sees FinTrack's own message instead.

## [0.1.0] - 2026-11-12

First release. Ships FinTrack 0.1.0. Requires Deplao 26.11.0 or later (custom domains: 26.10.4).

### Added

- **Full FinTrack inside Deplao**: the *FinTrack* page opens the FinTrack UI directly (transactions, budgets,
  investments, savings, reports, AI assistant); the same data in a browser or on a phone.
- **Overview with two tabs**: *Chi tiêu* (spending: this month's balance, i.e. income minus spending of the month alone,
  the current balance in small print, budgets) and *Tài sản* (assets); the app reopens on the tab chosen last.
- **Month cycle**: a month can start on any day from 1 to 28 (e.g. payday on the 10th: 10/11 to 9/12); the overview,
  budgets, categories and reports follow it (FinTrack → Settings → Personal).
- **Transactions as a monthly calendar**: daily income and spending (Saturday blue, Sunday red), tap a day to see only
  that day; the month's income / spending / total below the calendar; day headings with the weekday, e.g.
  "7/12/2026 (Thứ 2)".
- **Category icons**: pick one when adding or editing a category, or let it be guessed from the name; shown everywhere a
  category appears (transactions, entry forms, budgets, reports, recurring rules, drafts).
- **Demo data that looks alive**: "Nạp dữ liệu mẫu" loads three months of made-up entries up to today, with a credit
  card, budgets, recurring rules, savings and investments (stocks, crypto, gold).
- **USD exchange rate updated automatically** every few hours (Frankfurter, with ExchangeRate-API / fawazahmed0 as
  fallbacks); Settings → Exchange rate shows the source, the update time and an *Update* button.
- **Market prices without API keys**: stocks (VNDIRECT) and crypto (Binance, CoinGecko) come from public feeds; Settings
  → Price sources only keeps the gold price key, issued and renewed automatically.
- **Balance adjustment** when reconciling with real figures (Transactions → *Điều chỉnh* tab, or from Accounts /
  Reconcile): records the difference, never counted as income or spending. **Reset all data** of one account (Settings →
  Data) to drop the demo data and start from zero.
- **Drafts instead of questions**: receipt or transfer photos without text still become drafts; whatever the assistant
  is unsure about (income or expense, category, wallet, date) gets a picker right on the draft, next to Confirm, both in
  FinTrack's assistant chat and in Overview → "Chờ xác nhận". Items with unsure fields are never recorded automatically.
- **One-click deployment** to the Cloudflare account connected in Deplao: Worker + D1 + Workers AI, wrangler-compatible
  migrations, updates keep the data. FinTrack's Overview says when the FinTrack bundled in the app is newer than the
  deployed one (also for the same version number). The app never sees the Cloudflare token.
- **Custom domain**: attach `fintrack.<your-domain>` to the Worker from the Options page without opening Cloudflare
  (Deplao 26.10.4 or later). Deplao asks for confirmation, Cloudflare creates the DNS record and certificate; the app
  switches once the new name answers and falls back to workers.dev when it does not. Deployment reports a mistyped
  FinTrack address in the settings.
- **Sign-up in the browser (optional)**: an admin turns on *Đăng ký tài khoản* in FinTrack → Settings → Accounts so
  people can create their own accounts (each with its own ledger) on the sign-in page; limits on the number of
  accounts, sign-ups per network per hour and AI calls per day for regular accounts. Off by default.
- **Accounts inside Deplao**: sign in, create accounts (one ledger each), quick switch between remembered accounts
  (Deplao keeps the session, never the password), sign out. A FinTrack without accounts opens the create-account screen
  (the first account is the admin).
- **AI assistant per account**: FinTrack's own (OpenAI / Gemini / DeepSeek, reads receipt photos; Gemini defaults to
  `gemini-3.8-flash`, transcription with Gemini 3.5 Transcribe or Cloudflare Whisper) or one of Deplao's assistants (no
  extra key; text and voice). Every assistant shows its **token usage** for today and this month, including Deplao's
  assistants used from Zalo groups.
- **Expenses from Zalo (optional)**: the node `fintrack.record` in your own workflow (no group setup): text, voice
  notes and receipt photos from every member become drafts awaiting confirmation (default) or clear items are recorded
  automatically, with a short reply in the group (📝 / ✅ / ❓), into the FinTrack account open in Deplao. Each message
  is handled once; the app's own replies are ignored. The node `fintrack.transcribe` turns voice notes into text
  (Workers AI Whisper).
- **Confirm in the group**: the sender (or the ledger owner) replies "ok" to the assistant's message to record, "huỷ" to
  drop the draft or reverse an auto-recorded item; missing categories or wallets are spelled out.
- **Pending drafts in FinTrack**: drafts from group messages live in D1 with the ledger; the Overview shows how many are
  waiting and "Chờ xác nhận" lets you complete, edit, confirm or skip them, on any address of FinTrack.
- **Vietnamese money slang**: 50k / 50 ka / 50 cành, 5 chục, 2 trăm, trăm mốt, chục rưỡi, 3 lít / lốp / sọi,
  1 củ / chai / quả, nửa củ, 1tr2, triệu tư, 2 triệu rưỡi, 1 tỏi, numbers spelled out ("3 lít xăng", "2 chai nước" stay
  quantities). FinTrack gives the assistant the conversion and never records an expense under 1,000 đồng because a
  "nghìn" was missing. Automatic recording only happens when the amount is in the message (no invented numbers).
- A compact Options page: FinTrack on Cloudflare (deploy, update, custom domain) and accounts. Minimal permissions: no
  contacts, no group creation, no workflow creation or editing.
- Tooling: `npm test`, `npm run validate`, `npm run pack` (reproducible package within Deplao's limits),
  `npm run vendor`, `npm run e2e`, `npm run preview`, `npm run shots`; CI on Linux and Windows.

[0.1.1]: https://github.com/babyvibe/fintrack-deplao-app/releases/tag/v0.1.1
[0.1.0]: https://github.com/babyvibe/fintrack-deplao-app/releases/tag/v0.1.0
