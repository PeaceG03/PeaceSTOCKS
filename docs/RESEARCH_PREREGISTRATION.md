# Phase 2 Pre-Registered Scoring Candidates (`research-preregistration-v1`)

Machine-readable specification: `config/research-preregistration-v1.json` (13 candidates, **all `NOT_RUN`**).
Immutable ledger anchor: `research-ledger/preregistration.jsonl` (+ `.head`), enforced by `src/research-ledger-check.ts`.

## Ground Rules & Contamination Guard
- **Development window:** `2025-03-03..2026-08-26` (5 rolling folds, 63 train / 63 test / 2 embargo, 307 pooled test sessions).
- **Held-out window:** `2026-08-27..2026-11-20` (61 sessions; 60 scorable exits up to `2026-11-23`).
- **Contamination disclosure:** `2026-08-27..2026-11-20` was previously evaluated in `#124`, and `2026-08-27..2026-11-19` was peeked in the `#127` paper-trading replay (`-0.558%/day` gross on `TOP_15_OVERALL`, `-13.7%` universe). None of these 13 candidates was designed or tuned around that peek (all down-market/regime-switch tilts were excluded), no held-out bars `>= 2026-08-27` may be read during development, and Auditor will verify anti-peek compliance before any single `HeldOutSeal.evaluateOnce` run.
- **Post-`#136` baseline re-run:** Pre-`#136` dev baseline numbers (`research-ledger/variants.jsonl` seq 5-9) ran on `ACTIVE`-only bars. After the `#136` delisted backfill lands, the dev baseline must be re-run under a new derived scanner label (and a fresh dev cache rebuilt against the new data manifest) before testing these 13 candidates.
- **Side-by-side only:** `DEFAULT_SCANNER_CONFIG`, `TOP_15_OVERALL`, and `config/paper-rules-v5.json` remain untouched for the live paper trial.
- **Pass bar (`src/research-verdict.ts`):** 100% positive folds (`5/5`) vs **both** equal-weight universe and SPY after `>= 10 bps`/side costs, Holm-adjusted `p < 0.05` across all tried and pre-registered variants (`holmFamily`), pooled net max drawdown `<= 15%` and `<= 1.25x` SPY drawdown, plus one-time held-out pass, short operational live-paper confirmation, and tiny initial live capital (`<= $100`).

## Pre-Registered Families (13 Ideas <= 20 Cap)
1. **Outlier-resistant normalization & turnover damping (4):** `zscore_baseline_top15`, `zscore_baseline_top30`, `hysteresis_hold_top15`, `hysteresis_hold_top25`
2. **Short-term reversal & skip-week momentum (4):** `short_term_rev_1d_top20`, `short_term_rev_5d_top20`, `intraday_fade_top20`, `mom60_skip5_top20`
3. **Risk-adjusted momentum & trend quality (4):** `vol_scaled_mom60_top20`, `vol_scaled_mom60_hyst_top20`, `consistent_trend_top20`, `pullback_in_uptrend_top20`
4. **Turnover-damped improvement (1):** `fastest_improving_damped_top20`
