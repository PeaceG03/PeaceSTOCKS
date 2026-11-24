import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppendOnlyLog } from "./append-only-log";
import type { HarnessSession } from "./research-costs";
import { walkForwardFolds } from "./research-folds";
import { holmAdjusted, incompleteBeta, oneSidedTest, tUpperP } from "./research-stats";
import { evaluateStrategy, foldPositive, type StrategyConfig, type VariantRecord } from "./research-variants";
import type { SeriesMetrics } from "./research-stats";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("t distribution: known one-sided tail values", () => {
  close(tUpperP(0, 10), 0.5);
  close(tUpperP(1.812461, 10), 0.05, 1e-5); // t_{0.95,10}
  close(tUpperP(2.0, 60), 0.025, 1e-3);
  close(tUpperP(-1.812461, 10), 0.95, 1e-5);
  close(tUpperP(1.644854, 1e7), 0.05, 1e-5); // ~normal
  close(incompleteBeta(0.5, 2, 3), 0.6875, 1e-12);
  assert.equal(oneSidedTest([0.1]).p, 1);
});

test("Holm: step-down, monotone, family size counts untested variants", () => {
  assert.deepEqual(holmAdjusted([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06]);
  assert.deepEqual(holmAdjusted([0.01], 5), [0.05]);
  assert.deepEqual(holmAdjusted([0.5, 0.001], 4), [1, 0.004]);
  assert.throws(() => holmAdjusted([0.1, 0.2], 1), /HOLM_FAMILY_TOO_SMALL/);
});

// 40 sessions; list GOOD always earns +1% with universe 0 and SPY 0; BAD earns -1%.
const sessions: HarnessSession[] = Array.from({ length: 40 }, (_, i) => ({
  sessionDate: `s${String(i).padStart(2, "0")}`,
  universeSize: 10,
  universeMean: 0,
  spy: 0,
  lists: {
    GOOD: { ids: ["a"], returns: [0.01 + (i % 2 ? 0.001 : -0.001)] },
    BAD: { ids: ["b"], returns: [-0.01 + (i % 2 ? 0.001 : -0.001)] },
  },
}));
const strategy = (name: string, lists: string[]): StrategyConfig => ({
  name,
  candidates: lists.map((list) => ({ kind: "scanner-list", list, scanner: "test" })),
  costs: { slippageBpsPerSide: 0 },
  folds: { trainSessions: 8, testSessions: 8, embargoSessions: 1, mode: "rolling" },
  outcome: "open-to-next-open",
  splits: "as-known",
});

test("variant evaluation: chooses on train only, logs every variant, counts them and corrects for them", () => {
  const log = new AppendOnlyLog<VariantRecord>(join(mkdtempSync(join(tmpdir(), "var-")), "variants.jsonl"));
  const folds = walkForwardFolds(40, strategy("x", ["GOOD"]).folds);
  const both = evaluateStrategy(sessions, folds, strategy("pick", ["BAD", "GOOD"]), log);
  assert.ok(both.record.folds.every((f) => f.chosen === both.record.candidateHashes[1]));
  assert.equal(both.variantsTried, 2);
  assert.equal(both.familySize, 2); // one strategy, but two variants were tried inside it
  assert.equal(both.foldsPositive, folds.length);
  const first = both.adjustedP;
  const again = evaluateStrategy(sessions, folds, strategy("bad-only", ["BAD"]), log);
  assert.equal(again.variantsTried, 2); // BAD was already tried inside "pick"
  assert.equal(again.familySize, 2);
  assert.equal(again.foldsPositive, 0);
  const topOne: StrategyConfig = { ...strategy("good-top1", []), candidates: [{ kind: "scanner-list", list: "GOOD", topN: 1, scanner: "test" }] };
  const third = evaluateStrategy(sessions, folds, topOne, log);
  assert.equal(third.variantsTried, 3);
  assert.equal(third.familySize, 3);
  assert.equal(log.entries().length, 3);
  // More variants tried -> the same evidence is worth less.
  const p = both.record.pooledP;
  assert.ok(first >= p * 2 - 1e-15);
  assert.ok(third.adjustedP >= third.record.pooledP * 3 - 1e-15 || third.adjustedP === 1);
  // Pooled = the test windows only, in order.
  assert.equal(both.daily.length, folds.reduce((s, f) => s + f.test.end - f.test.start + 1, 0));
  assert.equal(both.daily[0]!.sessionDate, sessions[folds[0]!.test.start]!.sessionDate);
});

test("pooled p is the LARGER of the two one-sided p-values: beating the universe alone is not enough", () => {
  // GOOD beats the universe every day, but SPY earns about as much: significant vs universe, not vs SPY.
  const spyClose: HarnessSession[] = sessions.map((x, i) => ({ ...x, spy: 0.01 + (i % 3 ? 0.004 : -0.008) }));
  const log = new AppendOnlyLog<VariantRecord>(join(mkdtempSync(join(tmpdir(), "var-")), "variants.jsonl"));
  const folds = walkForwardFolds(40, strategy("x", ["GOOD"]).folds);
  const r = evaluateStrategy(spyClose, folds, strategy("good", ["GOOD"]), log).record;
  const { p: pu } = r.pooled.excessUniverse;
  const { p: ps } = r.pooled.excessSpy;
  assert.ok(pu < 0.001 && ps > 0.05, `pu=${pu} ps=${ps}`);
  assert.equal(r.pooledP, Math.max(pu, ps));
  assert.equal(r.pooledP, ps);
});

test("a fold is positive only when it beats BOTH the universe and SPY", () => {
  const m = (u: number, s: number) => ({ excessUniverse: { sessions: 5, mean: u, t: 0, p: 0 }, excessSpy: { sessions: 5, mean: s, t: 0, p: 0 } }) as unknown as SeriesMetrics;
  assert.equal(foldPositive(m(0.001, 0.001)), true);
  assert.equal(foldPositive(m(0.001, -0.001)), false, "beats the universe, loses to SPY");
  assert.equal(foldPositive(m(-0.001, 0.001)), false, "beats SPY, loses to the universe");
  assert.equal(foldPositive(m(0.001, 0)), false);
});

test("F7: the evaluation carries the strategy's own cost per side, so a 0 bps library run fails the floor", async () => {
  const { verdictFor } = await import("./research-verdict");
  const folds = walkForwardFolds(40, strategy("x", ["GOOD"]).folds);
  for (const bps of [0, 7, 25]) {
    const dir = mkdtempSync(join(tmpdir(), "var-f7-"));
    const log = new AppendOnlyLog<VariantRecord>(join(dir, "variants.jsonl"));
    const s = { ...strategy(`cost-${bps}`, ["GOOD"]), costs: { slippageBpsPerSide: bps } };
    const evaluation = evaluateStrategy(sessions, folds, s, log);
    assert.equal(evaluation.costBpsPerSide, bps);
    const verdict = verdictFor(evaluation, undefined);
    assert.equal(verdict.reasons.some((r) => /COST_BELOW_FLOOR/u.test(r)), bps < 5, `bps=${bps}`);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maxDrawdown and seriesMetrics compute compounded peak-to-trough drawdown for net and SPY", async () => {
  const { maxDrawdown, seriesMetrics } = await import("./research-stats");
  assert.equal(maxDrawdown([]), 0);
  assert.equal(maxDrawdown([0.05, 0.02, 0.01]), 0);
  // 1.0 -> 1.10 -> 0.99 (dd = 0.11 / 1.10 = 0.10) -> 1.089 -> 0.8712 (peak 1.10, dd = (1.10 - 0.8712)/1.10 = 0.208)
  close(maxDrawdown([0.1, -0.1, 0.1, -0.2]), 0.208, 1e-12);
  const daily = [
    { sessionDate: "d1", holdings: 1, gross: 0.1, turnover: 0, cost: 0, net: 0.1, universe: 0, spy: 0.05 },
    { sessionDate: "d2", holdings: 1, gross: -0.1, turnover: 0, cost: 0, net: -0.1, universe: 0, spy: -0.04 },
    { sessionDate: "d3", holdings: 1, gross: -0.1, turnover: 0, cost: 0, net: -0.1, universe: 0, spy: 0.02 },
  ];
  const m = seriesMetrics(daily);
  // net: 1 -> 1.1 -> 0.99 -> 0.891 => dd = (1.1 - 0.891)/1.1 = 0.19
  close(m.maxDrawdownNet, 0.19, 1e-12);
  // spy: 1 -> 1.05 -> 1.008 -> 1.02816 => dd = 0.04
  close(m.maxDrawdownSpy!, 0.04, 1e-12);
});

test("holmFamily counts pre-registered unrun ideas via m = max(run variants, strategies, preregisteredCount)", async () => {
  const { holmFamily } = await import("./research-variants");
  const dir = mkdtempSync(join(tmpdir(), "holm-prereg-"));
  try {
    const log = new AppendOnlyLog<VariantRecord>(join(dir, "variants.jsonl"));
    const folds = walkForwardFolds(40, strategy("x", ["GOOD"]).folds);
    const ev = evaluateStrategy(sessions, folds, strategy("good", ["GOOD"]), log);
    const fam = holmFamily(log.entries(), 16);
    assert.equal(fam.variantsTried, 1);
    assert.equal(fam.familySize, 16);
    const expectedP = Math.min(1, ev.record.pooledP * 16);
    close(fam.adjustedP(ev.record.strategyHash), expectedP, 1e-12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
