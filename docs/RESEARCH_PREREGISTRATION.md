# Phase 2 Pre-Registered Scoring Candidates (`research-preregistration-v1`)

Machine-readable specification: `config/research-preregistration-v1.json` (16 candidates, **all `NOT_RUN`**).

## Ground Rules & Contamination Guard
- **Development window:** `2025-03-03..2026-08-26` (5 rolling folds, 63 train / 63 test / 2 embargo, 307 pooled test sessions).
- **Held-out window:** `2026-08-27..2026-11-20` (61 sessions; 60 scorable exits up to `2026-11-23`).
- **Contamination disclosure:** `2026-08-27..2026-11-20` was previously evaluated in `#124`, and `2026-08-27..2026-11-19` was peeked in the `#127` paper-trading replay (`-0.558%/day` gross on `TOP_15_OVERALL`, `-13.7%` universe). None of these 16 candidates was designed or tuned around that peek, no held-out bars `>= 2026-08-27` may be read during development, and Auditor will verify anti-peek compliance before any single `HeldOutSeal.evaluateOnce` run.
- **Side-by-side only:** `DEFAULT_SCANNER_CONFIG`, `TOP_15_OVERALL`, and `config/paper-rules-v5.json` remain untouched for the live paper trial.
- **Pass bar (`src/research-verdict.ts`):** 100% positive folds (`5/5`) vs **both** equal-weight universe and SPY after `>= 10 bps`/side costs, Holm-adjusted `p < 0.05` across all tried variants (10 baseline + 16 candidates = 26), pooled net max drawdown `<= 15%` and `<= 1.25x` SPY drawdown, plus one-time held-out pass, short operational live-paper confirmation, and tiny initial live capital (`<= $100`).

## Pre-Registered Families (16 Ideas <= 20 Cap)
1. **Outlier-resistant normalization & turnover damping (4):** `zscore_baseline_top15`, `zscore_baseline_top30`, `hysteresis_hold_top15`, `hysteresis_hold_top25`
2. **Short-term reversal & skip-week momentum (4):** `short_term_rev_1d_top20`, `short_term_rev_5d_top20`, `intraday_fade_top20`, `mom60_skip5_top20`
3. **Risk-adjusted momentum & trend quality (4):** `vol_scaled_mom60_top20`, `vol_scaled_mom60_hyst_top20`, `consistent_trend_top20`, `pullback_in_uptrend_top20`
4. **Defensive quality & turnover-damped improvement (2):** `low_vol_mom_quality_top30`, `fastest_improving_damped_top20`
5. **Point-in-time (`<= D`) market-regime conditioning (2):** `regime_vol_scaled_mom_top20`, `regime_rev_vs_mom_top20`
