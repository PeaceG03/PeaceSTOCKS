// Auditor round 4: under a sealed range the daily step stamps a tracked unfinished day STUCK_SHORT
// (SEALED_OVER) and reports it STUCK_SHORT; a bare SKIPPED_RANGE_SEALED never resolves the hold.
import assert from "node:assert/strict";
import test from "node:test";
import { heldDayResolution } from "./tenmin-redispatch";

test("held day: only the held day itself STUCK_SHORT (or COMPLETE) resolves the hold; SKIPPED_RANGE_SEALED or another day's never does", () => {
  const daily = (status: string, day = "2026-10-09") => ({ status: "RAN", finishedAt: "2026-10-10T07:00:00Z", sessions: [{ sessionDate: day, status }, { sessionDate: "2026-10-12", status: "COMPLETE" }] });
  assert.equal(heldDayResolution("WAIT_DAILY_STEP:2026-10-09", daily("STUCK_SHORT"), "2026-10-10T06:00:00Z"), "2026-10-09:STUCK_SHORT");
  assert.equal(heldDayResolution("WAIT_DAILY_STEP:2026-10-09", daily("SKIPPED_RANGE_SEALED"), "2026-10-10T06:00:00Z"), undefined);
  assert.equal(heldDayResolution("WAIT_DAILY_STEP:2026-10-09", daily("PARTIAL"), "2026-10-10T06:00:00Z"), undefined);
});
