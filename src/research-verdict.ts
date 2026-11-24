/**
 * The research harness verdict. A strategy is an IMPROVEMENT only if ALL of these hold:
 *  1. pooled test-fold net return (after costs) beats the equal-weight universe AND SPY (mean > 0);
 *  2. more than half of the folds are positive (net beats both on that fold's test window);
 *  3. the pooled result is significant after the multiple-testing correction: the Holm-adjusted
 *     p-value over every variant in the log is below alpha (0.05);
 *  4. the held-out period was evaluated (once, through the seal) and its net beats both benchmarks.
 * Anything else is NOT_PROVEN. Either way the verdict says that a live paper run is still required:
 * the harness can only reject or shortlist a strategy, never approve it for money.
 */
import type { SeriesMetrics } from "./research-stats";
import type { StrategyEvaluation } from "./research-variants";

export interface VerdictThresholds {
  alpha: number;
  /** Folds positive must be MORE than this share. */
  minPositiveFoldShare: number;
}

export const DEFAULT_VERDICT_THRESHOLDS: VerdictThresholds = { alpha: 0.05, minPositiveFoldShare: 0.5 };

export const LIVE_PAPER_RUN_NOTE =
  "A live paper run of this exact configuration is still required; no harness result alone can move it to real money, and real money needs Peace's own yes.";

export interface Verdict {
  verdict: "IMPROVEMENT" | "NOT_PROVEN";
  reasons: string[];
  checks: {
    beatsUniverseAfterCosts: boolean;
    beatsSpyAfterCosts: boolean;
    foldsPositive: string;
    mostFoldsPositive: boolean;
    adjustedP: number;
    significantAfterCorrection: boolean;
    variantsTried: number;
    heldOut: "NOT_EVALUATED" | "POSITIVE" | "NOT_POSITIVE";
  };
  note: string;
}

export function verdictFor(
  evaluation: StrategyEvaluation,
  heldOut: SeriesMetrics | undefined,
  thresholds: VerdictThresholds = DEFAULT_VERDICT_THRESHOLDS,
): Verdict {
  const pooled = evaluation.record.pooled;
  const folds = evaluation.record.folds.length;
  const beatsUniverseAfterCosts = pooled.excessUniverse.mean > 0;
  const beatsSpyAfterCosts = pooled.excessSpy.sessions > 0 && pooled.excessSpy.mean > 0;
  const mostFoldsPositive = folds > 0 && evaluation.foldsPositive / folds > thresholds.minPositiveFoldShare;
  const significantAfterCorrection = evaluation.adjustedP < thresholds.alpha;
  const heldOutState: Verdict["checks"]["heldOut"] = !heldOut
    ? "NOT_EVALUATED"
    : heldOut.excessUniverse.mean > 0 && heldOut.excessSpy.sessions > 0 && heldOut.excessSpy.mean > 0
      ? "POSITIVE"
      : "NOT_POSITIVE";
  const reasons: string[] = [];
  if (!beatsUniverseAfterCosts) reasons.push("DOES_NOT_BEAT_EQUAL_WEIGHT_AFTER_COSTS");
  if (!beatsSpyAfterCosts) reasons.push("DOES_NOT_BEAT_SPY_AFTER_COSTS");
  if (!mostFoldsPositive) reasons.push("NOT_POSITIVE_IN_MOST_FOLDS");
  if (!significantAfterCorrection) reasons.push("NOT_SIGNIFICANT_AFTER_CORRECTION");
  if (heldOutState === "NOT_EVALUATED") reasons.push("HELD_OUT_NOT_EVALUATED");
  if (heldOutState === "NOT_POSITIVE") reasons.push("HELD_OUT_NOT_POSITIVE");
  return {
    verdict: reasons.length ? "NOT_PROVEN" : "IMPROVEMENT",
    reasons,
    checks: {
      beatsUniverseAfterCosts,
      beatsSpyAfterCosts,
      foldsPositive: `${evaluation.foldsPositive}/${folds}`,
      mostFoldsPositive,
      adjustedP: evaluation.adjustedP,
      significantAfterCorrection,
      variantsTried: evaluation.variantsTried,
      heldOut: heldOutState,
    },
    note: LIVE_PAPER_RUN_NOTE,
  };
}
