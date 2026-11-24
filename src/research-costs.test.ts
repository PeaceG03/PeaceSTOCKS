import assert from "node:assert/strict";
import test from "node:test";
import { COST_CONFIG_INVALID, simulateList, type HarnessSession } from "./research-costs";

const s = (date: string, ids: string[], returns: Array<number | null>, universeMean = 0, spy?: number): HarnessSession => ({
  sessionDate: date,
  universeSize: 100,
  universeMean,
  ...(spy === undefined ? {} : { spy }),
  lists: { L: { ids, returns } },
});

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test("costs: entry, partial rebalance and exit are charged per side on turnover", () => {
  const sessions = [
    s("d0", ["a", "b"], [0.01, 0.03], 0.001, 0.002),
    s("d1", ["a", "c"], [0.02, -0.01]),
    s("d2", ["a", "c"], [0.0, 0.01]),
  ];
  const r = simulateList(sessions, { start: 0, end: 2 }, "L", { slippageBpsPerSide: 10 });
  // d0: buy a and b (turnover 1). d1: sell b 0.5, buy c 0.5 (turnover 1). d2: no change, then sell all (1).
  assert.deepEqual(r.map((x) => x.turnover), [1, 1, 1]);
  close(r[0]!.gross, 0.02);
  close(r[0]!.cost, 0.001);
  close(r[0]!.net, 0.019);
  close(r[1]!.net, 0.005 - 0.001);
  close(r[2]!.net, 0.005 - 0.001);
  assert.equal(r[0]!.universe, 0.001);
  assert.equal(r[0]!.spy, 0.002);
  assert.equal(r[1]!.spy, undefined);
});

test("costs: a name held through costs nothing; zero bps means net == gross; negative bps refused", () => {
  const sessions = [s("d0", ["a"], [0.01]), s("d1", ["a"], [0.02]), s("d2", ["a"], [0.03])];
  const r = simulateList(sessions, { start: 0, end: 2 }, "L", { slippageBpsPerSide: 25 });
  assert.deepEqual(r.map((x) => x.turnover), [1, 0, 1]);
  close(r[1]!.net, 0.02);
  close(r[0]!.net, 0.01 - 0.0025);
  const free = simulateList(sessions, { start: 0, end: 2 }, "L", { slippageBpsPerSide: 0 });
  assert.deepEqual(free.map((x) => x.net), free.map((x) => x.gross));
  assert.throws(() => simulateList(sessions, { start: 0, end: 2 }, "L", { slippageBpsPerSide: -1 }), new RegExp(COST_CONFIG_INVALID));
});

test("costs: names without an outcome are not held; topN takes the first N; an empty list holds cash", () => {
  const sessions = [s("d0", ["a", "b", "c"], [0.04, null, 0.0]), s("d1", [], [])];
  const r = simulateList(sessions, { start: 0, end: 1 }, "L", { slippageBpsPerSide: 10 });
  assert.equal(r[0]!.holdings, 2);
  close(r[0]!.gross, 0.02);
  assert.equal(r[1]!.holdings, 0);
  assert.equal(r[1]!.gross, 0);
  close(r[1]!.turnover, 1); // sold the two names
  const top1 = simulateList(sessions, { start: 0, end: 0 }, "L", { slippageBpsPerSide: 10 }, 1);
  close(top1[0]!.gross, 0.04);
  close(top1[0]!.turnover, 2); // bought and (last session) sold
});
