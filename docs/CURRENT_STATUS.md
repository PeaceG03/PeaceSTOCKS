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
- scanner beliefs;
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
