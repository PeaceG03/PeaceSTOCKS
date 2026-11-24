import assert from "node:assert/strict";
import test from "node:test";
import type { SeriesMetrics } from "./research-stats";
import type { StrategyEvaluation } from "./research-variants";
import { clampThresholds, DEFAULT_VERDICT_THRESHOLDS, LIVE_PAPER_RUN_NOTE, verdictFor } from "./research-verdict";

const metrics = (exU: number, exS: number, spySessions = 50, ddNet = 0.05, ddSpy: number | null = 0.06): SeriesMetrics => ({
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
  maxDrawdownNet: ddNet,
  maxDrawdownSpy: ddSpy,
});

const evaluation = (over: {
  exU?: number;
  exS?: number;
  positive?: number;
  folds?: number;
  adjustedP?: number;
  bps?: number;
  ddNet?: number;
  ddSpy?: number | null;
  foldMetrics?: Array<{ exU: number; exS: number; spySessions?: number; positive?: boolean }>;
}): StrategyEvaluation => {
  const folds = over.folds ?? 4;
  const positiveCount = over.positive ?? folds;
  return {
    record: {
      strategyHash: "h",
      name: "n",
      candidateHashes: ["c"],
      folds: Array.from({ length: folds }, (_, index) => {
        const fm = over.foldMetrics?.[index];
        const isPos = fm?.positive ?? index < positiveCount;
        const m = fm
          ? metrics(fm.exU, fm.exS, fm.spySessions ?? 50)
          : isPos
            ? metrics(0.001, 0.001)
            : metrics(-0.001, -0.001);
        return {
          index,
          train: { from: "a", to: "b" },
          testWindow: { from: "c", to: "d" },
          chosen: "c",
          trainScore: 0,
          test: m,
          positive: isPos,
        };
      }),
      pooled: metrics(over.exU ?? 0.001, over.exS ?? 0.001, 50, over.ddNet ?? 0.05, over.ddSpy === undefined ? 0.06 : over.ddSpy),
      pooledP: 0.001,
    },
    daily: [],
    variantsTried: 5,
    familySize: 5,
    adjustedP: over.adjustedP ?? 0.01,
    foldsPositive: positiveCount,
    costBpsPerSide: over.bps ?? 10,
  };
};

const good = metrics(0.001, 0.001);

test("IMPROVEMENT only when every check holds (including 100% positive folds), and it still requires a live paper run", () => {
  const v = verdictFor(evaluation({}), good);
  assert.equal(v.verdict, "IMPROVEMENT");
  assert.deepEqual(v.reasons, []);
  assert.equal(v.note, LIVE_PAPER_RUN_NOTE);
  assert.match(v.note, /live paper run/);
  assert.equal(v.checks.variantsTried, 5);
  assert.equal(v.checks.allFoldsPositive, true);
});

