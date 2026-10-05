# PeaceSTOCKS Canonical Repository Structure

This is the intended structure for the dedicated `PeaceG03/PeaceSTOCKS` repository.

The exact implementation language or build tooling may evolve, but subsystem ownership should remain recognizable.

```text
PeaceSTOCKS/
├─ README.md
├─ docs/
│  ├─ README.md
│  ├─ VISION.md
│  ├─ ARCHITECTURE.md
│  ├─ CANONICAL_BUILD_ORDER.md
│  ├─ SCANNER.md
│  ├─ STORAGE.md
│  ├─ STRATEGY_LAB.md
│  ├─ RISK_AND_CAPITAL.md
│  ├─ OPERATIONS_AND_ROADMAP.md
│  └─ TEAM_WORKFLOW.md
│
├─ Scanner/
│  ├─ README.md
│  ├─ src/
│  │  ├─ contracts/
│  │  ├─ providers/
│  │  │  ├─ massive/
│  │  │  └─ file-fixture/
│  │  ├─ identity/
│  │  ├─ calendar/
│  │  ├─ universe/
│  │  ├─ evidence/
│  │  ├─ features/
│  │  ├─ ranking/
│  │  ├─ results/
│  │  ├─ scheduler/
│  │  ├─ validation/
│  │  └─ health/
│  └─ tests/
│
├─ Storage/
│  ├─ README.md
│  ├─ logical/
│  ├─ codecs/
│  │  ├─ dust/
│  │  └─ standard/
│  ├─ reader/
│  ├─ manifests/
│  ├─ migration/
│  └─ benchmarks/
│
├─ StrategyLab/
│  ├─ README.md
│  ├─ strategies/
│  ├─ experiments/
│  ├─ regimes/
│  ├─ baselines/
│  ├─ scoring/
│  ├─ costs/
│  ├─ genealogy/
│  └─ validation/
│
├─ Risk/
│  ├─ README.md
│  ├─ policies/
│  ├─ governor/
│  ├─ limits/
│  ├─ kill-switch/
│  └─ tests/
│
├─ Execution/
│  ├─ README.md
│  ├─ broker-adapters/
│  ├─ order-intent/
│  ├─ reconciliation/
│  └─ audit/
│
├─ Collector/
│  ├─ README.md
│  ├─ local/
│  ├─ cloud/
│  ├─ sync/
│  └─ health/
│
├─ apps/
│  ├─ cli/
│  └─ web/
│
├─ scripts/
├─ tooling/
└─ tests/
```

## Why Scanner is its own top-level subsystem

The scanner is the first production product slice.

It needs to be independently understandable and runnable without requiring the future Strategy Lab or trading stack.

Scanner owns:

- market universe;
- current provider ingestion;
- canonical daily scan input;
- derived feature recipes used by scanner;
- ranking;
- frozen scanner results;
- scheduler;
- scanner health.

Scanner does not own:

- broker orders;
- portfolio execution;
- withdrawals;
- long-term strategy research;
- risk-policy authority.

## Why Storage is separate from Scanner

Scanner needs storage but should not own the physical archive forever.

The logical contract must remain stable while physical formats evolve.

Scanner asks the Reader/storage interface for canonical evidence.

Storage may internally move from JSONL to Dust or another future format without requiring scanner ranking code to parse physical files.

## Why StrategyLab is separate

Strategy experiments are expected to change rapidly.

They must not destabilize the scanner or canonical evidence path.

Strategy Lab reads evidence through stable Reader contracts and writes experiment evidence separately.

## Why Risk is separate

Risk rules are authority boundaries, not strategy suggestions.

A model/strategy cannot modify or bypass the active risk policy while executing a trade.

## Why Collector is separate

Collection uptime and storage/archive concerns differ.

A future cloud collector can be replaced without changing:

- scanner logic;
- strategy logic;
- risk logic;
- historical evidence semantics.

## Canonical ownership rule

Each concern has one home.

Do not duplicate:

- security identity in Strategy Lab;
- provider normalization in ranking;
- strategy logic in provider adapters;
- risk limits inside strategy prompts;
- physical codec parsing inside scanner ranking;
- broker reconciliation inside scanner.

## Migration from current PeaceAI repo

Current sources live under:

`src/`

(migrated from PeaceAI `packages/markets-scanner/`; previously planned target was:)

`Scanner/`

without major rewrite.

Later refactoring can split storage-specific code into `Storage/` after behavior is preserved by tests.

The first migration goal is repository separation, not architecture churn.
