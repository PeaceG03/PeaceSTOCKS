// Held-out evaluation: a scan at D sees nothing after D, outcomes use only later sessions, and the
// baselines are computed on the same names and sessions.
import assert from "node:assert/strict";
import test from "node:test";
import type { SecurityMasterRecord } from "./contracts";
import { EvalHistory, evaluateSession, forwardReturn, pointInTimeSecurities, rng, scanInputBars, spearman, summarize, type EvalBar } from "./holdout-eval";

function weekdays(n: number, first = "2026-03-02"): string[] {
  const out: string[] = [];
  for (let d = new Date(`${first}T00:00:00Z`); out.length < n; d.setUTCDate(d.getUTCDate() + 1))
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  return out;
}
const master = (ids: string[]) =>
  ids.map((id) => ({ securityId: id, currentSymbol: id, assetType: "STOCK", status: "ACTIVE", eligibility: "LEVEL_3" }) as unknown as SecurityMasterRecord);

/** n names; drift d_k makes some names persistent winners when `signal` is on. */
function world(n: number, days: string[], seed: number, signal: boolean) {
  const r = rng(seed);
  const bars: EvalBar[] = [];
  const ids = Array.from({ length: n }, (_, k) => `s${String(k).padStart(3, "0")}`);
  ids.forEach((id, k) => {
    const drift = signal ? (k % 10 === 0 ? 0.004 : -0.0005) : 0;
    let close = 20 + r() * 50;
    for (const day of days) {
      const open = close * (1 + (r() - 0.5) * 0.002);
      close = open * (1 + drift + (r() - 0.5) * 0.02);
      bars.push({ securityId: id, sessionDate: day, open, close, volume: 1e5 + r() * 1e5, revision: 1 });
    }
  });
  return { bars, ids };
}

test("a scan at D uses no bar after D: rewriting every later bar leaves D's lists unchanged", () => {
  const days = weekdays(140);
  const { bars, ids } = world(60, days, 3, false);
  const i = 110;
  const D = days[i]!;
  const before = evaluateSession(master(ids), new EvalHistory(bars), i, { horizon: 5, randomDraws: 5, seed: 1 })!;
  const r = rng(99);
  const scrambled = bars.map((b) => (b.sessionDate > D ? { ...b, open: b.open * (0.5 + r()), close: b.close * (0.5 + r()) } : b));
  const after = evaluateSession(master(ids), new EvalHistory(scrambled), i, { horizon: 5, randomDraws: 5, seed: 1 })!;
  assert.deepEqual(after.predictions, before.predictions);
  assert.notEqual(after.outcome.universeMean, before.outcome.universeMean); // outcomes do use later bars
  for (const bar of scanInputBars(new EvalHistory(bars), i)) assert.ok(bar.sessionDate <= D);
});

test("eligibility and ACTIVE are point in time: later bars never count", () => {
  const days = weekdays(30);
  const bars: EvalBar[] = [];
  days.forEach((day, k) => {
    bars.push({ securityId: "old", sessionDate: day, open: 1, close: 1, volume: 1, revision: 1 });
    if (k >= 25) bars.push({ securityId: "new", sessionDate: day, open: 1, close: 1, volume: 1, revision: 1 });
  });
  const history = new EvalHistory(bars);
  const [old, young] = pointInTimeSecurities(master(["old", "new"]), history, 19);
  assert.equal(old!.barCount, 20);
  assert.equal(old!.eligibility, "LEVEL_2");
  assert.equal(young!.barCount, 0);
  assert.equal(young!.eligibility, "LEVEL_0");
  assert.equal(young!.status, "INACTIVE");
  assert.equal(pointInTimeSecurities(master(["new"]), history, 29)[0]!.barCount, 5);
});

test("the forward return enters at the next session's open and exits at the close h sessions after D", () => {
  const days = weekdays(6);
  const bars = days.map((day, k) => ({ securityId: "a", sessionDate: day, open: 10 + k, close: 100 + k, volume: 1, revision: 1 }));
  const history = new EvalHistory(bars);
  assert.equal(forwardReturn(history, "a", 0, 1), 101 / 11 - 1);
  assert.equal(forwardReturn(history, "a", 0, 5), 105 / 11 - 1);
  assert.equal(forwardReturn(history, "a", 1, 5), undefined); // past the last stored session
  // A name with no bar at the entry session has no outcome (the session itself still exists).
  const other = days.map((day) => ({ securityId: "b", sessionDate: day, open: 1, close: 1, volume: 1, revision: 1 }));
  assert.equal(forwardReturn(new EvalHistory([...other, ...bars.filter((b) => b.sessionDate !== days[1])]), "a", 0, 1), undefined);
});

test("a real persistent edge shows up as positive excess and a small random-list p; pure noise does not", () => {
  const days = weekdays(200);
  const run = (signal: boolean) => {
    const { bars, ids } = world(200, days, 11, signal);
    const history = new EvalHistory(bars);
    const outcomes = [];
    for (let i = 110; i < 195; i += 1) {
      const got = evaluateSession(master(ids), history, i, { horizon: 1, randomDraws: 200, seed: 5 });
      if (got) outcomes.push(got.outcome);
    }
    return summarize(outcomes);
  };
  const edge = run(true).lists.STRONGEST_MOMENTUM!;
  assert.ok(edge.meanExcess > 0.001, `excess ${edge.meanExcess}`);
  assert.ok(edge.randomP < 0.05, `p ${edge.randomP}`);
  const noise = run(false);
  assert.ok(noise.lists.TOP_15_OVERALL!.randomP > 0.01);
  assert.ok(Math.abs(noise.lists.TOP_15_OVERALL!.randomMean - noise.lists.TOP_15_OVERALL!.universeMean) < 1e-3);
  assert.ok(Math.abs(noise.meanIC) < 0.05);
});

test("excluded names and winsorizing apply to picks and baselines alike; spearman sanity", () => {
  const days = weekdays(130);
  const { bars, ids } = world(40, days, 4, false);
  const history = new EvalHistory(bars);
  const all = evaluateSession(master(ids), history, 110, { horizon: 1, randomDraws: 3, seed: 2 })!;
  const some = evaluateSession(master(ids), history, 110, { horizon: 1, randomDraws: 3, seed: 2, excluded: (id) => id === "s000" })!;
  assert.equal(some.outcome.universeSize, all.outcome.universeSize - 1);
  const clipped = evaluateSession(master(ids), history, 110, { horizon: 1, randomDraws: 3, seed: 2, winsorize: 0.25 })!;
  assert.equal(clipped.outcome.universeSize, all.outcome.universeSize);
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.deepEqual(summarize([all.outcome, some.outcome, clipped.outcome], 2).sessions, 2);
});
