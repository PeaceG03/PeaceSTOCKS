import assert from "node:assert/strict";
import test from "node:test";
import { addCalendarDays } from "./tenmin-history";

test("addCalendarDays throws INVALID_CALENDAR_DATE", () => {
  assert.throws(() => addCalendarDays('2026-02-31', 0), /INVALID_CALENDAR_DATE/);
  assert.throws(() => addCalendarDays('2026-04-31', 1), /INVALID_CALENDAR_DATE/);
  assert.equal(addCalendarDays('2026-02-28', 1), '2026-03-01');
});
