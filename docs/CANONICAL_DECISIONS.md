# PeaceSTOCKS Canonical Decisions

This file is the binding decision registry for PeaceSTOCKS.

Its purpose is to prevent future development from reopening decisions that were already tested, measured, or explicitly chosen.

## Decision statuses

### LOCKED
Use this design unless new evidence proves it cannot satisfy the product goal.

A Builder or Architect may not silently substitute another approach.

Changing a LOCKED decision requires:

1. direct evidence of a material failure or incompatibility;
2. Auditor verdict `REPLAN_REQUIRED`;
3. Architect comparison against the existing decision and prior evidence;
4. explicit replacement decision recorded here;
5. preservation of migration/rollback safety.

### PRODUCTIONIZE
This is the strongest tested/selected implementation direction, but it still requires production integration/certification.

Do not fall back to an older implementation merely because it already exists.

Builder must productionize this target first.

If it fails certification, the cycle is:

`evidence → Auditor REPLAN_REQUIRED → Architect selects next-best previously tested option`.

Do not restart an open-ended design tournament unless the tested candidates are genuinely exhausted.

### OPEN
No prior result is strong enough to lock a choice yet.

Architect may choose among valid options, but must preserve all LOCKED/PRODUCTIONIZE constraints.

---

# Locked product decisions

## D-001 — Dedicated PeaceSTOCKS product boundary
**Status: LOCKED**

PeaceSTOCKS is developed in the dedicated repository:

`PeaceG03/PeaceSTOCKS`

Do not move active PeaceSTOCKS product development back into PeaceAI.

PeaceAI may integrate with PeaceSTOCKS through defined interfaces later.

## D-002 — Online-first production scanner
**Status: LOCKED**

The production scanner runs on an online backend/worker.

The user's PC is not required to remain powered on for:

- scheduled market collection;
- scanner execution;
- ranking;
- frozen prediction/result creation;
- retries/recovery;
- result availability.

Local execution is development, verification, archive, research, or fallback—not the canonical production runtime.

## D-003 — Online buffer while local archive is offline
**Status: LOCKED**

When the local archive PC/node is off:

- online collection continues;
- scanner continues;
- unsynced sealed evidence remains retained online;
- no unsynced evidence is purged.

When the local archive returns:

1. discover pending evidence;
2. transfer it;
3. verify manifest/checksum;
4. verify logical decode;
5. durably commit local archive data;
6. write local ACK;
7. only then make the corresponding online copy eligible for retention-policy purge.

A transfer attempt is not an ACK.

Partial/corrupt/interrupted transfers remain retryable with the online source retained.

## D-004 — Store Sources, Rebuild Consequences
**Status: LOCKED**

Persist irreducible source/history evidence.

Reconstruct derived indicators/features when needed.

Do not permanently duplicate large reconstructable feature sets without measured justification.

## D-005 — Canonical evidence remains independent of physical codec
**Status: LOCKED**

Foundation D / D.1 logical evidence is the contract.

Scanner, Strategy Lab, UI, and future systems consume logical records through a Reader abstraction.

They must not depend directly on Dust byte layout.

## D-006 — Stable security identity
**Status: LOCKED**

Ticker is a label, not permanent identity.

Preserve:

- stable internal security identity;
- provider identity;
- ticker history;
- active/inactive/delisted lifecycle;
- point-in-time universe membership.

## D-007 — Initial Scanner V0 market scope
**Status: LOCKED**

Scanner V0 covers:

- U.S. stocks;
- U.S. ETFs.

Do not expand into options, futures, forex, crypto, bonds, international markets, margin, or leverage as part of Scanner V0.

## D-008 — Initial real-data provider path
**Status: LOCKED for Scanner V0 unless provider access becomes impossible**

Use the existing Massive Stocks provider adapter/current supported plan path for Scanner V0.

Provider limitations must be handled explicitly rather than hidden.

If the active plan cannot supply a required capability, Auditor must require a replan rather than silently switching providers.

## D-009 — No fake production proof
**Status: LOCKED**

Fixtures, synthetic data, mocks, one-symbol tests, compile success, API health, or scheduler existence cannot prove production Scanner V0.

Production PASS requires real provider + real intended universe + real evidence + real ranking + durable retrievable results + recovery/idempotency evidence.

## D-010 — Forward predictions cannot be backfilled dishonestly
**Status: LOCKED**

Historical market evidence may be caught up later.

A forward scanner belief/prediction that did not actually occur at the correct time must remain unavailable/missed.

Never recreate it later and present it as a genuine forward prediction.

## D-011 — Scanner before Strategy Lab/trading
**Status: LOCKED**

Finish and certify Scanner V0 before starting Strategy Lab implementation, Risk Governor, broker execution, or live-capital work.

---

# Mandatory productionization targets

## D-100 — Local compact archive codec
**Status: PRODUCTIONIZE**

The strongest measured storage candidate from the prior PeaceSTOCKS trials is:

