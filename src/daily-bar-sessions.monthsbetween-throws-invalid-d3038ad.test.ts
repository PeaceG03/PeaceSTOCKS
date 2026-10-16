import assert from "node:assert/strict";
import test from "node:test";
import { monthsBetween } from "./daily-bar-sessions";

test("monthsBetween throws INVALID_MONTH_BOUND", () => {
  assert.throws(() => monthsBetween("2026", "2026-01"), /INVALID_MONTH_BOUND/);
  assert.equal(monthsBetween("2026-01", "2026-02").length, 2);
});
