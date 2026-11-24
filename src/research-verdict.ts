/**
 * The research harness verdict. A strategy is an IMPROVEMENT only if ALL of these hold:
 *  1. pooled test-fold net return (after costs) beats the equal-weight universe AND SPY (mean > 0);
 *  2. every walk-forward fold is positive (100% of folds beat BOTH the equal-weight universe and SPY);
 *  3. the pooled result is significant after the multiple-testing correction: the Holm-adjusted
 *     p-value over every variant in the log is below alpha (0.05);
 *  4. pooled net max drawdown is at most 15% (0.15) AND at most 1.25x SPY's max drawdown;
 *  5. the held-out period was evaluated (once, through the seal) and its net beats both benchmarks;
 *  6. at least minFolds (3) walk-forward folds were scored. With one or two folds consistency is
 *     untested; three is the smallest count where every-fold consistency tests across distinct windows;
 *  7. costs were charged at no less than minCostBpsPerSide (5 bps per side). A smaller slippage
 *     assumption is unrealistic for these names and would let turnover look free.
 * Anything else is NOT_PROVEN. Either way the verdict says that a live paper run is still required:
 * the harness can only reject or shortlist a strategy, never approve it for money.
 */
import type { SeriesMetrics } from "./research-stats";
import type { StrategyEvaluation } from "./research-variants";

export interface VerdictThresholds {
  alpha: number;
  /** Folds positive must be at least this share (default 1 = 100% of folds). */
  minPositiveFoldShare: number;
  /** Fewer scored folds than this is never an IMPROVEMENT. */
  minFolds: number;
  /** Cost floor: slippage below this many bps per side is never an IMPROVEMENT. */
  minCostBpsPerSide: number;
  /** Maximum pooled net drawdown (0..1; default 0.15 = 15%). */
  maxDrawdownNet: number;
  /** Maximum pooled net drawdown relative to SPY drawdown (default 1.25). */
  maxDrawdownSpyMultiple: number;
}

export const MIN_FOLDS = 3;
export const MIN_COST_BPS_PER_SIDE = 5;
export const MAX_DRAWDOWN_NET = 0.15;
export const MAX_DRAWDOWN_SPY_MULTIPLE = 1.25;
export const COST_BELOW_FLOOR = "COST_BELOW_FLOOR";
export const DEFAULT_VERDICT_THRESHOLDS: VerdictThresholds = {
  alpha: 0.05,
  minPositiveFoldShare: 1,
  minFolds: MIN_FOLDS,
  minCostBpsPerSide: MIN_COST_BPS_PER_SIDE,
  maxDrawdownNet: MAX_DRAWDOWN_NET,
  maxDrawdownSpyMultiple: MAX_DRAWDOWN_SPY_MULTIPLE,
};

/** Refuses a slippage assumption below the floor (or not a finite number). */
export function assertCostFloor(bps: number, floor = MIN_COST_BPS_PER_SIDE): number {
  if (!(Number.isFinite(bps) && bps >= floor)) throw new Error(`${COST_BELOW_FLOOR}:min-${floor}-bps-per-side`);
  return bps;
}

/**
 * Caller thresholds can only TIGHTEN the defaults: alpha and drawdown caps no higher, fold share,
 * fold count and cost floor no lower. A value that is not a finite number falls back to the default.
 */
export function clampThresholds(given: VerdictThresholds): VerdictThresholds {
  const d = DEFAULT_VERDICT_THRESHOLDS;
  const or = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
  return {
    alpha: Math.min(or(given.alpha, d.alpha), d.alpha),
    minPositiveFoldShare: Math.max(or(given.minPositiveFoldShare, d.minPositiveFoldShare), d.minPositiveFoldShare),
    minFolds: Math.max(or(given.minFolds, d.minFolds), d.minFolds),
    minCostBpsPerSide: Math.max(or(given.minCostBpsPerSide, d.minCostBpsPerSide), d.minCostBpsPerSide),
    maxDrawdownNet: Math.min(or(given.maxDrawdownNet, d.maxDrawdownNet), d.maxDrawdownNet),
    maxDrawdownSpyMultiple: Math.min(or(given.maxDrawdownSpyMultiple, d.maxDrawdownSpyMultiple), d.maxDrawdownSpyMultiple),
  };
}

export const LIVE_PAPER_RUN_NOTE =
  "A live paper run of this exact configuration is still required; no harness result alone can move it to real money, and real money needs Peace's own yes.";

