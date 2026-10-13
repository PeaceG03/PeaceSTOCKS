// Builder teaching example: logging-only older-range plan (daily bars first, ticker-index months, no overlap).
import assert from "node:assert/strict";
import test from "node:test";
import { planOlderBackfill } from "./tenmin-backfill";
import { backfillDecisionFromPlan } from "./tenmin-backfill-cli";

test("older plan: per range daily bars span + ticker months, newest first, below the stored pair", () => {
  const steps = planOlderBackfill("2024-09-01", "2024-07-22");
  assert.deepEqual(steps, [{
    range: { calendarFrom: "2024-07-01", calendarTo: "2024-08-31", fetchFrom: "2024-07-22", fetchTo: "2024-08-31" },
    dailyBars: { from: "2024-07-22", to: "2024-08-31" },
    tickerIndexMonths: ["2024-07", "2024-08"],
  }]);
  assert.equal(planOlderBackfill("2024-09-01", "2023-12-15").at(-1)!.tickerIndexMonths[0], "2023-12");
  assert.deepEqual(planOlderBackfill("2024-09-01", "2024-09-01"), []);
});

test("decide logs the plan only when older history is reachable", () => {
  assert.equal(backfillDecisionFromPlan(JSON.stringify({ olderReachable: true, probedFrom: "2024-07-22" }), "2024-09-01", false).steps.length, 1);
  assert.deepEqual(backfillDecisionFromPlan(JSON.stringify({ olderReachable: false }), "2024-09-01", false).steps, []);
  assert.deepEqual(backfillDecisionFromPlan("not json", "2024-09-01", false).steps, []);
});
