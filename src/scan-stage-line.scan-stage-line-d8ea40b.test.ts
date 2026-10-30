import assert from "node:assert/strict";
import test from "node:test";
import { scanStageLine } from "./scan-stage-line";

test("scanStageLine: the examples from the issue", () => {
  assert.equal(scanStageLine("2026-10-13", "loadBars", 5123), "SCAN_STAGE:2026-10-13:loadBars:5123ms");
  assert.equal(scanStageLine("2026-10-14", "refreshEligibility", 0), "SCAN_STAGE:2026-10-14:refreshEligibility:0ms");
  assert.equal(scanStageLine("2026-10-30", "writeUniverse", 77), "SCAN_STAGE:2026-10-30:writeUniverse:77ms");
  assert.equal(scanStageLine("2026-10-13", "rank", 1), "SCAN_STAGE:2026-10-13:rank:1ms");
  assert.equal(scanStageLine("d", "s", 42), "SCAN_STAGE:d:s:42ms");
  assert.equal(scanStageLine(" Day 2, x ", " Load B2. ", -7), "SCAN_STAGE: Day 2, x : Load B2. :-7ms");
  assert.equal(scanStageLine("", "", 1234), "SCAN_STAGE:::1234ms");
});
