# vendor/fintrack: prebuilt FinTrack bundle

This folder holds the FinTrack build (Worker + web UI + D1 migrations + the Deplao build of the UI in `app/`) that the
app deploys to the user's Cloudflare account. **Do not edit it by hand and do not commit the build output**: only this
`README.md` is tracked in git.

## How to fill it

```bash
# FinTrack repo next to this repo: ../fintrack
cd ../fintrack && npm run bundle:deplao      # creates artifacts/deplao-bundle/
cd ../fintrack-deplao-app && npm run vendor
```

Other sources: `npm run vendor -- --from <folder>` or the `FINTRACK_BUNDLE_DIR` environment variable (checked in that
order, before `../fintrack/artifacts/deplao-bundle`). For example, to take the bundle from a release: extract
`fintrack-<version>.zip`, then run `npm run vendor -- --from <extracted folder>/vendor/fintrack`.

The script checks the bundle against `docs/CONTRACTS.md` §1.2 (bundle.json, declared files exist, ≤ 50 MB, ≤ 5000
assets, each asset ≤ 25 MiB, safe paths), copies it into a temporary folder before replacing this one (a failure halfway
leaves the current copy intact), and writes the version, file count and sha256 to `vendor/fintrack.vendor.json`. A source
that is inside this folder, or contains it, is rejected. This README is kept as is (a `README.md` in the source is
skipped).

The first 16 hex characters of that sha256 are the bundle `build` id. The app stores it with every deploy and offers
"Cập nhật FinTrack" (Update FinTrack) when a Worker it deployed runs a different build, even if the FinTrack version
is the same (`docs/CONTRACTS.md` §2.2, §3.2).

## Expected layout

```
vendor/fintrack/
  bundle.json               # mainModule, modules, compatibilityDate, assets, migrations, app, fintrackVersion
  worker/worker.js          # from `wrangler deploy --dry-run --outdir`
  assets/**                 # web UI (apps/web/dist)
  migrations/*.sql          # apps/api/migrations, same file names as wrangler so nothing is applied twice
  app/index.html            # FinTrack UI, Deplao build (vite build --mode deplao, base ./), opened by the plugin in an iframe
  LICENSE                   # FinTrack's MIT license (required for releases)
  THIRD_PARTY_NOTICES.md    # credits for FinTrack's data sources / libraries
  THIRD_PARTY_LICENSES.md   # licenses of the libraries bundled into the Worker and the UI
```

`npm run pack` refuses to build a release package without `app/index.html` or `LICENSE` (unless `--no-bundle` is
given).
