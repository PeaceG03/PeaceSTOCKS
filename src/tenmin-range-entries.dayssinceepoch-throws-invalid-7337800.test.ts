import assert from "node:assert/strict";
import test from "node:test";
import { daysSinceEpoch } from "./tenmin-range-entries";

test("daysSinceEpoch throws INVALID_CALENDAR_DATE", () => {
  assert.throws(() => daysSinceEpoch('2026-02-30'), /INVALID_CALENDAR_DATE/);
  assert.throws(() => daysSinceEpoch('2026-09-31'), /INVALID_CALENDAR_DATE/);
  assert.equal(daysSinceEpoch('1970-01-02'), 1);
});
