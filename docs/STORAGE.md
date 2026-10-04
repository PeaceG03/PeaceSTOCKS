# PeaceSTOCKS Storage and Evidence Architecture

## Purpose

PeaceSTOCKS storage exists to preserve trustworthy market evidence for years while remaining small enough to run locally.

The archive is not intended to preserve every intermediate calculation.

Its job is to preserve enough irreducible evidence that future PeaceSTOCKS versions can reconstruct:

- what the market did;
- which securities existed and were considered eligible;
- what data the provider supplied;
- what was known at the time;
- what the scanner believed and predicted;
- what later corrections occurred;
- what experiment or strategy version produced a result;
- whether stored data passed integrity validation.

## Core storage law

# Store Sources, Rebuild Consequences

If value Z can be reconstructed deterministically from preserved X and Y, do not permanently store Z unless Z itself is a historical decision, prediction, failure, experiment result, or another fact that cannot be recreated honestly later.

### Usually reconstruct

- moving averages;
- RSI;
- MACD;
- returns;
- momentum;
- volatility;
- drawdown;
- relative strength;
- rank velocity;
- graph coordinates;
- most technical indicators;
- adjusted price series when source bars + actions + recipe version are preserved.

### Permanently preserve

- canonical source bars;
- security identity/lifecycle;
- point-in-time universe membership;
- corporate actions;
- provider revisions/corrections;
- prediction sets;
- scanner beliefs;
- strategy experiment results;
- failures/health events;
- data-quality states;
- manifests/checksums;
- schema/config/version fingerprints;
- irreversible live actions in future execution systems.

## Foundation D logical contract

Foundation D is the canonical research/evidence contract.

Physical storage may change without invalidating this logical model.

### Stable security identity

Do not store ticker as permanent identity.

Each security uses a stable internal ID and provider identity mapping.

Ticker history is lifecycle evidence.

### Point-in-time universe

Store inclusion/exclusion events rather than only today's universe.

The system must be able to ask:

> Which securities did PeaceSTOCKS believe were in scope on date X?

### Session/calendar registry

Session interpretation belongs to the archive contract.

Records must distinguish:

- normal session;
- half day;
- holiday/closed;
- unusual halt/exception where relevant.

### Canonical market evidence

Initial daily bar evidence:

- security ID;
- session date;
- open;
- high;
- low;
- close;
- volume;
- source timestamp where available;
- observed time;
- ingestion time;
- quality;
- flags;
- revision;
- provenance.

### Corporate-action ledger

Store:

- splits;
- reverse splits;
- dividends;
- ticker changes;
- merger/successor events;
- closures/delistings;
- spin-offs when supported.

Do not silently rewrite original bars.

### Revision-aware evidence

Provider corrections must produce revision/correction lineage.

The system should support:

- best known now;
- known at the time.

### Bitemporal/time-awareness

Important time concepts include:

- event/session time;
- provider/source time;
- first observed/ingested time;
- correction/revision time.

Historical research must not accidentally use a correction or fact before PeaceSTOCKS could have known it.

### Provenance

Evidence should identify:

- provider;
- dataset;
- provider retrieval/request identity;
- provider timestamp where available;
- ingestion version;
- normalizer version.

### Null/unknown/zero semantics

Never conflate:

- 0;
- missing;
- unknown;
- not applicable;
- provider unavailable;
- no trade;
- security not listed;
- halted.

## Foundation D.1 — 10-minute evidence

The planned full-universe intraday logical baseline is regular-session 10-minute bars.

Normal U.S. session:

- 390 minutes;
- 39 intervals.

Half days use the actual session window.

### Canonical 10-minute interval state

Each logical interval includes an explicit state, including:

- VALID_TRADED;
- NO_TRADE;
- HALTED;
- NOT_LISTED;
- INACTIVE;
- PROVIDER_MISSING;
- SOURCE_FAILURE;
- PARTIAL.

Values such as OHLC/volume are present only where meaningful.

### Why 10 minutes

It gives PeaceSTOCKS meaningful intraday shape without requiring quote/tick-scale storage for the full market.

Future hierarchy may be:

1. full universe: 10-minute regular-session bars;
2. top candidates: richer 1–5 minute / extended-hours evidence;
3. actual holdings/execution: quotes, spreads, orders, fills.

## Three physical storage classes

### 1. Permanent evidence

Keep indefinitely or according to explicit retention policy.

Examples:

- Security Master/lifecycle;
- universe membership;
- canonical bars;
- corporate actions;
- corrections;
- predictions;
- beliefs;
- manifests;
- experiment outcomes;
- failures that teach the system something important.

### 2. Rebuildable cache

May be deleted and regenerated.

Examples:

