import assert from "node:assert/strict";
import test from "node:test";
import { addCalendarYears } from "./tenmin-history";

test("addCalendarYears throws INVALID_CALENDAR_YEARS", () => {
  assert.throws(() => addCalendarYears("2026-10-13", 1.5), /INVALID_CALENDAR_YEARS/);
  assert.equal(addCalendarYears("2024-02-29", 1), "2025-02-28");
});
