import assert from "node:assert/strict";
import test from "node:test";
import { addCalendarDays } from "./tenmin-history";

test("addCalendarDays throws INVALID_CALENDAR_DAYS", () => {
  assert.throws(() => addCalendarDays("2026-10-13", 1.5), /INVALID_CALENDAR_DAYS/);
  assert.equal(addCalendarDays("2026-10-13", -1), "2026-10-12");
});
