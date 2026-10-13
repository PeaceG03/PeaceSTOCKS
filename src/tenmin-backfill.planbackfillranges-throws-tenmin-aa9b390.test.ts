import assert from "node:assert/strict";
import test from "node:test";
import { backfillEndDate, planBackfillRanges } from "./tenmin-backfill";

test("planBackfillRanges throws TENMIN_BACKFILL_FLOOR_TOO_OLD", () => {
  assert.throws(() => planBackfillRanges("2024-10-11", "1999-01-01"), /TENMIN_BACKFILL_FLOOR_TOO_OLD/);
  assert.equal(backfillEndDate("2024-10-11"), "2024-08-31");
});
