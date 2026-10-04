# PeaceSTOCKS Strategy Lab

## Purpose

The Strategy Lab is where PeaceSTOCKS discovers whether scanner signals and trading ideas have durable value.

It should make it cheap to test many ideas with fake money and expensive to fool ourselves.

## Core idea

PeaceSTOCKS should compare many strategies in parallel instead of assuming one investing style is correct.

Candidate families may include:

- passive benchmarks;
- buy-and-hold;
- momentum;
- trend following;
- relative strength;
- mean reversion;
- quality;
- defensive/low-volatility;
- breakout;
- volatility filters;
- scanner-rank rotation;
- regime-aware allocation;
- hybrid strategies;
- PeaceSTOCKS-invented strategies.

## Known strategies are baselines

A new strategy should not be accepted because it looks clever.

It should be compared against:

- broad index exposure;
- simple equal-weight approaches;
- simple momentum/trend baselines;
- cash where appropriate;
- other relevant low-complexity rules.

If a complex strategy cannot beat a simple baseline after risk/cost, complexity is not justified.

## Parallel paper portfolios

The Strategy Lab should be able to run multiple paper accounts simultaneously.

Each experiment should freeze:

- strategy definition;
- version;
- parameters;
- eligible universe;
- data cutoff;
- cost model;
- rebalance schedule;
- capital assumptions;
- benchmark;
- evaluation window.

## Horizons

Evaluate at multiple horizons:

- short;
- medium;
- long.

Do not optimize everything for a single horizon.

## Regime specialization

Markets change.

PeaceSTOCKS should be able to identify strategy champions for regimes such as:

- strong uptrend;
- weak/bear trend;
- high volatility;
- low volatility;
- broad participation;
- narrow leadership;
- liquidity stress.

The goal is not necessarily to find one forever-strategy.

## Strategy genealogy

Every generated strategy should be able to record:

- parent strategy/strategies;
- mutations;
- parameter changes;
- why it was created;
- experiment result;
- failure reason;
- descendant strategies.

This allows PeaceSTOCKS to learn from search history instead of repeating it.

## Failure memory

Failed strategies are valuable evidence.

Preserve failures such as:

- overfitting;
- high turnover;
- slippage destroys edge;
- regime fragility;
- concentration;
- capacity limits;
- tail loss;
- dependence on unavailable data;
- leakage;
- poor out-of-sample behavior.

PeaceSTOCKS should query this memory before generating another similar idea.

## Cost models

Paper returns without costs are not enough.

Model where relevant:

- commissions;
- spread;
- slippage;
- market impact;
- borrow cost later if shorting is ever allowed;
- tax assumptions only when explicitly modeled;
- latency/execution delay.

Use scenario ranges when exact cost is uncertain.

## Capacity

A strategy that works with $100 may not work with large capital.

Track:

- average dollar volume;
- participation rate;
- position size;
- turnover;
- expected impact;
- maximum practical capital.

## Validation hierarchy

### Development sample

Used to invent/improve strategy.

### Validation sample

Used to select candidates.

### Out-of-sample / walk-forward

Used to test whether behavior survives unseen periods.

### Shadow live

Uses live incoming data without money.

### Small live capital

Only after all prior layers.

## Leakage controls

Prevent:

- future universe membership;
- future corporate-action knowledge;
- corrected data appearing before observed time;
- future classification labels;
- using today's symbol map in historical research without lifecycle awareness;
- tuning on the final evaluation period.

## Multiple-testing control

If PeaceSTOCKS tests thousands of strategies, some will look good by chance.

The experiment registry should record how many ideas were tested and apply appropriate skepticism/penalties.

## Research metrics

Do not rank strategies by raw return alone.

Evaluate combinations of:

- CAGR/return;
- max drawdown;
- volatility;
- Sharpe-like risk-adjusted measures;
- downside risk;
- win/loss characteristics;
- turnover;
- cost sensitivity;
- capacity;
- regime consistency;
- tail behavior;
- correlation to existing strategies;
- simplicity/maintainability.

## Strategy promotion

A strategy may progress:

```text
IDEA
→ BACKTEST
→ VALIDATED
→ WALK_FORWARD
→ SHADOW_LIVE
→ SMALL_LIVE
→ ELIGIBLE_FOR_CAPITAL
```

A failure at a later stage should demote or retire it.

## PeaceSTOCKS-created strategies

PeaceSTOCKS should eventually be able to create new strategies.

That creation process should be constrained by:

- available evidence;
- experiment budget;
- no leakage;
- reproducible specification;
- failure-memory lookup;
- independent validation.

The strategy generator must not have authority to promote its own strategy directly to live capital.

## Strategy Lab output

The Strategy Lab should produce:

- ranked strategy candidates;
- confidence/uncertainty;
- regime fit;
- expected cost/risk;
- capacity;
- known failure modes;
- evidence links;
- recommendation for promotion/demotion.

Those outputs go to risk/capital governance, not directly to a broker.
