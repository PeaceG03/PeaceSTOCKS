import assert from "node:assert/strict";
import test from "node:test";
import { estimateTenMinRangeRemaining } from "./tenmin-history";

test("orphan fetches are reported and not subtracted", () => {
  assert.equal(estimateTenMinRangeRemaining({ range: "2024-10", plannedFetches: 10, storedFetches: 2, gappedFetches: 1, groupedDailyRemaining: 0, orphanFetches: 3, budgetMs: 3600000, requestsPerMinute: 5, hitTimeBudget: false, actualRequestsThisRun: 0 }).orphanFetches, 3);
  assert.equal(estimateTenMinRangeRemaining({ range: "2024-10", plannedFetches: 10, storedFetches: 2, gappedFetches: 1, groupedDailyRemaining: 0, orphanFetches: 3, budgetMs: 3600000, requestsPerMinute: 5, hitTimeBudget: false, actualRequestsThisRun: 0 }).remainingFetches, 7);
});
