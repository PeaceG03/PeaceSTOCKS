import assert from "node:assert/strict";
import test from "node:test";
import { stopRecordForScanCancelled } from "./tenmin-redispatch";

test("no outcome record", () => {
  assert.deepEqual(stopRecordForScanCancelled({ outcome: undefined, jobResult: "failure", chain: 3, githubRunId: "", finishedAt: "2026-10-06T10:00:00.000Z", decision: { dispatch: true, nextAction: "continue", reason: "CONTINUE", nextChain: 4 } }, "991", "2026-10-06T10:00:20.000Z"), { outcome: { schemaVersion: "tenmin-history-outcome-v1", runId: "unknown", nextAction: "stop", reason: "STOP_SCAN_CANCELLED:run=991", rangesPlanned: 0, rangesSealed: 0, rangesRemaining: 0, madeProgress: false }, jobResult: "failure", chain: 3, githubRunId: "", finishedAt: "2026-10-06T10:00:20.000Z", decision: { dispatch: false, nextAction: "stop", reason: "STOP_SCAN_CANCELLED:run=991", nextChain: 4 } });
});
