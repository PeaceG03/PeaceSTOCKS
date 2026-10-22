import assert from "node:assert/strict";
import test from "node:test";
import { pairRangeForDate } from "./tenmin-history";

test("custom anchors", () => {
  assert.deepEqual(pairRangeForDate("2025-01-10", "2024-02-01"), { calendarFrom: "2024-12-01", calendarTo: "2025-01-31" });
  assert.deepEqual(pairRangeForDate("2025-02-10", "2024-02-01"), { calendarFrom: "2025-02-01", calendarTo: "2025-03-31" });
  assert.deepEqual(pairRangeForDate("2025-12-31", "2024-01-01"), { calendarFrom: "2025-11-01", calendarTo: "2025-12-31" });
  assert.throws(() => pairRangeForDate("2025-1-10"), /INVALID_SESSION_DATE/);
  assert.throws(() => pairRangeForDate("2025-01-10", "2024-2-01"), /INVALID_SESSION_DATE/);
});
