# Contributing

Thanks for your interest! The app is small and has **no third-party dependencies**. Keeping it that way helps people
trust an app that may read their messages and deploy to their Cloudflare account.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting started

```bash
git clone https://github.com/babyvibe/fintrack-deplao-app
cd fintrack-deplao-app
npm run check          # Node ≥ 20: unit tests + manifest checks, no npm install needed
```

Run it inside Deplao: **Tools → Apps, API & Webhook → Develop apps → Add a folder in development** ("Công cụ → Ứng dụng,
API & Webhook → Phát triển ứng dụng"), pick the repository folder. Deplao reloads the backend when `backend/` changes;
reload the page after editing `ui/`. Deploying FinTrack while developing needs the FinTrack bundle in `vendor/fintrack/`
(see [vendor/fintrack/README.md](vendor/fintrack/README.md)).

With the FinTrack sources (`../fintrack` or `FINTRACK_DIR`, after `npm install` there):

```bash
npm run e2e            # end-to-end test with the real FinTrack (API + D1 in Miniflare), fake Deplao / AI / Cloudflare
npm run preview        # the UI at http://127.0.0.1:4319 (-- --fresh | --demo | --undeployed)
npm run shots          # regenerate docs/images/*.jpg (Node ≥ 22 + Chrome / Edge; -- --only <name,…>)
```

Changed something users can see? Run `npm run shots` so the README images match. `zalo-group.jpg` and
`deplao-workflow.jpg` are taken inside Deplao; retake them only when Deplao's chat or workflow UI changes a lot.

New to Deplao apps? [docs/BUILDING_APPS.md](docs/BUILDING_APPS.md) explains the building blocks this repository uses.

## Conventions

- **Backend**: CommonJS, Node built-in modules only, small modules in `backend/lib/`. Every Deplao call goes through the
  `ctx.deplao` passed in (easy to replace with a fake in tests). Workflow nodes never throw because of their input: they
  return `skipped` with a reason. UI commands return `{ ok, … }` or `{ ok: false, error: { code, message } }`. Constants
  and storage keys live in `lib/constants.js`; read-modify-write storage updates go through the lock in `lib/state.js`.
- **UI**: plain HTML/CSS/JS, no inline scripts (CSP), no external resources (external images only from origins declared
  in `ui.imgSrc`), text rendered with `textContent` (the `FT.h` helper). Colors follow Deplao's `--dp-*` variables.
- **User-facing text**: Vietnamese with diacritics, short and plain; errors say what to do next. Deplao calls apps
  "Ứng dụng". Avoid the em dash in user-facing text.
- **Code comments and developer docs**: English.
- **Security**: never log secrets, tokens, passwords, message content, audio or images; never send the integration
  secret on regular routes; always check type and length of data coming from messages, FinTrack or the UI. See
  [SECURITY.md](SECURITY.md).
- **Tests**: every behaviour change comes with `node:test` tests in `test/` (fakes in `test/helpers/fakes.js`); protocol
  changes with FinTrack also need `npm run e2e` when you have the FinTrack sources.
- **Commits**: short and specific (e.g. `node: accept photos in groups`); one purpose per pull request.

## The three-party contract

[`docs/CONTRACTS.md`](docs/CONTRACTS.md) is the single source of truth shared by Deplao (`deplao.cloudflare`, the app
API), FinTrack (integration API, `X-FinTrack-*` headers, the Deplao bundle) and this app. Changing an API, a permission
or the bundle format means updating the contract **and** the repositories involved together; changing permissions in
the manifest also means updating the permission table in the README.

## Releasing

1. Write `CHANGELOG.md` (turn *Unreleased* into `## [x.y.z] - YYYY-MM-DD`).
2. Bump `version` in `deplao-plugin.json`, `package.json` and `backend/lib/constants.js` (`npm run validate` checks they
   match; `npm test` also checks the CHANGELOG entry and the minimum Deplao version written in the README). Set
   `minDeplaoVersion` to the lowest **released** Deplao that has every feature the app uses.
3. `npm run vendor` with the matching FinTrack build. Users are told to update FinTrack whenever the bundled build
   differs from the deployed one (sha256 of the bundle), so a FinTrack version bump is not required for that; still
   bump FinTrack's version for real FinTrack releases. Then `npm run check`, `npm run e2e` (with the FinTrack sources)
   and `DEPLAO_REPO=<Deplao repository> npm run pack` (adds Deplao's official manifest checks when available).
4. Tag `vx.y.z` and create a GitHub Release with `dist/fintrack-x.y.z.zip` and the sha256 printed by `pack`.

## Pull requests

- Briefly explain why and how to test (the PR template has the checklist).
- `npm run check` must pass. CI runs the tests, the manifest checks and a test pack on Node 20 / 22 / 24 (Linux) and
  Node 22 (Windows).
- Changes to permissions, the contract or user-visible behaviour update the README / CONTRACTS / CHANGELOG in the same
  pull request.