`PACKED_BLOCKS_FOR_DELTA_STATES_ZSTD7`

This is the canonical productionization target.

Do **not** default to the older Deflate-based Dust V1 implementation simply because `dust.ts` already exists.

Recorded frozen full-universe synthetic benchmark evidence for the packed target:

- fixture: 10,746 securities;
- 4 sessions;
- 1,676,376 bars;
- total encoded size: 22,643,796 bytes;
- approximately 13.51 bytes/bar;
- encode approximately 178 ms;
- decode approximately 1.14 million bars/sec;
- exact logical hash reconstruction: PASS;
- full checksum: PASS;
- corrupted payload rejection: PASS;
- corrupted block rejection: PASS;
- truncation detection: PASS;
- atomic seal: PASS.

Logical fixture SHA-256:

`7d70c208667c51c5f7156d90cbefb4c9a557703d599e26773706d1a228661ecd`

Canonical packed design direction:

```text
security/session blocks
→ implicit timestamps
→ compact state bits
→ compact presence encoding
→ scaled integer delta/ZigZag values
→ metadata dictionaries
→ Zstd level 7
→ checksums/integrity metadata
```

Production certification must verify:

- exact Foundation D/D.1 logical round-trip;
- provenance preservation;
- corporate-action/reference preservation where included by schema;
- checksum/integrity behavior;
- corrupt payload rejection;
- corrupt block rejection;
- truncation rejection;
- atomic seal/write behavior;
- Reader compatibility;
- cloud-to-local sync compatibility;
- migration/versioning behavior;
- realistic encode/decode resource use.

If this target fails a required production criterion, do not silently revert to Dust V1.

Auditor returns `REPLAN_REQUIRED`, then Architect compares the next-best **already tested** candidates before authorizing new codec exploration.

## D-101 — Dust naming
**Status: LOCKED**

“Dust” is the PeaceSTOCKS local compact archive subsystem/format family.

The productionized packed Zstd7 method becomes the current Dust implementation once certified.

Older Dust V1 is historical/reference implementation, not the default production target.

## D-102 — Full-universe intraday logical baseline
**Status: PRODUCTIONIZE after daily Scanner V0 reliability**

Foundation D.1 full-universe baseline:

- regular-session 10-minute evidence;
- approximately 39 intervals on normal U.S. sessions;
- half-day count derived from the actual calendar;
- explicit interval states such as VALID_TRADED, NO_TRADE, HALTED, NOT_LISTED, INACTIVE, PROVIDER_MISSING, SOURCE_FAILURE, PARTIAL.

This does not block daily EOD Scanner V0 completion.

---

## D-012 — Automatic universe refresh for new listings
**Status: LOCKED**

The Scanner V0 universe is not a static symbol list.

Each production universe refresh must automatically discover newly supported U.S. stocks and ETFs from the approved provider path and assign/preserve stable internal identity.

New listings enter the universe according to the normal eligibility/history rules; they are not granted fabricated history or immediate advanced eligibility.

Securities that later become inactive/delisted remain preserved historically rather than disappearing from prior universe evidence.

## D-013 — GitHub is the PeaceSTOCKS development/control source of truth
**Status: LOCKED**

PeaceSTOCKS source code, canonical docs, tests, deployment workflows, version history, and audited production revisions live in:

`PeaceG03/PeaceSTOCKS`

GitHub is the engineering/control source of truth.

The scanner must be built from this repository so every production deployment can be traced to a specific reviewed commit.

GitHub is **not** the long-term market-data archive and is **not** the brokerage/custodian.

## D-014 — GitHub workflow bootstrap for Scanner V0
**Status: PRODUCTIONIZE**

The first online Scanner V0 may use GitHub Actions/workflows as the bootstrap execution/orchestration path so the scanner can begin operating without depending on the user's PC.

The bootstrap path must:

- run from the dedicated PeaceSTOCKS repository;
- use repository/environment secrets rather than committed credentials;
- write durable scanner state/results/evidence to external persistent storage rather than the ephemeral runner filesystem;
- preserve provider pacing/retry rules;
- preserve scheduler cursor safety;
- preserve idempotency;
- expose failures rather than hiding them;
- be manually triggerable for verification;
- support scheduled EOD execution where appropriate.

GitHub-hosted execution is not allowed to become the only durability layer.

Architect must design the workflow so the scanner can later move to or coexist with a dedicated always-on worker without redesigning scanner logic or canonical evidence.

If GitHub scheduling/runtime reliability cannot satisfy the final production reliability criteria, the same scanner implementation must be deployable to the dedicated online worker while GitHub remains the source/control/deployment system.

## D-015 — Website is a viewing/control terminal
**Status: LOCKED**

The PeaceSTOCKS website does not contain the canonical scanner engine.

The website reads scanner state/results through stable backend/API interfaces and may provide authorized control actions such as:

