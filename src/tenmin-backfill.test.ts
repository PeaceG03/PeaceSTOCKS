import assert from "node:assert/strict";
import test from "node:test";
import { backfillEndDate, planBackfillRanges } from "./tenmin-backfill";

test("backfill planner: ends before the stored pair and plans newest first", () => {
  assert.equal(backfillEndDate("2024-10-11"), "2024-08-31");
  assert.deepEqual(planBackfillRanges("2024-10-11", "2024-07-01").map((r) => r.calendarFrom), ["2024-07-01"]);
});
