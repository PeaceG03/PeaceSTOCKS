import assert from "node:assert/strict";
import test from "node:test";
import { estimateTenMinRangeRemaining } from "./tenmin-history";

test("remaining clamps", () => {
  assert.deepEqual(estimateTenMinRangeRemaining({ range: "2024-10", plannedFetches: 3, storedFetches: -1, gappedFetches: 0, groupedDailyRemaining: -2, budgetMs: 1000 }), { range: "2024-10", plannedFetches: 3, storedFetches: 0, gappedFetches: 0, orphanFetches: 0, remainingFetches: 3, groupedDailyRemaining: 0, estimatedRemainingRequests: 3, estimatedRunsToSeal: 3 });
  assert.deepEqual(estimateTenMinRangeRemaining({ range: "2024-11", plannedFetches: 10, storedFetches: 4, gappedFetches: 1, groupedDailyRemaining: 3, budgetMs: 60000, requestsPerMinute: 5, hitTimeBudget: true, actualRequestsThisRun: 0 }), { range: "2024-11", plannedFetches: 10, storedFetches: 4, gappedFetches: 1, orphanFetches: 0, remainingFetches: 5, groupedDailyRemaining: 3, estimatedRemainingRequests: 8, estimatedRunsToSeal: 2 });
});
