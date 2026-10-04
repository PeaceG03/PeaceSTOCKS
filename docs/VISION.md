# PeaceSTOCKS Vision

## North Star

PeaceSTOCKS is intended to become a long-term disciplined market intelligence and capital-management system that can independently research U.S. public markets, discover strategies, compare them against strong baselines, preserve its own mistakes, and eventually trade only within explicit user-approved capital and risk limits.

The system should optimize for durable evidence and repeatable decision quality, not for exciting short-term claims.

## Market coverage

### Initial production scope

- U.S. common stocks
- U.S. ETFs
- automatic discovery of newly listed supported stocks/ETFs within that scope
- end-of-day / free-data constraints accepted for Scanner V0

### Future expansion only after the stock/ETF foundation is proven

Possible later families:

- richer intraday data;
- extended-hours data;
- options;
- futures;
- forex;
- bonds/fixed income;
- crypto;
- macro and alternative datasets.

None of those belong in Scanner V0 unless explicitly promoted later.

## Research funnel

The intended flow is:

`WHOLE MARKET → ELIGIBILITY → FEATURES → FAMILY SCORES → RANKING → TOP CANDIDATE POOL → STRATEGY/RISK REVIEW → CAPITAL`

The Top 15 is a candidate pool, not a requirement to buy 15 securities.

PeaceSTOCKS should be comfortable allocating to fewer candidates, holding cash, or making no trade when evidence is weak.

## Research horizon

PeaceSTOCKS should evaluate behavior across:

- short-term;
- medium-term;
- long-term;
- active;
- passive;
- trend/momentum;
- mean reversion;
- quality/defensive;
- hybrid/invented strategies.

Known strategies are baselines, not sacred rules. PeaceSTOCKS may invent variants and hybrids, but new strategies must beat strong baselines after realistic costs and risk.

## Strategy memory

The Strategy Lab should preserve:

- successful strategies;
- failed strategies;
- why each strategy failed;
- parameter sets;
- market regime;
- capacity assumptions;
- turnover/cost assumptions;
- lineage from parent strategies;
- later descendants/hybrids.

The point is to prevent repeated rediscovery of the same bad ideas and to allow regime-specific champions instead of pretending one strategy must dominate all markets.

## Future operating model

A mature PeaceSTOCKS system may use:

- a cloud/backend collector for high-uptime market capture;
- a local PC or dedicated mini-PC as long-term archive and research node;
- short-lived cloud retention;
- local verified sync with hashes/manifests;
- cloud deletion only after local acknowledgement.

The public website/UI should not itself be the collector. The backend collector gathers evidence; the website surfaces results.

## Always-on scanner, deferred local archive

PeaceSTOCKS is intended to keep scanning even when the user's local PC is turned off.

The hosted backend owns uptime. The local machine owns long-term compact archival storage when available.

The desired lifecycle is:

```text
online scanner runs continuously
→ temporarily retains unsynced sealed evidence online
→ local PC/archive later comes online
→ pending evidence syncs and verifies
→ compact Dust archive stores it locally
→ Reader can reconstruct the original canonical information whenever needed
→ cloud copy may later be purged after local acknowledgement
```

This lets PeaceSTOCKS combine online availability with low-cost long-term local storage.

## Outage philosophy

Historical market evidence can often be caught up after an outage.

Forward-looking beliefs and predictions cannot be recreated honestly after the fact.

Therefore the system must distinguish:

- historical evidence catch-up;
- forward decision/prediction continuity.

A missed historical bar can sometimes be reacquired. A missed prediction must remain recorded as missed/unavailable, not fabricated later.

## Capital progression

The initial live-capital concept is deliberately small:

- maximum initial seed around $100;
- preferably lower if brokerage constraints allow;
- later recurring contributions may be around $175/month if the user explicitly chooses to redirect available cash.

The purpose of small capital is validation, not income.

After cumulative realized/recognized profit equals contributed principal, the long-term model is:

1. allow original principal to be recovered;
2. continue primarily with generated capital;
3. user may take roughly 10% of distributable new profits;
4. roughly 90% may continue compounding.

Accounting should use a high-water-mark model so old profits are not counted repeatedly.

These are product goals, not guaranteed returns.

## Trust ladder

A future authority ladder should look roughly like:

1. observe only;
2. produce scanner results;
3. paper strategies;
4. shadow recommendations;
5. limited live trading with very small capital;
6. larger capital only after long enough evidence;
7. richer instruments only after separate approval and validation.

PeaceSTOCKS never gains permission to withdraw funds, change bank details, or expand its own authority.

## What “professional quality” means

PeaceSTOCKS does not need institutional-scale data bloat.

It should instead make a professional reviewer able to answer:

- What happened?
- What data did the system actually have?
- What did the system believe at the time?
- What did it predict?
- Why did it rank something highly?
- What strategy/config/version produced the result?
- Was the input later corrected?
- Can the result be reproduced?
- Did risk controls allow or reject the action?

A small but reconstructable archive is preferable to an enormous opaque data lake.
