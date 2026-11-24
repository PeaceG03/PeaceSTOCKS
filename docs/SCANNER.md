# PeaceSTOCKS Scanner

## Purpose

Scanner V0 is PeaceSTOCKS' first production-grade market capability.

It watches the approved U.S. stock/ETF universe, ingests canonical market evidence, reconstructs deterministic features, ranks eligible securities, freezes candidate sets, and records exactly what happened.

It is not a trading engine.

## Current implementation state

Current source location:

`src/` (flat tree; migrated from PeaceAI `packages/markets-scanner/`)

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

## Stock lists hold stocks only

The pick lists are stock lists: only security-master records with `assetType` STOCK are ranked
(`STOCK_LIST_ASSET_TYPE` in src/ranking.ts). ETFs, and any other or missing type, are left out
before split adjustment, the floor and features. They stay in the security master and the stored
bars, so SPY (`resolveSpyBenchmarkId`, assetType ETF) is still the market benchmark for relative
strength and the held-out eval. Funds other than ETFs never reach the master: ingestion keeps only
the provider's common-stock (CS) and ETF types. The scan reports `NON_STOCK_EXCLUDED:<n>` in its
skips, and production lists' configFingerprint names the rule (`listAssetType: STOCK`).

## Eligibility floor

Every stock list is drawn only from names that pass a fixed floor (`config/eligibility-floor-v1.json`,
`src/eligibility-floor.ts`). It was set before looking at the held-out window and is not tuned on it:

| Rule | Value |
| --- | --- |
| Price | split-adjusted last close on or before the scanned session >= $5 (`minLastCloseUsd`) |
| Liquidity | median dollar volume (close x volume) of the last 20 bars >= $5,000,000 (`minMedianDollarVolumeUsd`, `dollarVolumeSessions`) |
| History | >= 60 sessions with a stored bar in the scan's 100-session bar window (`minHistorySessions`) |

The floor is applied after split adjustment (dollar volume is unchanged by it) and before features
and ranking, so a name below it is in no list. The scan reports the count as
`ELIGIBILITY_FLOOR_EXCLUDED:<n>` in its skips. The floor's version is part of the lists'
configFingerprint, so lists frozen with it have different predictionIds from lists frozen without it.
A change to the floor is a new file and version (`eligibility-floor-v2`), never an edit.

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

- TOP_15_OVERALL: the 15 highest overall scores (weighted family scores above).
- TOP_50_OVERALL: the 50 highest overall scores.
- STRONGEST_MOMENTUM: the 15 highest 60-session returns (20-session return when 60 is missing).
- FASTEST_IMPROVING: the 15 largest rises in 20-session return versus the 20 sessions before
  (needs 41 closes; recipe `fastest-improving-return20-delta-v1`). When no ranked name has that
  much history the list is empty with `unavailableReason: INSUFFICIENT_HISTORY`; it is never
  filled from the overall ranking. Lists frozen before this recipe (through 2026-11-23) were a
  copy of TOP_15_OVERALL.
- DEFENSIVE_LOW_RISK: the 15 highest risk family scores (lowest 20-session volatility).

These are candidate sets, not orders.

### Split adjustment

Stored daily bars are unadjusted. Before features and ranking, `src/split-adjust.ts` rescales each
name's bars before a recorded SPLIT / REVERSE_SPLIT (prices x split_from/split_to, volume divided by
it) using `permanent/corporate-actions.jsonl` (only splits effective on or before the scanned
session). A name is dropped for that session, nothing is guessed:

- SPLIT_UNRECONCILED: the adjusted close-to-close move across the split is outside [1/1.5, 1.5];
  the record has no usable factor; two different factors are recorded for the same date (never
  multiplied); or two split dates fall on the same bar.
