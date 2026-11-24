import assert from "node:assert/strict";
import test from "node:test";
import type { SeriesMetrics } from "./research-stats";
import type { StrategyEvaluation } from "./research-variants";
import { clampThresholds, DEFAULT_VERDICT_THRESHOLDS, LIVE_PAPER_RUN_NOTE, verdictFor } from "./research-verdict";

const metrics = (exU: number, exS: number, spySessions = 50): SeriesMetrics => ({
  sessions: 50,
  meanGross: 0,
  meanNet: 0,
  meanCost: 0,
  meanTurnover: 0,
  meanUniverse: 0,
  meanSpy: 0,
  excessUniverse: { sessions: 50, mean: exU, t: 0, p: 0 },
  excessSpy: { sessions: spySessions, mean: exS, t: 0, p: 0 },
  sharpeNet: 0,
});

const evaluation = (over: { exU?: number; exS?: number; positive?: number; folds?: number; adjustedP?: number; bps?: number }): StrategyEvaluation => {
  const folds = over.folds ?? 4;
  return {
    record: {
      strategyHash: "h",
      name: "n",
      candidateHashes: ["c"],
      folds: Array.from({ length: folds }, (_, index) => ({ index, train: { from: "a", to: "b" }, testWindow: { from: "c", to: "d" }, chosen: "c", trainScore: 0, test: metrics(0, 0), positive: index < (over.positive ?? 3) })),
      pooled: metrics(over.exU ?? 0.001, over.exS ?? 0.001),
      pooledP: 0.001,
    },
    daily: [],
    variantsTried: 5,
    familySize: 5,
    adjustedP: over.adjustedP ?? 0.01,
    foldsPositive: over.positive ?? 3,
    costBpsPerSide: over.bps ?? 10,
  };
};

const good = metrics(0.001, 0.001);

test("IMPROVEMENT only when every check holds, and it still requires a live paper run", () => {
  const v = verdictFor(evaluation({}), good);
  assert.equal(v.verdict, "IMPROVEMENT");
  assert.deepEqual(v.reasons, []);
  assert.equal(v.note, LIVE_PAPER_RUN_NOTE);
  assert.match(v.note, /live paper run/);
  assert.equal(v.checks.variantsTried, 5);
});

test("each failed check alone makes it NOT_PROVEN, with its reason", () => {
  const cases: Array<[Parameters<typeof evaluation>[0], SeriesMetrics | undefined, string]> = [
    [{ exU: 0 }, good, "DOES_NOT_BEAT_EQUAL_WEIGHT_AFTER_COSTS"],
    [{ exU: -1e-9 }, good, "DOES_NOT_BEAT_EQUAL_WEIGHT_AFTER_COSTS"],
    [{ exS: 0 }, good, "DOES_NOT_BEAT_SPY_AFTER_COSTS"],
    [{ positive: 2, folds: 4 }, good, "NOT_POSITIVE_IN_MOST_FOLDS"], // exactly half is not most
    [{ positive: 0, folds: 0 }, good, "NOT_POSITIVE_IN_MOST_FOLDS"],
    [{ adjustedP: 0.05 }, good, "NOT_SIGNIFICANT_AFTER_CORRECTION"],
    [{}, undefined, "HELD_OUT_NOT_EVALUATED"],
    [{}, metrics(0.001, 0), "HELD_OUT_NOT_POSITIVE"],
    [{}, metrics(0, 0.001), "HELD_OUT_NOT_POSITIVE"],
    [{}, metrics(0.001, 0.001, 0), "HELD_OUT_NOT_POSITIVE"],
  ];
  for (const [over, heldOut, reason] of cases) {
    const v = verdictFor(evaluation(over), heldOut);
    assert.equal(v.verdict, "NOT_PROVEN", reason);
    assert.ok(v.reasons.includes(reason), `${reason} in ${v.reasons.join(",")}`);
    assert.equal(v.note, LIVE_PAPER_RUN_NOTE);
  }
  // Just inside each threshold passes.
  assert.equal(verdictFor(evaluation({ positive: 3, folds: 5, adjustedP: 0.0499 }), good).verdict, "IMPROVEMENT");
  assert.deepEqual(DEFAULT_VERDICT_THRESHOLDS, { alpha: 0.05, minPositiveFoldShare: 0.5, minFolds: 3, minCostBpsPerSide: 5 });
  assert.equal(verdictFor(evaluation({ positive: 3, folds: 4 }), good, { ...DEFAULT_VERDICT_THRESHOLDS, minPositiveFoldShare: 0.75 }).verdict, "NOT_PROVEN");
});

