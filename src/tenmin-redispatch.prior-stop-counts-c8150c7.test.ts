import assert from "node:assert/strict";
import test from "node:test";
import { tenMinScanCheckStops } from "./tenmin-redispatch";

test("prior stop counts", () => {
  assert.equal(tenMinScanCheckStops({ schemaVersion: "tenmin-history-outcome-v1", runId: "r1", nextAction: "stop", reason: "STOP_SCAN_CHECK_FAILED:http-403", rangesPlanned: 0, rangesSealed: 0, rangesRemaining: 0, madeProgress: false }, 4), 5);
  assert.equal(tenMinScanCheckStops({ schemaVersion: "tenmin-history-outcome-v1", runId: "r1", nextAction: "stop", reason: "STOP_SCAN_CHECK_FAILED:http-403", rangesPlanned: 0, rangesSealed: 0, rangesRemaining: 0, madeProgress: false }, -3), 1);
  assert.equal(tenMinScanCheckStops({ schemaVersion: "tenmin-history-outcome-v1", runId: "r1", nextAction: "stop", reason: "STOP_SCAN_CHECK_FAILED:http-403", rangesPlanned: 0, rangesSealed: 0, rangesRemaining: 0, madeProgress: false }, 2.5), 1);
  assert.equal(tenMinScanCheckStops({ schemaVersion: "tenmin-history-outcome-v1", runId: "r1", nextAction: "stop", reason: "STOP_SCAN_CHECK_FAILED", rangesPlanned: 0, rangesSealed: 0, rangesRemaining: 0, madeProgress: false }, 2), 0);
});