- PRICE_GAP_UNEXPLAINED: any remaining session-to-session close move of 3x or more either way.
- SPLIT_LIKE_MOVE_UNRECORDED: a move of 1.8x or more either way into any of the last 20 sessions.
  Split records arrive late (none in 2026-07..11 was recorded on its effective date), so a 2-for-1
  or 1-for-2 whose record has not arrived would otherwise read as a -50% / +100% day.
  The cost: most of what this rule drops are real big movers, not splits. In the held-out replay
  (2026-08-27..11-20, effective-date) it dropped 2,901 name-sessions (47.6 per session, 0.46%), and
  only about 20% of them had any split record within -25..+30 sessions of the scan (564 in the
  Auditor's count, 574 in ours; the windows are counted slightly differently). So about 80% are real
  movers. With the rule off, those names would have taken 65 of the 915 TOP_15_OVERALL slots (about
  7%, on 49 of 61 sessions) and 129 TOP_50 slots. The held-out conclusion (no robust edge) is the same
  with or without the rule.

The thresholds were chosen from the 2026 split records (build log `predictions-on.md`). Reconcile
band count, splits effective 2026-05-01..11-30 with one usable factor and a close both before and
on/after the effective date: 492 of 514 (95.7%) are within [1/1.5, 1.5] and 507 within [1/2, 2].
An earlier count of 488 of 508 (96.1%) loaded bars only from May 1, so it dropped 6 such splits: 5
effective on May 1 itself (no earlier bar loaded) and 1 whose last earlier bar was in April. The run
report lists the count in `skips` as `SPLIT_ADJUST_EXCLUDED:<n>`. If the split records cannot be read,
the scan reports `SPLIT_ACTIONS_READ_FAILED:<message>` and the session is not frozen (UNAVAILABLE /
SOURCE_COLLECTION_FAILED, like a provider failure). This and loading the records are the only
`scanner.ts` changes. The D-010 freeze rules and `host.ts` are unchanged. Lists frozen through
2026-11-23 used unadjusted closes.

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

#### GitHub Actions scan crons (observed Nov 2026)

scanner.yml schedules the scan at 05:30 and 09:30 UTC, Tue–Sat (`30 5 * * 2-6`, `30 9 * * 2-6`).
GitHub has not been firing those two crons: in the week to Nov 24, 2026 no scheduled run started near
either slot. In practice the scan runs through the hourly :47 restarter's `scan_backstop` and the
chain follow-ups (scan dispatched after a history run), so it arrives late but is not skipped.

### Nightly scan health record and missed-freeze alert

Every forward scan of a trading session (not the NOT_DUE or ALREADY_FROZEN no-ops, not evidence-only
backfills) writes `permanent/health/scan/<D>.json` and `permanent/health/scan/latest.json`
(src/scan-health.ts), with the same size + checksum read-back as the health check's reports. The
record says whether the scan finished strictly before the next session's 09:30 New York open, the
freeze decision (FROZEN / UNAVAILABLE + reason / NO_DECISION) and whether picks were frozen before
the open, names expected and covered, and the names the eligibility floor and the split guard left
out, by reason. A failed write never fails the scan (the run report says `scanHealth: FAILED:...`).
The site's Health card shows the newest record under "Nightly scan".

A session misses the freeze when the next session opens without picks frozen before that open
(frozen late, unavailable, or no decision stored at all, e.g. the scan never ran).
src/freeze-watch.ts checks the newest 3 judged sessions from their prediction-status records and
raises the existing alert: the one "PeaceSTOCKS health needs attention" issue (label
`scanner-alert`, src/health-alert.ts), opened or commented on. A marker under
`permanent/health/scan/missed-freeze-alerts/<D>.json`, written only after the alert went out, keeps
it to once per session. It runs as the last step of every scan job and on the hourly :47 tick
(`freeze_watch` job), so a session whose scan never ran is still reported within the hour after the
open. No Massive request and no tickers in the alert.

### Freeze reliability: Oct 13 - Nov 20, 2026 (root cause)

No session from Oct 13 to Nov 20 had picks frozen before the next open. From the scanner.yml run
history (gh run list/view, scan job logs, codes only): 100 scan-job attempts from Oct 13 to Nov 24;
every session had 1 to 4 attempts that started after its close and before the next open, so the
late-firing crons (scheduled runs created hours after 05:30/09:30 UTC) were not the cause. Every
attempt died in the scan host:

- Oct 14 - Oct 30, 38 attempts: `MARKETS_SCHEDULER_HOST_FAILED:fetch failed` after about 50 min.
  The R2 client had no timeout and no retry, and the scan read the whole stored history, so one
  dropped connection ended the run.
- Oct 30 - Nov 21, 47 attempts: `The operation was aborted due to timeout` about 11 min in. The
  Oct 30 change (#108) added a 30 s timeout and retries around fetch, but read the response body
  later, outside the retry loop and under the same 30 s signal; the large month bar files took
  longer than that, every time.
- Nov 14 - Nov 21, 7 attempts: JavaScript heap out of memory (whole-history load).
- Oct 14: one attempt cancelled at the 120 min job limit. Nov 24 02:08 UTC: one attempt failed
  on `DAILY_BARS_PACK_EXISTS_DIFFERENT` while re-collecting sealed sessions.

Fixed on main on Nov 23 (#114 batch): the body is read inside the retry loop with a size-aware
timeout (d0b7e3e, src/object-store-body-retry.test.ts), the scan loads only its bar window
(45ec0e9), a sealed pack is checked before any session write (922e085), the security list is
fetched once per run (efb9fb5), and the backlog per run is capped (5b07f04). Run history since:
the Nov 24 06:19 UTC run caught up the 29 missed sessions as evidence and froze the Nov 23 picks
at 06:42:58 UTC, 7 h 47 min before the 14:30 UTC open; the two later runs that day found the
session complete. The missed sessions stay UNAVAILABLE (evidence only): forward picks cannot be
made honestly after the fact.

The site shows the on-time share over the last 20 and 60 judged sessions (a session is judged
once its next open has passed): src/freeze-watch.ts writes `permanent/health/scan/reliability.json`
on every run from the prediction-status records. Frozen late, unavailable, and no record all count
against the share.

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

## Held-out evaluation of the pick lists

`src/holdout-eval.ts` (with the offline CLI `src/holdout-eval-cli.ts`) scores the lists on stored
daily bars copied to a local directory. It never reads R2 or the network and prints aggregates only.

- The ranker has no fitted parameters: its weights (above) were set by hand on 2026-08-26 and have
  not changed. Sessions after that date are the held-out window. Earlier sessions (2025-03-03 to
  2026-08-26) are in-sample: the weights were chosen after them, so they are not evidence.
- For each session D it rebuilds what a forward scan at D saw: bars up to D in the scan's own
  window, ACTIVE = has a bar on D, eligibility from the bar count up to D (not the all-time count),
  then the production `rankSecurities` with the stored split records. Two variants:
  `--splits effective-date` (default) uses every record from its effective date on, which is
  look-ahead, since records arrive days to months late. `--splits as-known` uses only records
  observed before the next session's open, which is what a forward scan could have read. Both are
  reported. Dropping a name whose split falls inside the outcome window uses all records in both.
- It is a replay of the current code on today's stored (gap-refilled) data, not a reproduction of
  the lists that were actually published: some bars were ingested after a past freeze, and past
  lists used unadjusted closes and the old FASTEST_IMPROVING.
- Outcome: enter at the next session's open (lists freeze before it), exit at the close h sessions
  after D. A name-window with a known split or reverse split after entry is dropped. Optional
  winsorizing clips picks and baselines alike to the session's universe quantiles.
- Baselines on the same sessions and names: the equal-weight universe average (every ranked name
  with an outcome), random same-size lists from that universe (one-sided p = share of random
  averages at or above the list's), and SPY. Also the mean daily Spearman IC of the overall score.
- Reading the numbers: the random-list p treats picks as independent draws, so it overstates
  significance when a list's names move together (a style or beta tilt). The per-session excess
  t-stat and the alpha after regressing on the universe mean are the stricter checks. Five lists
  and several variants are tested at once, so expect some nominal p < 0.05 by chance (Bonferroni
  for 5 lists: 0.01). A list whose mean return is near zero "beats" a falling universe through low
  beta, not selection (DEFENSIVE_LOW_RISK in 2026-08-27..11-20).
- Results after the split fixes (held-out 2026-08-27..11-20, aggregates in the build log): no list
  has a robust edge in either split variant. TOP_15 / TOP_50 beat the universe next day (excess
  +0.60% / +0.34% effective-date, +0.72% / +0.43% as-known, per-session t 1.2-1.6), but alpha after
  the universe beta is about zero (t <= 0.53) and both are below the universe at h=5 (t -1.2 to
  -2.0; -2.7 to -3.8 winsorized). STRONGEST_MOMENTUM is about zero; FASTEST_IMPROVING is negative;
  DEFENSIVE_LOW_RISK is low beta in a falling universe.
- Site label from these results (`PICKS_EXPERIMENTAL_LABEL`, docs/SITE.md): "Experimental:
  back-tests on held-out data show no reliable edge over random picks. Not investment advice."