test("too few folds: one or two folds plus a positive held-out never give IMPROVEMENT; three can", () => {
  for (const folds of [0, 1, 2]) {
    const v = verdictFor(evaluation({ positive: folds, folds }), good);
    assert.equal(v.verdict, "NOT_PROVEN", `${folds} folds`);
    assert.ok(v.reasons.includes("TOO_FEW_FOLDS"), v.reasons.join(","));
  }
  const three = verdictFor(evaluation({ positive: 3, folds: 3 }), good);
  assert.equal(three.verdict, "IMPROVEMENT");
  assert.equal(three.checks.enoughFolds, true);
});

test("cost floor: below 5 bps per side is NOT_PROVEN (COST_BELOW_FLOOR); 5 bps is accepted", () => {
  for (const bps of [0, 4.99, Number.NaN]) {
    const v = verdictFor(evaluation({ bps }), good);
    assert.equal(v.verdict, "NOT_PROVEN", String(bps));
    assert.ok(v.reasons.includes("COST_BELOW_FLOOR"), v.reasons.join(","));
  }
  assert.equal(verdictFor(evaluation({ bps: 5 }), good).verdict, "IMPROVEMENT");
});

test("caller thresholds can only tighten the defaults: a library caller cannot lower the bar", () => {
  const loose = [
    { minFolds: 1 }, { minCostBpsPerSide: 0 }, { alpha: 0.5 }, { minPositiveFoldShare: 0 },
    { minFolds: Number.NaN }, { minCostBpsPerSide: Number.NEGATIVE_INFINITY }, { alpha: Number.POSITIVE_INFINITY }, { minPositiveFoldShare: Number.NaN },
  ];
  const failing: Array<[Parameters<typeof evaluation>[0], string]> = [
    [{ positive: 1, folds: 1 }, "TOO_FEW_FOLDS"],
    [{ bps: 0 }, "COST_BELOW_FLOOR"],
    [{ adjustedP: 0.2 }, "NOT_SIGNIFICANT_AFTER_CORRECTION"],
    [{ positive: 2, folds: 4 }, "NOT_POSITIVE_IN_MOST_FOLDS"],
  ];
  for (const over of loose) {
    const thresholds = { ...DEFAULT_VERDICT_THRESHOLDS, ...over };
    for (const [ev, reason] of failing) {
      const v = verdictFor(evaluation(ev), good, thresholds);
      assert.equal(v.verdict, "NOT_PROVEN", `${JSON.stringify(over)} ${reason}`);
      assert.ok(v.reasons.includes(reason), `${JSON.stringify(over)} ${reason}`);
    }
  }
  // The combined bypass from the review: one fold at zero cost.
  const bypass = verdictFor(evaluation({ positive: 1, folds: 1, bps: 0 }), good, { ...DEFAULT_VERDICT_THRESHOLDS, minFolds: 1, minCostBpsPerSide: 0 });
  assert.equal(bypass.verdict, "NOT_PROVEN");
  // Stricter thresholds still apply.
  assert.equal(verdictFor(evaluation({ positive: 3, folds: 3 }), good, { ...DEFAULT_VERDICT_THRESHOLDS, minFolds: 4 }).verdict, "NOT_PROVEN");
  assert.equal(verdictFor(evaluation({ bps: 8 }), good, { ...DEFAULT_VERDICT_THRESHOLDS, minCostBpsPerSide: 9 }).verdict, "NOT_PROVEN");
  assert.equal(verdictFor(evaluation({ adjustedP: 0.02 }), good, { ...DEFAULT_VERDICT_THRESHOLDS, alpha: 0.01 }).verdict, "NOT_PROVEN");
  assert.equal(verdictFor(evaluation({}), good, { ...DEFAULT_VERDICT_THRESHOLDS }).verdict, "IMPROVEMENT");
});

test("a non-finite caller threshold means the default (not a check that can never pass)", () => {
  const nan = { alpha: Number.NaN, minPositiveFoldShare: Number.NaN, minFolds: Number.NaN, minCostBpsPerSide: Number.NaN };
  const v = verdictFor(evaluation({}), good, nan);
  assert.equal(v.verdict, "IMPROVEMENT", JSON.stringify(v.reasons));
  assert.deepEqual(clampThresholds(nan), DEFAULT_VERDICT_THRESHOLDS);
});