- feature matrices;
- indicator series;
- chart points;
- sorted rank views;
- strategy intermediate arrays;
- decoded columnar batches.

### 3. Transient workspace

Short lived.

Examples:

- raw provider responses where licensing permits temporary validation;
- normalization scratch files;
- temporary codec outputs;
- staging archives;
- benchmark files.

## Ephemeral Validation Buffer + Sealed Canonical Archive

Before compacting or discarding provider-rich data:

1. collect raw/rich source data into a temporary validation area;
2. normalize;
3. check counts;
4. validate OHLCV ranges;
5. check continuity;
6. validate corporate-action relationships;
7. verify provenance;
8. detect duplicates;
9. perform archive round-trip;
10. compute checksums;
11. seal compact canonical evidence;
12. retain compact validation proof;
13. purge redundant/reacquirable transient material after acknowledgement.

Typical temporary retention target:

- about 1 day to 1 week.

A sealed record can still later receive a provider revision.

“Verified” means PeaceSTOCKS validated what it received, not that the provider can never correct it.

## Storage directory concept

Current scanner implementation uses the logical shape:

```text
root/
├─ permanent/
│  ├─ security-master.json
│  ├─ universe-membership.jsonl
│  ├─ daily-bars/
│  ├─ corporate-actions.jsonl
│  ├─ corrections.jsonl
│  ├─ beliefs/
│  ├─ predictions/
│  ├─ prediction-status/
│  ├─ partitions/
│  └─ intraday-dust/
├─ cache/
└─ transient/
   └─ validation/
```

The dedicated PeaceSTOCKS repo should keep the logical classes even if physical filenames change.

## Data compacting principles

### Stable numeric/security IDs

Do not repeat long ticker/provider strings in every observation.

### Implicit timestamps

For a known session and fixed 10-minute interval index, full timestamps can usually be reconstructed.

### Scaled integers

Where exact scale is defined, encode prices as integers rather than text/floating serialization overhead.

### Delta / ZigZag

Price and numeric series often compress well as deltas.

### Frame-of-reference

Store a block base/minimum and compact residual values where it beats deltas.

### Bit packing

Use the minimum safe bit width per block where measured beneficial.

### Sparse/default state

When nearly all intervals are VALID_TRADED, encode the default once and preserve only exceptions.

### Dictionaries

Repeated values such as:

- provider;
- schema;
- quality state;
- exchange;
- flags;
- provenance strings;

should use dictionaries or partition defaults rather than repeated text.

### Column grouping

Fields with similar statistical behavior may compress better together.

### Block checksums

Corruption must be localized/detectable.

### Reader abstraction

Consumers must ask the Reader for logical records.

Scanner/Strategy Lab must not parse Dust or another physical codec directly.

## Dust

Dust is the custom compact archive line explored for Foundation D.1.

The intent is not “use custom format at all costs.”

Dust competes against maintained standard formats and should only win where measurements justify it.

### Dust V1 ideas

Measured implementation uses concepts including:

- blocks;
- scaled integers;
- deltas/varints;
- dictionaries;
- checksums;
- secondary compression.

### Packed finalist concept

A later packed candidate used:

```text
security/session blocks
→ implicit timestamps
→ compact state bits
→ compact presence encoding
→ scaled integer delta/ZigZag varints
→ metadata dictionary
→ Zstd
```

Current **canonical productionization target** measured result on the frozen full-universe synthetic fixture:

- 22,643,796 bytes;
- 13.51 bytes/bar;
- encode ~178 ms;
- decode ~1.14 million bars/sec;
- exact logical hash passed;
- full checksum passed;
- corrupt payload rejected;
- corrupt block rejected;
- truncation detected;
- atomic seal passed.

`PACKED_BLOCKS_FOR_DELTA_STATES_ZSTD7` is the mandatory productionization target. The older Deflate-based Dust V1 implementation is historical/reference code and must not be retained as the production default merely because it already exists.

The packed target still requires production certification against the Reader, sync, integrity, migration, and Foundation D/D.1 contracts. If it fails a required production criterion, Auditor must return `REPLAN_REQUIRED`; Architect then compares the next-best previously tested candidates. Do not silently fall back to Dust V1 and do not restart the codec search from scratch while tested candidates remain.

## Synthetic full-universe fixture

A deterministic synthetic benchmark exists to test storage algorithms without abusing provider limits or pretending synthetic returns are market performance.

Frozen fixture:

- 10,746 securities;
- 5,317 stocks;
- 5,429 ETFs;
- 4 sessions;
- 419,094 bars/day;
- 1,676,376 total bars.

Logical hash:

`7d70c208667c51c5f7156d90cbefb4c9a557703d599e26773706d1a228661ecd`

State mix intentionally includes:

