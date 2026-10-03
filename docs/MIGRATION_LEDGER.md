# PeaceSTOCKS migration ledger

Migration date: 2026-10-03. Source of truth at copy time: PeaceG03/PeaceAI working tree `packages/markets-scanner` (original files left in place).

This ledger records the split only. It does not claim the scanner is production-ready.

## Copied

| Source | Destination | Status |
| --- | --- | --- |
| `PeaceAI/packages/markets-scanner/src/**` (30 files) | `PeaceSTOCKS/src/**` (those 30, plus `store-path.ts`) | copied; six files rewired from `@peaceai/contracts` to `./store-path` |
| `PeaceAI/packages/contracts/src/storagePathSafety.ts` | `PeaceSTOCKS/src/store-path.ts` | copied as the only runtime dependency the scanner imported |
| `PeaceAI/packages/markets-scanner/README.md` | `PeaceSTOCKS/README.md` | copied, with a standalone header added |
| `PeaceAI/packages/markets-scanner/package.json` | `PeaceSTOCKS/package.json` | adapted: name `@peacestocks/markets-scanner`, no workspace dependency |
| `PeaceAI/packages/markets-scanner/tsconfig.json` + `PeaceAI/tsconfig.base.json` | `PeaceSTOCKS/tsconfig.json` | inlined; same compiler flags |
| `PeaceAI/docs/markets/PEACESTOCKS_4DAY_STORAGE_BASELINE.json` | `PeaceSTOCKS/docs/markets/` | copied |
| `PeaceAI/docs/peaceai-learning/markets-dust-development.md` | `PeaceSTOCKS/docs/history/` | copied as historical note (mostly PeaceAI CLI routing, plus one Massive `NOT_AUTHORIZED` limitation) |
| `PeaceAI/scripts/markets-scanner-scheduler.cmd` | `PeaceSTOCKS/scripts/` | adapted: no absolute Node/pnpm paths, no `--filter @peaceai/markets-scanner` |
| env names used by host/backfill/provider | `PeaceSTOCKS/.env.example` | names only |

## Intentionally excluded

- PeaceAI product docs that only mention markets in passing: `docs/PEACEAI_OVERNIGHT_PROGRESS.md`, `docs/PEACEAI_FINAL_PRODUCT_READINESS.md`, JSON readiness manifests.
- `tools/peaceai-cli/peaceai.test.mjs` (one read-only CLI prompt mentioning markets-scanner; PeaceAI infrastructure).
- PeaceAI monorepo lockfile, workspace file, and unrelated packages.
- `packages/markets-scanner/node_modules` (reinstalled here).
- Nothing deleted from PeaceAI.

## Unresolved external dependencies

- `MASSIVE_API_KEY` and a licensed Massive/Polygon plan. Not stored in git. Historical note: older dates returned `NOT_AUTHORIZED` on the plan then in use.
- Operator storage root via `PEACEAI_MARKETS_ROOT` or `MARKETS_STORAGE_ROOT` (defaults in host/backfill still point at a Windows ProgramData path).
- OS scheduler is not installed by this repo. `scripts/markets-scanner-scheduler.cmd` only launches `pnpm scheduler`.
- No brokerage connector existed in the source package; none was added.

## Secrets explicitly excluded

- No `.env` or credential file was present under `packages/markets-scanner`.
- `.env`, `.env.*` (except `.env.example`), `*.pem`, and `*.key` are gitignored.
- API key is read from `MASSIVE_API_KEY` at runtime and is not committed.

## Verification at migration

- Import diffs vs PeaceAI `src` are the six `@peaceai/contracts` lines only.
- `pnpm install`, `pnpm typecheck`, `pnpm test`: typecheck clean, tests 41/41 pass.
- There is no separate production build script in the source package (`tsc --noEmit` only). None was added.