export interface Verdict {
  verdict: "IMPROVEMENT" | "NOT_PROVEN";
  reasons: string[];
  checks: {
    beatsUniverseAfterCosts: boolean;
    beatsSpyAfterCosts: boolean;
    foldsPositive: string;
    allFoldsPositive: boolean;
    enoughFolds: boolean;
    costBpsPerSide: number;
    costAtOrAboveFloor: boolean;
    adjustedP: number;
    significantAfterCorrection: boolean;
    maxDrawdownNet: number | null;
    maxDrawdownSpy: number | null;
    drawdownWithinLimit: boolean;
    variantsTried: number;
    heldOut: "NOT_EVALUATED" | "POSITIVE" | "NOT_POSITIVE";
  };
  note: string;
}

export function verdictFor(
  evaluation: StrategyEvaluation,
  heldOut: SeriesMetrics | undefined,
  given: VerdictThresholds = DEFAULT_VERDICT_THRESHOLDS,
): Verdict {
  const thresholds = clampThresholds(given);
  const pooled = evaluation.record.pooled;
  const folds = evaluation.record.folds.length;
  const beatsUniverseAfterCosts = pooled.excessUniverse.mean > 0;
  const beatsSpyAfterCosts = pooled.excessSpy.sessions > 0 && pooled.excessSpy.mean > 0;
  const everyFoldBeatsBoth =
    evaluation.record.folds.length === folds &&
    evaluation.record.folds.every(
      (f) => f.positive && f.test.excessUniverse.mean > 0 && f.test.excessSpy.sessions > 0 && f.test.excessSpy.mean > 0,
    );
  const allFoldsPositive = folds > 0 && evaluation.foldsPositive / folds >= thresholds.minPositiveFoldShare && everyFoldBeatsBoth;
  const enoughFolds = folds >= thresholds.minFolds;
  const costAtOrAboveFloor = Number.isFinite(evaluation.costBpsPerSide) && evaluation.costBpsPerSide >= thresholds.minCostBpsPerSide;
  const significantAfterCorrection = evaluation.adjustedP < thresholds.alpha;
  const ddNet = Number.isFinite(pooled.maxDrawdownNet) ? pooled.maxDrawdownNet : null;
  const ddSpy = pooled.maxDrawdownSpy !== null && pooled.maxDrawdownSpy !== undefined && Number.isFinite(pooled.maxDrawdownSpy)
    ? pooled.maxDrawdownSpy
    : null;
  const drawdownWithinAbsCap = ddNet !== null && ddNet <= thresholds.maxDrawdownNet;
  const drawdownWithinSpyCap = ddNet !== null && ddSpy !== null && ddNet <= ddSpy * thresholds.maxDrawdownSpyMultiple;
  const drawdownWithinLimit = drawdownWithinAbsCap && drawdownWithinSpyCap;
  const heldOutState: Verdict["checks"]["heldOut"] = !heldOut
    ? "NOT_EVALUATED"
    : heldOut.excessUniverse.mean > 0 && heldOut.excessSpy.sessions > 0 && heldOut.excessSpy.mean > 0
      ? "POSITIVE"
      : "NOT_POSITIVE";
  const reasons: string[] = [];
  if (!beatsUniverseAfterCosts) reasons.push("DOES_NOT_BEAT_EQUAL_WEIGHT_AFTER_COSTS");
  if (!beatsSpyAfterCosts) reasons.push("DOES_NOT_BEAT_SPY_AFTER_COSTS");
  if (!allFoldsPositive) reasons.push("NOT_POSITIVE_IN_EVERY_FOLD");
  if (!enoughFolds) reasons.push("TOO_FEW_FOLDS");
  if (!costAtOrAboveFloor) reasons.push(COST_BELOW_FLOOR);
  if (!significantAfterCorrection) reasons.push("NOT_SIGNIFICANT_AFTER_CORRECTION");
  if (!drawdownWithinAbsCap) reasons.push("DRAWDOWN_EXCEEDS_LIMIT");
  if (!drawdownWithinSpyCap) reasons.push("DRAWDOWN_EXCEEDS_SPY_MULTIPLE");
  if (heldOutState === "NOT_EVALUATED") reasons.push("HELD_OUT_NOT_EVALUATED");
  if (heldOutState === "NOT_POSITIVE") reasons.push("HELD_OUT_NOT_POSITIVE");
  return {
    verdict: reasons.length ? "NOT_PROVEN" : "IMPROVEMENT",
    reasons,
    checks: {
      beatsUniverseAfterCosts,
      beatsSpyAfterCosts,
      foldsPositive: `${evaluation.foldsPositive}/${folds}`,
      allFoldsPositive,
      enoughFolds,
      costBpsPerSide: evaluation.costBpsPerSide,
      costAtOrAboveFloor,
      adjustedP: evaluation.adjustedP,
      significantAfterCorrection,
      maxDrawdownNet: ddNet,
      maxDrawdownSpy: ddSpy,
      drawdownWithinLimit,
      variantsTried: evaluation.variantsTried,
      heldOut: heldOutState,
    },
    note: LIVE_PAPER_RUN_NOTE,
  };
}
