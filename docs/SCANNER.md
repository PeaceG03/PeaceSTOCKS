# PeaceSTOCKS Scanner

## Purpose

Scanner V0 is PeaceSTOCKS' first production-grade market capability.

It watches the approved U.S. stock/ETF universe, ingests canonical market evidence, reconstructs deterministic features, ranks eligible securities, freezes candidate sets, and records exactly what happened.

It is not a trading engine.

## Current implementation state

Current source location:

`packages/markets-scanner/`

The package already contains:

- provider-neutral market contracts;
- Massive provider adapter;
- file fixture provider;
- security identity;
- universe refresh;
- lifecycle preservation;
- daily canonical bars;
- corporate-action ingestion;
- corrections;
- feature recipes;
- ranking;
- prediction sets;
- storage;
- partition validation;
- scheduler logic;
- scheduler host;
- historical backfill;
- 10-minute intraday acquisition support;
- Dust storage/reader work;
- tests.

## Scanner universe

Initial production scope:

- U.S. common stocks;
- U.S. ETFs.

Provider-normalized records are rejected when outside that scope.

Ticker symbols are not identities.

Inactive securities remain historically preserved.

## Dynamic universe refresh

Scanner V0 must refresh the supported U.S. stock/ETF universe from the provider rather than rely on a frozen symbol list.

Required behavior:

- automatically discover newly listed supported U.S. stocks/ETFs;
- assign/preserve stable internal identity;
- add them to point-in-time universe evidence;
- begin them at the appropriate history eligibility level;
- never fabricate missing prior history;
- preserve inactive/delisted securities historically.

## History eligibility

Current levels:

- LEVEL_0: no stored bars;
- LEVEL_1: fewer than 20 bars;
- LEVEL_2: at least 20 and fewer than 252 bars;
- LEVEL_3: 252+ bars.

Current scanner ranking accepts LEVEL_2 and LEVEL_3 active securities.

## Current daily feature set

Versioned recipes reconstruct:

- 5-day return;
- 20-day return;
- 60-day momentum;
- 20-day annualized volatility;
- 60-day drawdown;
- 20-day average dollar volume;
- market-relative 20-day strength.

The features are rebuilt from evidence rather than stored permanently.

## Ranking families

Current deterministic family scores:

- momentum;
- trend;
- relative strength;
- risk;
- liquidity.

Current default weights:

- momentum: 0.25
- trend: 0.20
- relative strength: 0.20
- risk: 0.20
- liquidity: 0.15

Current selection threshold is versioned.

## Current output sets

Scanner currently defines:

- TOP_15_OVERALL
- TOP_50_OVERALL
- STRONGEST_MOMENTUM
- FASTEST_IMPROVING
- DEFENSIVE_LOW_RISK

These are candidate sets, not orders.

## Provider baseline

Massive is the current production provider adapter.

The adapter currently supports:

- reference tickers;
- grouped unadjusted daily bars;
- splits;
- dividends;
- per-security 10-minute aggregates.

Secrets are supplied externally and must not enter evidence or Git.

## Historical operational work already completed

Earlier Scanner V0 work reached a healthy collection checkpoint using real Massive data.

At a validated checkpoint:

- 21 canonical daily sessions had been collected;
- 208,529 canonical daily bars existed;
- 2,512 corporate actions existed;
- eligibility was approximately:
  - LEVEL_0: 7,948
  - LEVEL_1: 475
  - LEVEL_2: 9,665
  - LEVEL_3: 0
- permanent storage was approximately 179.9 MiB;
- then-current projection was approximately 9.10 GB/year using the verbose daily evidence representation.

This proved that the provider/universe/evidence foundation could operate at full-market scale.

It did not prove long-run forward scanner reliability.

## Reliability problems discovered

### Provider publication timing

Massive Basic can reject same-day grouped EOD data even after the market has closed.

Observed failure:

`HTTP 403 NOT_AUTHORIZED / Attempted to request today's data before end of day`

The architecture therefore needs separate states for:

- MARKET_SESSION_COMPLETE;
- PROVIDER_EOD_AVAILABLE;
- SCANNER_FINALIZED.

Market close alone must not mean provider data is ready.

### Scheduler reliability

A Windows scheduled-task path previously produced failures such as:

- task result 2;
- `0x800710E0`;
- provider 403/429 cases.

This led to requirements for:

- durable host state;
- missed-session catch-up;
- retry/backoff;
- end-to-end validation;
- explicit failure states;
- consecutive successful-session certification.

### Forward prediction integrity

Historical evidence can be backfilled.

Forward predictions cannot be recreated honestly later.

The scanner therefore records prediction availability separately.

Examples:

- `FROZEN / PREDICTIONS_FROZEN`
- `FROZEN / NO_QUALIFYING_CANDIDATES`
- `UNAVAILABLE / SOURCE_COLLECTION_FAILED`
- `UNAVAILABLE / EVIDENCE_ONLY`

A failed provider run must never look like a valid empty prediction set.

## Test coverage already present

The current scanner test suite covers behavior including:

