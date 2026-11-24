// B3: a held day whose range sealed is skipped by the daily step (no fetch, no write); that report is
// the held day's own resolution, so the fallback restarts the chain.
import assert from "node:assert/strict";
import test from "node:test";
import { heldDayResolution } from "./tenmin-redispatch";

test("held day: SKIPPED_RANGE_SEALED for the held day itself resolves the hold; another day's never does", () => {
  const daily = (status: string, day = "2026-10-09") => ({ status: "RAN", finishedAt: "2026-10-10T07:00:00Z", sessions: [{ sessionDate: day, status }, { sessionDate: "2026-10-12", status: "COMPLETE" }] });
  assert.equal(heldDayResolution("WAIT_DAILY_STEP:2026-10-09", daily("SKIPPED_RANGE_SEALED"), "2026-10-10T06:00:00Z"), "2026-10-09:SKIPPED_RANGE_SEALED");
  assert.equal(heldDayResolution("WAIT_DAILY_STEP:2026-10-09", daily("PARTIAL"), "2026-10-10T06:00:00Z"), undefined);
});