- VALID_TRADED;
- PARTIAL;
- HALTED;
- NO_TRADE;
- MISSING;
- SOURCE_FAILURE.

It is suitable for fidelity/performance testing.

It is not investment-performance evidence.

## Storage benchmark history

### Initial full-universe synthetic results

Representative results included:

- JSONL: ~401 bytes/bar before compression;
- JSONL + Zstd: ~37.63 bytes/bar;
- Dust V1: ~50.07 bytes/bar;
- packed candidate later improved materially beyond Dust V1.

### Parquet-Zstd full fixture

Measured:

- 61,317,614 bytes;
- 36.58 bytes/bar;
- 1,676,376 rows reconstructed;
- fidelity passed;
- ~1.38M decoded bars/sec;
- parquet-wasm 0.7.2 + apache-arrow;
- 100,000-row groups.

### Packed canonical productionization target

Measured:

- 22,643,796 bytes;
- 13.51 bytes/bar;
- fidelity + integrity checks passed.

## Closed codec tournament

The prior tournament explored/tested candidate families such as:

- Zstd levels;
- Brotli;
- LZ4;
- Deflate;
- Snappy;
- LZMA/xz;
- Bzip2 where practical;
- Parquet;
- Arrow IPC;
- MessagePack;
- CBOR;
- Avro;
- Protobuf;
- row/security/time/column layouts;
- delta;
- frame-of-reference;
- adaptive bit packing;
- RLE/sparse state;
- presence bitmaps;
- block-size/index tradeoffs.

The open-ended storage tournament is not a prerequisite for daily Scanner V0 reliability. However, when implementing the long-term local archive/sync path, use the locked decision in `CANONICAL_DECISIONS.md`: productionize `PACKED_BLOCKS_FOR_DELTA_STATES_ZSTD7` first and certify it. Do not treat codec selection as an open design question.

## Long-term capacity goal

The ambitious target is roughly:

- 32 GB physical archive budget;
- use ~85% as practical capacity;
- ~27.2 GB practical;
- target at least 10 years.

Maximum total average for exactly 10 years:

- ~2.72 GB/year.

Preferred margin:

- <= ~2.4 GB/year total.

This total must include both bars and permanent metadata.

## Permanent metadata that must be budgeted

The final archive projection must include:

- Security Master/lifecycle;
- universe deltas;
- corporate actions;
- revisions;
- partition manifests;
- predictions;
- beliefs/decisions;
- failures/health;
- validation proofs;
- index/integrity overhead.

Do not certify 10 years using bar-only size.

## Dust readback contract

Dust must never become an opaque dead-end archive.

Its contract is:

```text
canonical logical evidence
→ compact Dust encoding
→ long-term local storage
→ Reader verifies and decodes
→ canonical logical evidence reconstructed
```

Downstream PeaceSTOCKS systems must operate on the reconstructed logical contract rather than reading Dust bytes directly.

This guarantees that compact storage remains usable for:

- scanner history;
- Strategy Lab;
- feature reconstruction;
- charting;
- audits;
- point-in-time replay;
- future migration to another validated codec.

A Dust block is acceptable only if round-trip reconstruction preserves the canonical evidence required by its schema and integrity validation passes.

### PC-off buffering rule

The local archive may be offline for hours or days without stopping the online scanner.

During that period:

- the online collector keeps running;
- newly sealed evidence is retained in the online pending-sync buffer;
- no unsynced evidence is purged.

When the local archive reconnects:

- pending evidence is transferred;
- manifest/checksum is verified;
- logical decode is validated;
- evidence is committed locally;
- a durable ACK is written.

Only after that ACK may the cloud copy enter its normal purge/retention lifecycle.

## Cloud/local retention model

Long-term desired architecture:

### Cloud/backend

- high uptime collection;
- short validation buffer;
- current operational state;
- pending sync data.

### Local archive node

- authoritative long-term copy;
- checksummed downloads;
- manifest verification;
- historical Strategy Lab access.

### Purge sequence

```text
collect in cloud
→ validate
→ package/seal
→ local download
→ checksum/manifest verify
→ local ACK
→ cloud may purge old copy
```

Never purge cloud evidence merely because a transfer was attempted.

## Backups by irreplacability

Prioritize backup for:

1. predictions/decisions;
2. strategy experiment/failure history;
3. corrections/lifecycle;
4. provider evidence that cannot be cheaply reacquired;
5. manifests/config/version records.

Reacquirable public-market source data may have different redundancy than unique PeaceSTOCKS decision history.

## Production migration rule

Do not migrate the production archive merely because a benchmark wins.

Before migration:

- codec logical fidelity must pass;
- version/migration story must exist;
- failure injection must pass;
- Reader must support the new physical format;
- real market evidence should be validated;
- old evidence must remain recoverable until migration is audited.
