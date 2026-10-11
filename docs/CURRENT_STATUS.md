# PeaceSTOCKS Current Status

This document distinguishes implemented/verified capability from planned capability.

## Current priority

**Get Scanner V0 reliably running online on real U.S. stock/ETF data through the intended hosted production path.**

The production scanner is intended to run on an online backend/worker and must not depend on the user's desktop PC being powered on. Local execution is for development, verification, archive, and fallback.

Do not let storage-format research, live trading, or future product expansion block this milestone.

## Implemented foundation

Current scanner source exists under:

`src/`

Implemented areas include:

- stable security identity;
- U.S. stock/ETF universe refresh;
- inactive lifecycle preservation;
- Massive provider adapter;
- file fixture provider;
- daily unadjusted OHLCV evidence;
- corporate actions;
- corrections/revisions;
- eligibility ladder;
- deterministic feature recipes;
- deterministic rankings;
- scanner beliefs (retired 2026-10: no longer written, and the rank read routes `/scanner/top15`, `/scanner/top50`, `/scanner/ticker/:t` are removed; the scanner never ranks; existing beliefs objects are kept);
- prediction sets;
- prediction availability status;
- partition manifests/checksums;
- resumable historical evidence backfill;
- scheduler due calculation;
- scheduler host state;
- missed-session recovery logic;
- storage accounting;
- NYSE-aware calendar;
- 10-minute intraday schema/normalization;
- daily liquid 10-minute step (`src/tenmin-daily-liquid.ts`, scanner.yml `tenmin_daily`, crons 06:20/10:20Z Tue–Sat): after each close, the just-closed session's 10-minute bars for the top `TENMIN_DAILY_LIQUID_N` names (default 500, cap 1000) by trailing 20-session dollar volume from sessions strictly before that session, one request per name (~104 key-minutes/day at N=500). Same Reply Dust range format/paths as the history chain plus `rd-origin=daily-close`; per-session index `permanent/tenmin-reply-dust/<range>/daily/<D>.json` (frozen selection + stored list). Off unless `TENMIN_DAILY_ENABLED` is exactly `true`; skips with `SKIP_REDISPATCH_PAUSED` (0 requests) unless `TENMIN_AUTO_REDISPATCH` is exactly `true` (held while another job owns the key); never in guard windows; yields to a waiting scheduled scan; `TENMIN_DAILY_MAX_REQUESTS` (default 720) per run; catches up the last 10 sessions oldest first; never refetches or overwrites. When the history chain seals the range it fetches each ticker's full span (one request) and its manifest supersedes the daily objects (kept, not deleted); `readTenMinSecurityDay` reads the sealed manifest when present, else the daily index; the entries-rebuild fallback never keeps a daily file (superseded by a covering chain fetch, otherwise it fails closed with `TENMIN_DAILY_IN_RANGE_UNRESOLVED`);
- active-run check (`createScanYieldCheck`, `src/scan-yield.ts`; history, backfill, daily step): guard windows are checked on every call without the API; the GitHub runs-API call is made at most once per 60 s while nothing is waiting (a waiting run is never cached). Run 38117572660 (Oct 11 2026) called it before each of ~4,963 re-verified stored fetches (no Massive request), used up the GITHUB_TOKEN REST rate limit and got `SCAN_CHECK_FAILED:http-403` with 0 Massive requests in 58 min. A failed call is retried (30/60/120 s, or GitHub's retry-after / rate-limit reset if longer, up to 5 min); if it still fails it fails closed: no Massive request, the history step exits 2 with an `::error` annotation, the outcome is `STOP_SCAN_CHECK_FAILED:<reason>`, the chain stops and the stop alert fires, also when `TENMIN_AUTO_REDISPATCH` is paused. The hourly restarter/fallback restarts it once by itself (`CONTINUE_SCAN_CHECK_RETRY`) at least 1 h after the stop, or after GitHub's reported reset if later (`WAIT_SCAN_CHECK_RESET` until then), under the same kill switch, guard-window, queue and chain-cap rules. The consecutive count is kept in the run record (`scanCheckStops`) and passed to the restarted run as scanner.yml input `tenmin_scan_check_stops`; a run that gets past the check resets it to 0. A second consecutive failure stops for good (`STOP_SCAN_CHECK_NEEDS_PERSON`); the alert says a person is needed;
- Dust reader/codec/validation foundation;
- storage benchmark fixtures/tests.

## Real-data evidence already achieved

Historical work proved that the system could collect real Massive full-market daily evidence.

At one validated checkpoint:

- 21 canonical daily sessions;
- 208,529 canonical daily bars;
- 2,512 corporate actions;
- ~9,665 securities at LEVEL_2 scanner eligibility;
- real provider authentication successful.

This established that the basic data/universe path is viable.

## Scanner reliability still not certified

Later audit found that forward scheduled operation was not yet trustworthy enough to call production reliable.

Known problems included:

- provider EOD publication timing;
- scheduler/provider 403/429 failures;
- Windows scheduled-task failures;
- no genuine long-run forward ranking history;
- missed or unavailable prediction sessions;
- need for stronger run/retry evidence.

Therefore:

`SCANNER_V0_LONG_RUN_RELIABLE` is not yet a valid completion claim.

## Canonical decision discipline

`CANONICAL_DECISIONS.md` now distinguishes:

- **LOCKED** — settled requirements;
- **PRODUCTIONIZE** — strongest prior tested choice that must be integrated/certified first;
- **OPEN** — genuinely unresolved choices.

The current compact local archive productionization target is:

`PACKED_BLOCKS_FOR_DELTA_STATES_ZSTD7`

Legacy Deflate-based Dust V1 must not become production default merely because it is already implemented.

## Storage work

Foundation D and Foundation D.1 are substantially designed.

Measured storage work includes:

- JSONL;
- compressed JSON;
- Parquet;
- Parquet + Zstd;
- Dust V1;
- packed custom candidates;
- state/presence/compressor variants;
- deterministic full-universe synthetic fixture.

Current provisional packed leader:

`PACKED_BLOCKS_FOR_DELTA_STATES_ZSTD7`

Measured on frozen synthetic full-universe fixture:

- 22,643,796 bytes;
- 13.51 bytes/bar;
- exact logical fidelity;
- integrity/corruption checks passed.

The custom codec tournament is not required to finish Scanner V0.

## Dedicated-repo migration

The dedicated private repository now exists:

`PeaceG03/PeaceSTOCKS`

The scanner source/tests were migrated and the standalone migration recorded 41/41 tests passing plus clean typecheck at migration time.

Canonical target organization still places the scanner under:

`Scanner/`

Repository reorganization must preserve behavior; do not redesign working scanner logic merely to move files.

The tightened canonical docs from this staging branch must be mirrored into the dedicated PeaceSTOCKS repository and become the source of truth there.

## Immediate completion sequence

1. mirror/finalize canonical PeaceSTOCKS docs in the dedicated repository;
2. canonicalize scanner repository layout without behavior churn;
3. validate build/tests after organization;
4. fix only production-path scanner blockers;
5. deploy/verify the scanner through the intended online backend/worker;
6. run a real Massive EOD full-universe scan online;
7. make results symbol-readable/retrievable through a stable read/API surface;
8. rerun the same session to prove idempotency;
9. prove online catch-up/retry/restart behavior;
10. run enough consecutive real online sessions to call the production scheduler path reliable;
11. then move to Strategy Lab work.

## Not implemented / future

Still future product work includes:

- full Strategy Lab;
- strategy genealogy;
- regime champions;
- real paper-portfolio orchestration;
- broker integration;
- deterministic live risk governor;
- live execution;
- reconciliation;
- generated-capital accounting automation;
- mature cloud-to-local archive sync/retention (the scanner production runtime itself is online-first);
- consumer PeaceSTOCKS UI.

## No-false-pass requirement

PeaceSTOCKS is not complete because:

- code exists;
- tests pass;
- storage is compact;
- one API endpoint works;
- one ticker ranks;
- a scheduler entry exists.

Current next major PASS is specifically:

**REAL_SCANNER_PRODUCTION_PATH_VERIFIED**
