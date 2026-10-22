import assert from "node:assert/strict";
import test from "node:test";
import { addCalendarYears } from "./tenmin-history";

test("calendar years", () => {
  assert.equal(addCalendarYears("2024-02-29", 4), "2028-02-29");
  assert.equal(addCalendarYears("2023-03-31", 1), "2024-03-31");
  assert.equal(addCalendarYears("2025-02-28", -1), "2024-02-28");
  assert.equal(addCalendarYears("2026-10-13", 0), "2026-10-13");
  assert.throws(() => addCalendarYears("2026-1-05", 1), /INVALID_SESSION_DATE/);
});
