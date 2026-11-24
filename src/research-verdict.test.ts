import assert from "node:assert/strict";
import test from "node:test";
import type { SeriesMetrics } from "./research-stats";
import type { StrategyEvaluation } from "./research-variants";
import { DEFAULT_VERDICT_THRESHOLDS, LIVE_PAPER_RUN_NOTE, verdictFor } from "./research-verdict";

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

const evaluation = (over: { exU?: number; exS?: number; positive?: number; folds?: number; adjustedP?: number }): StrategyEvaluation => {
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
  assert.deepEqual(DEFAULT_VERDICT_THRESHOLDS, { alpha: 0.05, minPositiveFoldShare: 0.5 });
  assert.equal(verdictFor(evaluation({ positive: 3, folds: 4 }), good, { alpha: 0.05, minPositiveFoldShare: 0.75 }).verdict, "NOT_PROVEN");
});
