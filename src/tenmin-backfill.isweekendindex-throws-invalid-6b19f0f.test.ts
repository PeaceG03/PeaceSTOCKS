import assert from "node:assert/strict";
import test from "node:test";
import { isWeekendIndex } from "./tenmin-backfill";

test("isWeekendIndex throws INVALID_WEEKDAY_INDEX", () => {
  assert.throws(() => isWeekendIndex(7), /INVALID_WEEKDAY_INDEX/);
  assert.equal(isWeekendIndex(6), true);
});
