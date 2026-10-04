# PeaceSTOCKS Risk and Capital Governance

## Purpose

PeaceSTOCKS may eventually influence real money.

That requires a deterministic authority layer that remains separate from scanner/strategy intelligence.

The system should be designed so an LLM, model, strategy, or bug cannot talk its way around a hard capital rule.

## Separation of concerns

```text
Scanner / Strategy Intelligence
        ↓ proposes
Risk Governor
        ↓ approves/rejects/limits
Execution Adapter
        ↓ sends
Broker
        ↓ confirms
Reconciliation
```

Risk is not a suggestion.

## Initial live-capital concept

The current long-term plan is to begin extremely small.

Initial live seed:

- maximum around $100;
- preferably less if the brokerage supports practical smaller testing.

The purpose is production validation.

It is not expected to generate meaningful income at first.

## Recurring contributions

A future user-selected contribution may be around $175/month based on available budget decisions.

This is not an automatic withdrawal rule.

PeaceSTOCKS receives only explicitly assigned capital.

## Principal-recovery model

Long-term concept:

1. track contributed principal;
2. track cumulative realized/eligible profit separately;
3. once cumulative profit equals contributed principal, allow original principal to be recovered;
4. future trading can continue mainly with generated capital.

Use high-water-mark accounting so the same profit is not counted repeatedly.

## Profit distribution concept

After principal recovery, a conceptual distribution model is:

- about 10% of eligible new profits to the user;
- about 90% remains to compound.

Actual policy should be configurable and explicit.

## No return guarantees

PeaceSTOCKS must not plan around guaranteed returns.

Sustained high returns should be treated as increasingly difficult evidence requirements.

Research should compare results against simple benchmarks after costs.

## Deterministic hard controls

Initial/future governor should include:

### Capital boundaries

- only approved account(s);
- only approved capital pool;
- maximum deployed capital;
- minimum cash reserve where configured.

### Instrument boundaries

Initial live scope:

- long U.S. stocks/ETFs only.

Initially disallow:

- options;
- futures;
- margin;
- leverage;
- short selling unless later separately approved;
- unsupported/illiquid instruments.

### Position limits

- maximum position percentage;
- maximum sector/industry concentration;
- ETF concentration policy;
- correlated-position limits where practical.

### Loss controls

- per-position stop/risk budget where strategy requires;
- daily loss limit;
- rolling drawdown limit;
- strategy drawdown threshold;
- portfolio circuit breaker.

### Data safety

Reject trading when:

- market data stale;
- provider status unhealthy;
- evidence incomplete;
- clock/session uncertain;
- scanner run failed;
- strategy version unknown;
- order reconciliation stale.

### Order safety

- unique intent ID;
- duplicate order rejection;
- maximum quantity/notional;
- price sanity bands;
- cancel/replace rules;
- retry idempotency.

### Account safety

PeaceSTOCKS must not be authorized to:

- withdraw cash;
- change bank links;
- change payout destinations;
- add external accounts;
- change credentials;
- disable the risk governor.

## Kill switch

A user-accessible kill switch must be able to stop new orders immediately.

It should not depend on the strategy model cooperating.

## Human approval tiers

Potential authority tiers:

### Tier 0 — research only

No orders.

### Tier 1 — paper/shadow

No money.

### Tier 2 — tiny live capital

Narrow preapproved rules.

### Tier 3 — bounded autonomous

Larger but still capped authority after sufficient evidence.

Consequential policy changes should require human approval.

## Reconciliation

Never assume broker request success equals portfolio truth.

Reconcile:

- submitted intents;
- broker order IDs;
- accepted/rejected state;
- partial fills;
- final fills;
- positions;
- buying power;
- cash;
- fees.

Unknown reconciliation state should stop new consequential actions.

## Risk model versioning

Each live decision should bind to:

- risk-policy version;
- strategy version;
- scanner/evidence fingerprint;
- account-capital allowance;
- execution adapter version.

Historical live actions must remain explainable after policy changes.

## Scaling capital

Capital should increase only after objective evidence such as:

- enough live observations;
- research/live behavior consistent;
- costs within modeled range;
- no unresolved reconciliation failures;
- drawdowns within expected policy;
- strategy still valid;
- user explicitly approves the new limit.

A recent winning streak is not sufficient.

## Living-off-PeaceSTOCKS goal

The aspirational goal of eventually supporting meaningful income should be treated as a long-horizon outcome, not an engineering acceptance criterion.

Engineering acceptance criteria should remain:

- evidence quality;
- risk containment;
- reproducibility;
- operational reliability;
- measured edge after costs.
