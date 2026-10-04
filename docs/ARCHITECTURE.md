# PeaceSTOCKS Architecture

## System map

PeaceSTOCKS is designed as a set of separable layers.

```text
Market Providers
      ↓
Provider Adapters
      ↓
Canonical Evidence / Foundation D
      ↓
Universe + Eligibility
      ↓
Feature Reconstruction
      ↓
Scanner Ranking
      ↓
Frozen Beliefs / Candidate Sets
      ↓
Strategy Lab
      ↓
Deterministic Risk Governor
      ↓
Broker Execution Adapter (future)
      ↓
Reconciliation / Audit
```

Supporting all layers:

- evidence manifests;
- failure/health records;
- version/config fingerprints;
- scheduler/collector state;
- result readers/UI;
- archival storage.

## 1. Provider boundary

`MarketProvider` is the normalization boundary.

Current adapters:

- `MassiveMarketProvider` — initial read-only live data path;
- `FileMarketProvider` — deterministic fixture/certification path.

The core scanner should not depend on provider-specific response shapes.

Provider secrets must never be stored in evidence, reports, Git, or scanner output.

## 2. Security Master and identity

Ticker symbols are labels, not identity.

PeaceSTOCKS uses stable internal security IDs tied to provider identities and preserves ticker history.

The Security Master tracks:

- stable security ID;
- current symbol;
- historical symbols;
- asset type;
- country/exchange;
- first-seen date;
- listing date where available;
- active/inactive/delisted lifecycle;
- provider identities;
- tradability;
- eligibility level.

This prevents ticker changes and relistings from corrupting historical continuity.

## 3. Point-in-time universe

Universe membership must be stored as evidence.

The system needs to know which securities were considered in scope at each date.

Initial inclusion:

- country = US;
- asset type = STOCK or ETF;
- provider record accepted by current scope rules.

Inactive securities remain in history rather than being deleted.

## 4. Eligibility ladder

Current history levels:

- LEVEL_0 — tracked, no usable bar history;
- LEVEL_1 — short history;
- LEVEL_2 — normal scanner eligibility;
- LEVEL_3 — long-history/advanced eligibility.

Current implementation promotes based on stored bar count and never fabricates history.

## 5. Canonical evidence

Current daily evidence stores unadjusted OHLCV plus provenance.

Corporate actions are stored separately rather than rewriting source prices.

Revisions/corrections are ledgered rather than silently overwriting historical evidence.

Future intraday canonical evidence uses 10-minute interval records with explicit state such as:

- VALID_TRADED;
- NO_TRADE;
- HALTED;
- NOT_LISTED;
- INACTIVE;
- PROVIDER_MISSING;
- SOURCE_FAILURE;
- PARTIAL.

## 6. Derived features

Indicators/features are reconstructed in memory from canonical evidence and versioned recipes.

Current feature families include:

- short return;
- 20-day return;
- 60-day momentum;
- 20-day volatility;
- 60-day drawdown;
- 20-day average dollar volume;
- 20-day market-relative strength.

Derived values are generally not permanent archive facts.

## 7. Scanner

The scanner ranks eligible securities using deterministic family scores:

- momentum;
- trend;
- relative strength;
- risk;
- liquidity/activity.

Current default weights are versioned in source.

The scanner produces:

- per-security beliefs;
- overall ranks;
- family scores;
- frozen prediction/candidate sets.

Current prediction sets include:

- TOP_15_OVERALL;
- TOP_50_OVERALL;
- STRONGEST_MOMENTUM;
- FASTEST_IMPROVING;
- DEFENSIVE_LOW_RISK.

The candidate sets are research outputs, not trade orders.

## 8. Strategy Lab

The Strategy Lab consumes canonical evidence and frozen scanner outputs.

It should support:

- parallel paper portfolios;
- many strategy families;
- known strategy baselines;
- PeaceSTOCKS-generated variants;
- market-regime classification;
- genealogy;
- failure memory;
- realistic cost/slippage assumptions;
- walk-forward and out-of-sample testing;
- anti-leakage and multiple-testing controls.

See [STRATEGY_LAB.md](STRATEGY_LAB.md).

## 9. Deterministic Risk Governor

The future risk governor must remain independent of model persuasion.

It should enforce hard limits such as:

- approved capital only;
- no withdrawals;
- no bank changes;
- no margin/leverage initially;
- no options initially;
- position/concentration limits;
- loss/drawdown limits;
- stale-data rejection;
- duplicate-order protection;
- maximum order size;
- market/session rules;
- kill switch;
- reconciliation.

See [RISK_AND_CAPITAL.md](RISK_AND_CAPITAL.md).

## 10. Persistence classes

PeaceSTOCKS separates:

### Permanent evidence

Irreplaceable or historically meaningful facts.

### Rebuildable cache

Derived data that can be regenerated from permanent evidence.

### Transient workspace

Provider payloads, validation artifacts, temporary decode/benchmark files, and other short-lived material.

See [STORAGE.md](STORAGE.md).

## 11. Collector / runtime

The intended production scanner is **online/backend-first**.

Production target:

- hosted backend/cloud collector runs independently of the user's desktop PC;
- scheduled EOD collection and scanner finalization happen online;
- provider availability/retry logic lives in the online runtime;
- scanner results are persisted online and exposed through a stable API/result surface;
- local machines are not required to be powered on for the daily scanner to complete.

Local systems remain important for:

- development;
- independent verification;
- long-term archive;
- Strategy Lab compute where appropriate;
- backup/fallback operation.

Long-term archive flow:

- online collector keeps a short validation/sync buffer;
- local archive receives verified historical evidence;
- checksummed handoff confirms integrity;
- cloud copies may be purged only after local acknowledgement.

The **website frontend is not the collector**. The online backend/worker is the collector and scanner runtime; the website is a results/control surface.

The archive should survive collector replacement and provider changes.

## 11A. Offline local archive behavior

The production scanner must continue functioning when the user's local PC or archive node is powered off.

Required behavior:

```text
Local PC OFF
    ↓
Online collector/scanner continues normally
    ↓
New market evidence + scanner results are sealed online
    ↓
Unsynced evidence remains in a temporary online retention buffer
    ↓
Local archive comes back online
    ↓
Pending sealed evidence is transferred
    ↓
Local Reader/Archive verifies manifest + checksum + logical decode
    ↓
Evidence is written into the compact local archive (Dust or its validated successor)
    ↓
Local archive records ACK
    ↓
Cloud copy becomes eligible for retention-policy purge
```

The cloud must never delete the only copy merely because a transfer was attempted. Purge eligibility begins only after durable local acknowledgement.

The physical Dust representation must remain transparent to consumers. Scanner, Strategy Lab, charting, and other readers request canonical logical records; the storage Reader locates, verifies, decodes, and reconstructs those records from Dust.

A compact archive must therefore remain:

- lossless with respect to the canonical logical evidence contract;
- integrity checked;
- readable without the original transient provider payload;
- usable for future feature reconstruction, backtesting, auditing, and historical inspection.

## 12. Result surfaces

PeaceSTOCKS should expose results through a stable read path rather than requiring users to inspect raw JSONL files.

Useful result surfaces include:

- latest scan summary;
- ranked Top 15;
- family-score breakdown;
- reason/eligibility;
- incomplete/skipped symbols;
- provider/run health;
- historical scan lookup.

A UI can be built later on the same reader contract.

## 13. Non-goals for Scanner V0

Scanner V0 should not expand into:

- autonomous live trading;
- brokerage transfers;
- portfolio optimization requiring leverage;
- options;
- news/LLM trading;
- social sentiment;
- international assets;
- unrelated PeaceAI engineering.

First priority is a trustworthy real scanner path.
