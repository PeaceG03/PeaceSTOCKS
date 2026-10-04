# PeaceSTOCKS Canonical Build Order

This document defines the canonical order in which PeaceSTOCKS should be built.

The purpose is to prevent feature drift, duplicated architecture, premature trading work, and repeated redesign.

A later phase may add capabilities, but it should not bypass an unfinished prerequisite phase.

## Principle

Build from trustworthy evidence outward:

```text
Identity + Calendar
      ↓
Market Evidence
      ↓
Storage + Integrity
      ↓
Universe + Eligibility
      ↓
Scanner
      ↓
Scanner Operations
      ↓
Strategy Lab
      ↓
Research Validation
      ↓
Risk Governor
      ↓
Broker Execution
      ↓
Live Capital
      ↓
Autonomous Capital Scaling
```

## Phase 0 — Project boundary and contracts

Goal: PeaceSTOCKS is an independent product/module with clear ownership.

Required:

- dedicated PeaceSTOCKS repository;
- canonical docs;
- provider-neutral contracts;
- no coupling to unrelated PeaceAI packages;
- explicit public interfaces;
- clear data directories;
- versioned schemas;
- deterministic config fingerprints.

Do not build trading before this boundary exists.

## Phase 1 — Security identity and market calendar

Goal: every future record has stable identity and session meaning.

Required:

- stable internal security ID;
- provider identity mapping;
- ticker history;
- lifecycle states;
- U.S. stock/ETF scope;
- NYSE/Nasdaq session calendar;
- normal, closed, holiday, half-day behavior;
- point-in-time universe membership.

Completion:

Historical evidence remains interpretable even when ticker names or listing states change.

## Phase 2 — Canonical market evidence

Goal: acquire and preserve source truth.

Initial evidence:

- unadjusted daily OHLCV;
- provider timestamps;
- ingestion timestamps;
- provenance;
- corporate actions;
- corrections/revisions;
- source quality/failure states.

Provider baseline:

- Massive Stocks Basic / current supported EOD path.

Rules:

- no derived indicator persistence when reconstructable;
- no silent overwrite;
- no fabricated missing bars;
- provider failures are explicit.

## Phase 3 — Storage and integrity

Goal: market evidence survives years without becoming bloated or unverifiable.

Required:

- permanent/cache/transient separation;
- manifests;
- checksums;
- atomic writes;
- idempotent append;
- corruption detection;
- revision ledger;
- archival reader abstraction;
- migration/version strategy.

Storage law:

**Store Sources, Rebuild Consequences.**

Physical codec work must preserve the logical Foundation D contract.

For the local compact archive, the canonical productionization target is `PACKED_BLOCKS_FOR_DELTA_STATES_ZSTD7` as defined in `CANONICAL_DECISIONS.md`. Do not default to legacy Dust V1 or reopen codec selection without an Auditor-supported replan.

## Phase 4 — Historical evidence sufficiency

Goal: enough history exists for real ranking.

Required:

- resumable historical backfill;
- provider-plan-aware history limits;
- eligibility levels;
- incomplete history stays incomplete;
- no retroactive forward predictions.

Completion:

A useful percentage of the U.S. stock/ETF universe reaches normal scanner eligibility from real evidence.

## Phase 5 — Scanner V0

Goal: produce real ranked candidate sets from real data.

Required:

- universe refresh;
- feature reconstruction;
- ranking families;
- deterministic overall rank;
- immutable scanner beliefs;
- frozen candidate sets;
- explicit prediction availability;
- human-readable result reader.

Initial ranking families:

- momentum;
- trend;
- relative strength;
- risk;
- liquidity.

Initial output:

- Top 15 overall;
- Top 50 overall;
- strongest momentum;
- fastest improving;
- defensive/low risk.

Completion:

A full real U.S. stock/ETF scan completes through the production provider path and produces retrievable results.

## Phase 6 — GitHub-built online scanner operational reliability

Goal: the production scanner is built/versioned/deployed from GitHub and works repeatedly online, not once and not only from a developer PC.

Bootstrap execution may use GitHub Actions with external durable state. Final execution may graduate to a dedicated online worker without redesigning Scanner logic.

Required:

- hosted backend/worker runtime;
- production secret management;
- provider publication readiness handling;
- global provider rate limiting;
- retries/backoff;
- missed-session catch-up;
- durable online scheduler state;
- failed-session preservation;
- idempotent rerun;
- explicit run reports;
- scanner health summary/API;
- no duplicate evidence;
- watchdog/recovery;
- restart/deployment recovery.

Completion:

Multiple consecutive scheduled **online** sessions complete or clearly report provider/environment failure without losing state, and the user's local PC is not required to remain powered on.

## Phase 7 — Intraday evidence foundation

Goal: add higher-resolution evidence only after daily Scanner V0 is reliable.

Target logical baseline:

- full approved universe;
- regular-session 10-minute bars;
- ~39 intervals on normal sessions;
- half-day interval count derived from calendar.

Future tiers:

- full universe 10-minute;
- top candidates richer 1–5 minute/extended hours;
- holdings execution-level quote/spread/fill evidence.

Do not let intraday acquisition block daily scanner reliability.

## Phase 8 — Strategy Lab

Goal: answer what actually works.

Required:

- deterministic simulations;
- parallel strategy candidates;
- known baselines;
- strategy inventions/hybrids;
- realistic cost/slippage assumptions;
- walk-forward validation;
- regime labeling;
- failure memory;
- strategy genealogy;
- benchmark comparison;
- capacity estimates.

No strategy graduates from a backtest alone.

## Phase 9 — Research governance

Goal: prevent data-mining from being mistaken for intelligence.

Required:

- train/research vs validation separation;
- out-of-sample tests;
- multiple-testing controls;
- leakage checks;
- frozen experiment specifications;
- reproducibility;
- live-vs-research drift;
- independent validation.

## Phase 10 — Deterministic Risk Governor

Goal: no model can talk its way around risk.

Required:

- capital allowance;
- concentration caps;
- maximum order size;
- loss/drawdown limits;
- stale-data guard;
- duplicate-order guard;
- no margin/leverage initially;
- no options initially;
- no withdrawals;
- no account/bank changes;
- market-session controls;
- emergency kill switch.

Risk controls must live outside strategy/model discretion.

## Phase 11 — Broker execution adapter

Goal: translate approved decisions into safe broker operations.

Required:

- sandbox/paper broker first;
- idempotent order intent;
- order acknowledgement;
- cancel/replace safety;
- fill reconciliation;
- position reconciliation;
- cash reconciliation;
- brokerage outage handling;
- audit records.

## Phase 12 — Shadow live mode

Goal: compare PeaceSTOCKS decisions against live markets without placing capital.

Track:

- hypothetical orders;
- expected slippage;
- missed fills;
- signal decay;
- scanner-to-execution latency;
- real-world cost model accuracy.

## Phase 13 — Small live capital

Goal: prove the entire system with minimal financial exposure.

Initial user concept:

- seed at most about $100;
- preferably less if practical.

Live authority stays narrow.

No performance claim is trusted until enough live evidence exists.

## Phase 14 — Capital scaling

Scale only when:

- live system behaves as research predicted;
- drawdowns remain inside policy;
- operational errors are rare and bounded;
- strategy edge survives costs;
- risk governor is proven;
- user explicitly authorizes more capital.

Capital increases are not automatic merely because recent returns are positive.

## Phase 15 — Principal recovery / generated-capital model

Long-term concept:

- track contributed principal separately;
- use high-water-mark accounting;
- after cumulative profit equals original principal, allow principal recovery;
- later distribute roughly 10% of eligible new profits to the user;
- allow roughly 90% to compound.

This is an accounting policy idea, not a promise of profitability.

## Dependency rule

If a later phase discovers a foundational defect:

1. preserve current evidence;
2. return to the lowest broken prerequisite;
3. repair it;
4. verify it;
5. resume the parent phase.

Never work around a broken evidence or risk contract just to keep moving.

## Decision discipline

Before planning or building any phase, read `CANONICAL_DECISIONS.md`.

- `LOCKED` decisions are requirements.
- `PRODUCTIONIZE` decisions are the first implementation target and may not be silently replaced by older/easier code.
- only `OPEN` decisions may be freely selected by Architect.

## Current priority

The present highest-priority unfinished product milestone is:

**Phase 5/6 — real Scanner V0 + operational reliability.**

PeaceSTOCKS should not expand into live trading until this is directly proven.