test("each failed check alone makes it NOT_PROVEN, with its reason", () => {
  const cases: Array<[Parameters<typeof evaluation>[0], SeriesMetrics | undefined, string]> = [
    [{ exU: 0 }, good, "DOES_NOT_BEAT_EQUAL_WEIGHT_AFTER_COSTS"],
    [{ exU: -1e-9 }, good, "DOES_NOT_BEAT_EQUAL_WEIGHT_AFTER_COSTS"],
    [{ exS: 0 }, good, "DOES_NOT_BEAT_SPY_AFTER_COSTS"],
    [{ positive: 3, folds: 4 }, good, "NOT_POSITIVE_IN_EVERY_FOLD"],
    [{ positive: 4, folds: 5 }, good, "NOT_POSITIVE_IN_EVERY_FOLD"],
    [{ positive: 0, folds: 0 }, good, "NOT_POSITIVE_IN_EVERY_FOLD"],
    [
      {
        folds: 3,
        positive: 3,
        foldMetrics: [
          { exU: 0.001, exS: 0.001, positive: true },
          { exU: 0.001, exS: -0.0001, positive: true },
          { exU: 0.001, exS: 0.001, positive: true },
        ],
      },
      good,
      "NOT_POSITIVE_IN_EVERY_FOLD",
    ],
    [
      {
        folds: 3,
        positive: 3,
        foldMetrics: [
          { exU: 0.001, exS: 0.001, positive: true },
          { exU: -0.0001, exS: 0.001, positive: true },
          { exU: 0.001, exS: 0.001, positive: true },
        ],
      },
      good,
      "NOT_POSITIVE_IN_EVERY_FOLD",
    ],
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
  assert.equal(verdictFor(evaluation({ positive: 5, folds: 5, adjustedP: 0.0499 }), good).verdict, "IMPROVEMENT");
  assert.deepEqual(DEFAULT_VERDICT_THRESHOLDS, { alpha: 0.05, minPositiveFoldShare: 1, minFolds: 3, minCostBpsPerSide: 5, maxDrawdownNet: 0.15, maxDrawdownSpyMultiple: 1.25 });
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
    { minFolds: 1 }, { minCostBpsPerSide: 0 }, { alpha: 0.5 }, { minPositiveFoldShare: 0 }, { minPositiveFoldShare: 0.5 },
    { minFolds: Number.NaN }, { minCostBpsPerSide: Number.NEGATIVE_INFINITY }, { alpha: Number.POSITIVE_INFINITY }, { minPositiveFoldShare: Number.NaN },
  ];
  const failing: Array<[Parameters<typeof evaluation>[0], string]> = [
    [{ positive: 1, folds: 1 }, "TOO_FEW_FOLDS"],
    [{ bps: 0 }, "COST_BELOW_FLOOR"],
    [{ adjustedP: 0.2 }, "NOT_SIGNIFICANT_AFTER_CORRECTION"],
    [{ positive: 3, folds: 4 }, "NOT_POSITIVE_IN_EVERY_FOLD"],
  ];
  for (const over of loose) {
    const thresholds = { ...DEFAULT_VERDICT_THRESHOLDS, ...over };
    for (const [ev, reason] of failing) {
      const v = verdictFor(evaluation(ev), good, thresholds);
      assert.equal(v.verdict, "NOT_PROVEN", `${JSON.stringify(over)} ${reason}`);
      assert.ok(v.reasons.includes(reason), `${JSON.stringify(over)} ${reason}`);
    }
  }
  const bypass = verdictFor(evaluation({ positive: 1, folds: 1, bps: 0 }), good, { ...DEFAULT_VERDICT_THRESHOLDS, minFolds: 1, minCostBpsPerSide: 0 });
  assert.equal(bypass.verdict, "NOT_PROVEN");
  assert.equal(verdictFor(evaluation({ positive: 3, folds: 3 }), good, { ...DEFAULT_VERDICT_THRESHOLDS, minFolds: 4 }).verdict, "NOT_PROVEN");
  assert.equal(verdictFor(evaluation({ bps: 8 }), good, { ...DEFAULT_VERDICT_THRESHOLDS, minCostBpsPerSide: 9 }).verdict, "NOT_PROVEN");
  assert.equal(verdictFor(evaluation({ adjustedP: 0.02 }), good, { ...DEFAULT_VERDICT_THRESHOLDS, alpha: 0.01 }).verdict, "NOT_PROVEN");
  assert.equal(verdictFor(evaluation({}), good, { ...DEFAULT_VERDICT_THRESHOLDS }).verdict, "IMPROVEMENT");
});

test("a non-finite caller threshold means the default (not a check that can never pass)", () => {
  const nan = { alpha: Number.NaN, minPositiveFoldShare: Number.NaN, minFolds: Number.NaN, minCostBpsPerSide: Number.NaN, maxDrawdownNet: Number.NaN, maxDrawdownSpyMultiple: Number.NaN };
  const v = verdictFor(evaluation({}), good, nan);
  assert.equal(v.verdict, "IMPROVEMENT", JSON.stringify(v.reasons));
  assert.deepEqual(clampThresholds(nan), DEFAULT_VERDICT_THRESHOLDS);
});

test("drawdown limits: pooled net drawdown > 15% or > 1.25x SPY drawdown is NOT_PROVEN", () => {
  assert.equal(verdictFor(evaluation({ ddNet: 0.15, ddSpy: 0.12 }), good).verdict, "IMPROVEMENT");

  const overAbs = verdictFor(evaluation({ ddNet: 0.1501, ddSpy: 0.20 }), good);
  assert.equal(overAbs.verdict, "NOT_PROVEN");
  assert.ok(overAbs.reasons.includes("DRAWDOWN_EXCEEDS_LIMIT"), overAbs.reasons.join(","));

  const overSpy = verdictFor(evaluation({ ddNet: 0.0751, ddSpy: 0.06 }), good);
  assert.equal(overSpy.verdict, "NOT_PROVEN");
  assert.ok(overSpy.reasons.includes("DRAWDOWN_EXCEEDS_SPY_MULTIPLE"), overSpy.reasons.join(","));

  const noSpyDd = verdictFor(evaluation({ ddNet: 0.05, ddSpy: null }), good);
  assert.equal(noSpyDd.verdict, "NOT_PROVEN");
  assert.ok(noSpyDd.reasons.includes("DRAWDOWN_EXCEEDS_SPY_MULTIPLE"), noSpyDd.reasons.join(","));

  // Looser drawdown thresholds passed by a caller are clamped back down to defaults.
  const looseDd = verdictFor(
    evaluation({ ddNet: 0.16, ddSpy: 0.08 }),
    good,
    { ...DEFAULT_VERDICT_THRESHOLDS, maxDrawdownNet: 0.5, maxDrawdownSpyMultiple: 3 },
  );
  assert.equal(looseDd.verdict, "NOT_PROVEN");
  assert.ok(looseDd.reasons.includes("DRAWDOWN_EXCEEDS_LIMIT"));
  assert.ok(looseDd.reasons.includes("DRAWDOWN_EXCEEDS_SPY_MULTIPLE"));
});
