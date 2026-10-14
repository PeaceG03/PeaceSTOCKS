import assert from "node:assert/strict";
import test from "node:test";
import { planBackfillRanges } from "./tenmin-backfill";

test("planBackfillRanges throws INVALID_MAX_RANGES", () => {
  assert.throws(() => planBackfillRanges("2024-10-11", "2024-01-01", 0), /INVALID_MAX_RANGES/);
  assert.deepEqual(planBackfillRanges("2024-10-11", "2024-01-01", 1), [{"calendarFrom":"2024-07-01","calendarTo":"2024-08-31","fetchFrom":"2024-07-01","fetchTo":"2024-08-31"}]);
});