- view latest scan;
- view Top 15/Top 50 and family scores;
- view provider/scanner health;
- view archive sync status;
- inspect failures;
- request an allowed/manual scanner run;
- later view Strategy Lab, portfolio, and risk status.

The website may be redesigned/replaced without changing the scanner engine.

## D-016 — Brokerage is the money custodian
**Status: LOCKED**

PeaceSTOCKS, GitHub, the website, and the scanner must never hold user cash themselves.

Real money remains in an approved brokerage account.

Future capital flow is:

```text
User bank
↕
Approved brokerage
↕
Broker API / approved funding flow
↕
PeaceSTOCKS Risk + Execution
```

Adding or withdrawing money requires the brokerage's authorized funding/withdrawal path and user approval where required.

PeaceSTOCKS must not autonomously:

- withdraw funds;
- change bank links;
- change payout destinations;
- add external funding accounts;
- expand its own capital allowance.

The website may display balances and offer an authorized launch/control surface, but custody and transfer execution remain with the brokerage.

# Current scanner decisions to preserve

## D-200 — Eligibility history ladder
**Status: LOCKED unless measurement shows threshold redesign is required**

Current ladder:

- LEVEL_0: no usable stored bars;
- LEVEL_1: short history;
- LEVEL_2: normal scanner eligibility;
- LEVEL_3: long-history/advanced eligibility.

Do not fabricate history to promote a security.

## D-201 — Initial ranking families
**Status: LOCKED for Scanner V0**

Use the existing deterministic baseline families:

- momentum;
- trend;
- relative strength;
- risk;
- liquidity/activity.

Current baseline weights remain:

- momentum 0.25;
- trend 0.20;
- relative strength 0.20;
- risk 0.20;
- liquidity 0.15.

Do not retune these merely to improve an observed result during Scanner V0 certification.

Future Strategy Lab/research can test better weighting separately after Scanner V0.

## D-202 — Initial candidate sets
**Status: LOCKED for Scanner V0**

Preserve:

- TOP_15_OVERALL;
- TOP_50_OVERALL;
- STRONGEST_MOMENTUM;
- FASTEST_IMPROVING;
- DEFENSIVE_LOW_RISK.

They are candidate/research outputs, not trade orders.

## D-203 — Provider publication readiness
**Status: LOCKED**

Market close is not equivalent to provider data readiness.

Runtime must distinguish at least:

- session open;
- session complete;
- provider data not ready;
- provider ready;
- scanner finalized;
- provider hard failure.

Provider-not-ready is retryable.

## D-204 — Provider pacing
**Status: LOCKED**

Rate limiting/pacing belongs at the shared provider-adapter/runtime boundary.

Concurrent provider methods must not independently burst beyond the active provider plan.

## D-205 — Scheduler cursor safety
**Status: LOCKED**

Do not advance durable scheduler state past a required unresolved session.

A session becomes resolved only after its required evidence/run outcome has been safely persisted or explicitly terminally classified.

---

# Open decisions

These remain intentionally open because the prior evidence does not establish a single winner.

## O-001 — Online hosting vendor/runtime
**Status: OPEN**

Choose a backend/worker platform that satisfies:

- always-on/scheduled execution;
- secret management;
- durable state;
- appropriate outbound provider access;
- health/result API;
- restart/redeploy recovery;
- bounded cost.

Do not alter the online-first architecture to fit a hosting limitation.

## O-002 — Exact online persistence technology
**Status: OPEN**

May use a suitable database/object store/filesystem combination, but it must preserve the canonical evidence contract, idempotency, pending-sync state, and ACK-before-purge semantics.

## O-003 — Final consumer UI
**Status: OPEN**

CLI/API is sufficient for Scanner V0 production proof.

The final PeaceSTOCKS web UI can be designed later.

---

# Superseded decisions / historical evolution

These are preserved so future agents do not accidentally resurrect an older plan.

## H-001 — Monthly contribution amount
An earlier planning value was about **$50/month**.

That was later superseded by the current estimate of **about $175/month** if the user explicitly redirects available cash.

The current canonical amount is therefore the later ~$175/month concept, not the older $50/month number.

## H-002 — Dust V1
The earlier Dust V1 implementation used Deflate Raw with scaled integers, delta/ZigZag varints, dictionaries, and checksums.

It was useful and remains historical/reference code.

It was superseded as the preferred productionization target by `PACKED_BLOCKS_FOR_DELTA_STATES_ZSTD7`.

## H-003 — Local-first scanner operation
Earlier implementation work included local scheduled scanner operation.

The canonical production architecture is now **online-first**. Local scanner execution remains development/verification/fallback, not the production target.

# Rule for future “better” ideas

A newer idea does not replace a tested canonical decision because it sounds cleaner or newer.

To replace a LOCKED or PRODUCTIONIZE decision, provide measured evidence against the same relevant acceptance criteria.

Prefer improving a proven route over restarting from zero.

The system should accumulate engineering learning instead of repeatedly discarding it.
