import assert from "node:assert/strict";
import test from "node:test";
import { dateFromDaysSinceEpoch } from "./tenmin-range-entries";

test("utc day numbers", () => {
  assert.equal(dateFromDaysSinceEpoch(0), "1970-01-01");
  assert.equal(dateFromDaysSinceEpoch(20454), "2026-01-01");
  assert.throws(() => dateFromDaysSinceEpoch(-1), /INVALID_RANGE/);
  assert.throws(() => dateFromDaysSinceEpoch(1.5), /INVALID_RANGE/);
});
