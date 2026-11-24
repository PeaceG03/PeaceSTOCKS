import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppendOnlyLog } from "./append-only-log";
import type { HarnessSession } from "./research-costs";
import { walkForwardFolds } from "./research-folds";
import { holmAdjusted, incompleteBeta, oneSidedTest, tUpperP } from "./research-stats";
import { evaluateStrategy, type StrategyConfig, type VariantRecord } from "./research-variants";

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
  assert.equal(both.foldsPositive, folds.length);
  const first = both.adjustedP;
  const again = evaluateStrategy(sessions, folds, strategy("bad-only", ["BAD"]), log);
  assert.equal(again.variantsTried, 2); // BAD was already tried inside "pick"
  assert.equal(again.foldsPositive, 0);
  const topOne: StrategyConfig = { ...strategy("good-top1", []), candidates: [{ kind: "scanner-list", list: "GOOD", topN: 1, scanner: "test" }] };
  const third = evaluateStrategy(sessions, folds, topOne, log);
  assert.equal(third.variantsTried, 3);
  assert.equal(log.entries().length, 3);
  // More variants tried -> the same evidence is worth less.
  const p = both.record.pooledP;
  assert.ok(first >= p * 2 - 1e-15);
  assert.ok(third.adjustedP >= third.record.pooledP * 3 - 1e-15 || third.adjustedP === 1);
  // Pooled = the test windows only, in order.
  assert.equal(both.daily.length, folds.reduce((s, f) => s + f.test.end - f.test.start + 1, 0));
  assert.equal(both.daily[0]!.sessionDate, sessions[folds[0]!.test.start]!.sessionDate);
});