- stable identity across ticker changes;
- rejection of out-of-scope assets;
- preservation of inactive history;
- idempotent universe refresh;
- eligibility ladder;
- precision/provenance/correction lineage;
- market calendar behavior;
- feature reconstruction;
- deterministic ranking;
- no future outcomes stored in beliefs;
- partition manifests;
- failed/partial run status;
- retry/restart deduplication;
- corporate-action ledger behavior;
- explicit storage classes;
- deterministic fingerprints;
- partition corruption detection;
- file provider behavior;
- failed source prediction unavailability;
- Massive provider normalization;
- grouped daily bars;
- split/dividend normalization;
- NYSE holidays/half days;
- scheduler close/publication delay logic;
- scanner host missed-session handling;
- 10-minute intraday normalization;
- Dust round-trip/integrity;
- storage path hardening.

Tests remain necessary but are not sufficient for production PASS.

## Storage-format scanner benchmark

A four-session representative intraday fixture was measured using:

- SPY
- AAPL
- QQQ
- dates 2026-08-31 through 2026-09-03
- 39 regular-session intervals/day
- 117 bars/day
- 468 total bars

Measured formats:

### JSONL

- 356,627 total bytes
- 762.02 bytes/bar
- mean random read ~0.107 ms
- mean stream ~320k bars/sec
- 4/4 round-trip days

### Parquet + Zstd

- 146,457 total bytes
- 312.94 bytes/bar
- mean random read ~3.14 ms
- mean stream ~8.3k bars/sec
- 4/4 round-trip days

Settings:

- parquet-wasm 0.7.2
- apache-arrow 18.1.0
- ZSTD
- dictionary encoding
- one file/security/day

### Dust V1

- 26,441 total bytes
- 56.50 bytes/bar
- mean random read ~0.341 ms
- mean stream ~96k bars/sec
- 4/4 round-trip days
- checksummed blocks

This small fixture was useful for relative format behavior but was explicitly not accepted as a full-universe projection.

## Larger synthetic benchmark

A deterministic synthetic full-universe fixture was later created because Massive Basic full-universe intraday retrieval was impractical for benchmark development.

Fixture:

- generator: `peacestocks-synthetic-foundation-d1-v1`
- seed: `PEACESTOCKS_SYNTHETIC_FIXTURE_V1_SEED`
- 4 sessions
- 10,746 securities
  - 5,317 stocks
  - 5,429 ETFs
- 419,094 bars/day
- 1,676,376 bars total
- logical SHA-256:
  `7d70c208667c51c5f7156d90cbefb4c9a557703d599e26773706d1a228661ecd`

State totals:

- VALID_TRADED: 1,661,354
- PARTIAL: 7,613
- HALTED: 3,213
- NO_TRADE: 1,974
- MISSING: 1,588
- SOURCE_FAILURE: 634

This fixture is for codec/scanner infrastructure testing only.

It must never be used to claim market performance.

## Exhaustive storage tournament status

The broader storage tournament measured many candidate records.

Important measured reference points:

### Parquet-Zstd full synthetic fixture

- 61,317,614 bytes
- 36.58 bytes/bar
- 1,676,376 rows reconstructed
- fidelity passed
- ~1.38M decoded bars/sec

### Packed provisional finalist

`PACKED_BLOCKS_FOR_DELTA_STATES_ZSTD7`

- 22,643,796 bytes
- 13.51 bytes/bar
- encode ~178 ms
- decode ~1.14M bars/sec
- exact logical hash passed
- full checksum passed
- corrupted payload rejected
- corrupted block rejected
- truncation detected
- atomic seal passed

This is the **canonical local-archive productionization target**. It is not yet production-certified, but the team must productionize/certify it before considering an older codec. The existing Deflate-based Dust V1 code is historical/reference implementation, not the preferred final archive.

## Scanner production definition

Scanner V0 is not “running” merely because tests pass.

A production PASS requires direct evidence that:

1. Massive/approved real provider is reached;
2. real supported U.S. stock/ETF symbols are obtained;
3. current-enough data for the EOD version is ingested;
4. the intended universe is evaluated;
5. feature reconstruction runs on real evidence;
6. filtering/ranking executes;
7. incomplete/provider failures remain visible;
8. a scan reaches a terminal state;
9. frozen results are persisted;
10. results are retrievable as symbols/ranks, not only raw IDs;
11. rerunning/restarting does not duplicate/corrupt state;
12. no fixture or hard-coded result is being treated as production proof.

## Canonical choices the scanner team must not reopen

Before Scanner work, read `CANONICAL_DECISIONS.md`.

For Scanner V0, preserve:

- U.S. stocks + ETFs scope;
- Massive as the initial real-data provider path;
- stable security identity and point-in-time universe;
- current deterministic ranking families and baseline weights;
- existing candidate-set definitions;
- online-first production runtime;
- provider-readiness retry semantics;
- scheduler cursor safety;
- no retroactive fabricated predictions;
- cloud pending-buffer → verified local ACK semantics;
- `PACKED_BLOCKS_FOR_DELTA_STATES_ZSTD7` as the local Dust archive productionization target.

A different choice requires evidence plus the Architect/Builder/Auditor replan path. “It is easier” or “legacy code already exists” is not sufficient.

## Immediate scanner priority

Finish the real daily production path before expanding future features.

The Grok team should focus on:

- provider rate-limit correctness;
- EOD publication readiness;
- scheduler retry/cursor correctness;
- SPY/market benchmark correctness;
- symbol-readable result retrieval;
- real full-universe forward scan;
- idempotent rerun;
- multi-session reliability.

Only then should Scanner V0 be declared operational.
