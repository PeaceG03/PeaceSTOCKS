import assert from "node:assert/strict";
import test from "node:test";
import { monthsBetween } from "./daily-bar-sessions";

test("monthsBetween throws INVALID_MONTH_RANGE", () => {
  assert.throws(() => monthsBetween("2026-11-01", "2026-09-30"), /INVALID_MONTH_RANGE/);
  assert.deepEqual(monthsBetween("2026-09-30", "2026-11-01"), ["2026-09", "2026-10", "2026-11"]);
});
