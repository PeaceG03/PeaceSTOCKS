import assert from "node:assert/strict";
import test from "node:test";
import {
  TENMIN_HISTORY_DEFAULT_BUDGET_MS,
  TENMIN_HISTORY_REQUESTS_PER_MINUTE,
  countGappedPlannedFetches,
  estimateTenMinRangeRemaining,
} from "./tenmin-history";
import type { TenMinRangeGapEntry, TenMinRangePlannedFetch } from "./tenmin-range-reply-dust";

const RANGE = "2024-11-01_2024-12-31";

test("fresh range: all planned remaining; ETA from budget × 5 req/min", () => {
  const r = estimateTenMinRangeRemaining({
    range: RANGE,
    plannedFetches: 1000,
    storedFetches: 0,
    gappedFetches: 0,
    groupedDailyRemaining: 40,
    budgetMs: TENMIN_HISTORY_DEFAULT_BUDGET_MS,
  });
  assert.equal(r.remainingFetches, 1000);
  assert.equal(r.estimatedRemainingRequests, 1040); // lower bound
  const perRun = Math.floor((TENMIN_HISTORY_DEFAULT_BUDGET_MS / 60_000) * TENMIN_HISTORY_REQUESTS_PER_MINUTE);
  assert.equal(perRun, 550);
  assert.equal(r.estimatedRunsToSeal, Math.ceil(1040 / 550));
});

test("mid-range resume: stored + gapped reduce remaining", () => {
  const r = estimateTenMinRangeRemaining({
    range: RANGE,
    plannedFetches: 100,
    storedFetches: 60,
    gappedFetches: 10,
    groupedDailyRemaining: 0,
  });
  assert.deepEqual(r, {
    range: RANGE,
    plannedFetches: 100,
    storedFetches: 60,
    gappedFetches: 10,
    remainingFetches: 30,
    groupedDailyRemaining: 0,
    estimatedRemainingRequests: 30,
    estimatedRunsToSeal: 1,
  });
});

test("all stored but gaps: remainingFetches 0; grouped days still count", () => {
  const r = estimateTenMinRangeRemaining({
    range: RANGE,
    plannedFetches: 50,
    storedFetches: 40,
    gappedFetches: 10,
    groupedDailyRemaining: 3,
  });
  assert.equal(r.remainingFetches, 0);
  assert.equal(r.estimatedRemainingRequests, 3);
  assert.equal(r.estimatedRunsToSeal, 1);
});

test("grouped days pending only (fetches not started)", () => {
  const r = estimateTenMinRangeRemaining({
    range: RANGE,
    plannedFetches: 200,
    storedFetches: 0,
    gappedFetches: 0,
    groupedDailyRemaining: 15,
  });
  assert.equal(r.estimatedRemainingRequests, 215);
});

test("budget-derived runs; TIME_BUDGET uses actual requests this run", () => {
  const budget = estimateTenMinRangeRemaining({
    range: RANGE,
    plannedFetches: 2000,
    storedFetches: 0,
    gappedFetches: 0,
    groupedDailyRemaining: 0,
    budgetMs: 60_000, // 1 minute → 5 req/run
  });
  assert.equal(budget.estimatedRunsToSeal, Math.ceil(2000 / 5));

  const actual = estimateTenMinRangeRemaining({
    range: RANGE,
    plannedFetches: 2000,
    storedFetches: 100,
    gappedFetches: 0,
    groupedDailyRemaining: 0,
    budgetMs: 60_000,
    hitTimeBudget: true,
    actualRequestsThisRun: 100, // this run made 100 before TIME_BUDGET
  });
  assert.equal(actual.remainingFetches, 1900);
  assert.equal(actual.estimatedRunsToSeal, Math.ceil(1900 / 100));
});

test("sealed: zero remaining → zero runs", () => {
  const r = estimateTenMinRangeRemaining({
    range: RANGE,
    plannedFetches: 10,
    storedFetches: 10,
    gappedFetches: 0,
    groupedDailyRemaining: 0,
  });
  assert.equal(r.estimatedRemainingRequests, 0);
  assert.equal(r.estimatedRunsToSeal, 0);
});

test("countGappedPlannedFetches matches planned identities only", () => {
  const planned: TenMinRangePlannedFetch[] = [
    { securityId: "s1", symbol: "AAA", fetchFrom: "2024-11-01", fetchTo: "2024-12-31" },
    { securityId: "s2", symbol: "BBB", fetchFrom: "2024-11-01", fetchTo: "2024-12-31" },
  ];
  const gaps: TenMinRangeGapEntry[] = [
    {
      securityId: "s1",
      symbol: "AAA",
      reason: "MASSIVE_HTTP_404",
      at: "2026-10-06T00:00:00.000Z",
      fetchFrom: "2024-11-01",
      fetchTo: "2024-12-31",
    },
    { securityId: "", symbol: "", reason: "AGED_OUT", at: "x", fetchFrom: "2024-10-01", fetchTo: "2024-10-31" },
    { securityId: "s9", symbol: "ZZZ", reason: "X", at: "x", fetchFrom: "2024-11-01", fetchTo: "2024-12-31" },
  ];
  assert.equal(countGappedPlannedFetches(planned, gaps), 1);
});
