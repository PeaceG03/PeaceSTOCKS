# PeaceSTOCKS

PeaceSTOCKS is the market-research, scanner, strategy-development, risk-governance, and eventually tightly controlled trading subsystem of the Peace ecosystem.

This directory is the canonical product and engineering documentation for PeaceSTOCKS. It is intentionally separated from general PeaceAI engineering so the stock system can evolve as its own product while still using PeaceAI capabilities where appropriate.

> Canonical docs are being finalized on this staging branch and must be mirrored into the existing dedicated `PeaceG03/PeaceSTOCKS` repository. Active PeaceSTOCKS development belongs in that dedicated repository.

## Product goal

PeaceSTOCKS should become a disciplined market system that can:

1. observe a broad U.S. stocks + ETFs universe;
2. preserve trustworthy historical market evidence;
3. rank and narrow the universe into a small set of candidates;
4. simulate many strategies in parallel;
5. learn which strategies work in which regimes;
6. preserve failures so bad ideas are not rediscovered;
7. operate under deterministic risk controls;
8. eventually manage only capital explicitly assigned to it;
9. prove performance before receiving more authority;
10. remain auditable enough that a future reviewer can reconstruct what was known, believed, predicted, and done at any historical point.

PeaceSTOCKS is not intended to be an unrestricted autonomous trading bot. The long-term architecture deliberately separates research intelligence from deterministic risk and execution controls.

## Current first production target

The immediate production target is a reliable scanner using real U.S. stocks and ETFs through the available Massive Stocks data path.

Initial scope:

- U.S. stocks + ETFs only
- Massive Stocks Basic / available EOD data
- no brokerage connector required for scanner V0
- no options, futures, forex, crypto, bonds, leverage, or margin
- real market data only for production claims
- failures must remain visible
- rankings/results must be durable and reproducible

## Canonical reading order

Read these in order when starting or resuming PeaceSTOCKS work:

1. [CURRENT_STATUS.md](CURRENT_STATUS.md) — what is actually implemented, verified, incomplete, or future.
2. [VISION.md](VISION.md) — what PeaceSTOCKS is intended to become.
3. [CANONICAL_DECISIONS.md](CANONICAL_DECISIONS.md) — binding locked decisions, mandatory productionization targets, and the small set of genuinely open choices.
4. [CANONICAL_BUILD_ORDER.md](CANONICAL_BUILD_ORDER.md) — the dependency order in which PeaceSTOCKS should be built.
5. [ARCHITECTURE.md](ARCHITECTURE.md) — system boundaries and major subsystems.
6. [REPOSITORY_STRUCTURE.md](REPOSITORY_STRUCTURE.md) — canonical layout for the dedicated PeaceSTOCKS repository.
7. [SCANNER.md](SCANNER.md) — scanner design, real-data history, test evidence, storage benchmarks, known failures, and production PASS definition.
8. [STORAGE.md](STORAGE.md) — Foundation D/D.1 evidence model, permanent/cache/transient breakdown, Dust/packed storage work, benchmark results, and long-term archive rules.
9. [STRATEGY_LAB.md](STRATEGY_LAB.md) — paper research, strategy competition, regime specialization, genealogy, and anti-overfitting rules.
10. [RISK_AND_CAPITAL.md](RISK_AND_CAPITAL.md) — capital model, deterministic risk governor, and live-authority boundaries.
11. [OPERATIONS_AND_ROADMAP.md](OPERATIONS_AND_ROADMAP.md) — scanner operations, cloud/local collector direction, deployment, and product roadmap.
12. [GROK_WORKFLOW.md](GROK_WORKFLOW.md) — universal Architect → Builder → Auditor workflow for every Grok prompt.
13. [TEAM_WORKFLOW.md](TEAM_WORKFLOW.md) — PeaceSTOCKS-specific application of the universal workflow.

## Canonical authority

When these documents disagree with an older chat, benchmark note, or obsolete plan:

- validated current implementation/evidence wins for **current status**;
- `CANONICAL_DECISIONS.md` defines the binding defaults and productionization targets;
- these canonical docs define **intended architecture and build order**;
- agents must not reopen a LOCKED/PRODUCTIONIZE decision without the evidence and replan process defined in `CANONICAL_DECISIONS.md`;
- a deliberate new decision must update the relevant canonical doc rather than silently diverging.

Do not infer completion of a future phase from its documentation.

## Current implementation

The existing implementation lives under:

`src/`

Major implemented pieces already include:

- provider-neutral scanner contracts;
- Massive read-only provider adapter;
- stable security identity and ticker history;
- U.S. stock/ETF universe refresh;
- inactive-security preservation;
- daily OHLCV ingestion;
- corporate-action evidence;
- correction lineage;
- eligibility levels;
- deterministic feature reconstruction;
- deterministic ranking;
- immutable scanner beliefs;
- frozen prediction sets;
- prediction availability state;
- partition manifests/checksums;
- resumable historical backfill;
- scheduler host/catch-up logic;
- storage measurement;
- 10-minute intraday logical schema;
- Dust V1 codec/reader/validation work;
- synthetic full-universe benchmark infrastructure.

## Core principles

### Store Sources, Rebuild Consequences

If information can be deterministically reconstructed from stored source evidence, do not permanently duplicate it.

Examples usually reconstructed on demand:

- returns;
- moving averages;
- RSI/MACD-style indicators;
- momentum;
- volatility;
- drawdown;
- relative strength;
- rank velocity;
- future-return labels;
- graph coordinates.

Examples that are worth preserving because they cannot be reconstructed later from raw market data alone:

- what universe PeaceSTOCKS believed existed at the time;
- provider observations and revisions;
- corporate actions;
- predictions;
- scanner decisions/beliefs;
- strategy experiment results;
- failures;
- configuration/version fingerprints;
- validation proofs and manifests.

### Point-in-time truth

PeaceSTOCKS must support both:

- best-known-now truth;
- what-was-known-at-the-time truth.

No future information may leak into historical scanner or strategy evaluation.

### No false passes

A test fixture, one successful symbol, a configured scheduler, or a passing unit test does not prove the production scanner works.

The scanner is operational only when a real supported market-data run completes through the intended path, evaluates the intended universe, persists results, exposes failures, and can be rerun without corrupting state.

### Evidence before authority

Trading authority grows only after measured proof. Research intelligence can be flexible; risk controls must remain deterministic and independently enforceable.
