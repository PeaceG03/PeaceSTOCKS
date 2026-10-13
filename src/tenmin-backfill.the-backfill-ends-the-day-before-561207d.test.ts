import assert from "node:assert/strict";
import test from "node:test";
import { backfillEndDate, decideBackfill } from "./tenmin-backfill";

test("the backfill ends the day before the stored two-month range", () => {
  assert.equal(backfillEndDate("2024-10-11"), "2024-08-31");
  assert.equal(backfillEndDate("2024-11-04"), "2024-10-31");
  assert.equal(backfillEndDate("2024-09-01"), "2024-08-31");
  assert.equal(decideBackfill(true, 2, false), "dispatch");
  assert.equal(decideBackfill(true, 2, true), "hold");
  assert.equal(decideBackfill(false, 2, false), "daily");
  assert.equal(decideBackfill(true, 0, false), "daily");
});
