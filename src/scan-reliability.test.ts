import assert from "node:assert/strict";
import test from "node:test";
import type { PredictionStatus } from "./contracts";
import { actionsBySession, scanReliability, sessionFreeze, type ScannerRunSummary } from "./scan-reliability";

const rec = (sessionDate: string, status: "FROZEN" | "UNAVAILABLE", reason: PredictionStatus["reason"], predictedAt?: string, nextSessionOpen?: string, attemptedAt?: string): PredictionStatus =>
  ({ predictionStatusId: "x", sessionDate, status, reason, scannerVersion: "v", configFingerprint: "c", recordedAt: `${sessionDate}T23:59:59.999Z`, ...(predictedAt ? { predictedAt } : {}), ...(nextSessionOpen ? { nextSessionOpen } : {}), ...(attemptedAt ? { attemptedAt } : {}) }) as PredictionStatus;

test("a session is on time only when frozen strictly before the next 09:30 ET open", () => {
  assert.equal(sessionFreeze("2026-11-23", [rec("2026-11-23", "FROZEN", "PREDICTIONS_FROZEN", "2026-11-24T06:20:00Z", "2026-11-24T14:30:00Z")]).minutesBeforeOpen, 490);
  assert.equal(sessionFreeze("2026-11-23", [rec("2026-11-23", "FROZEN", "PREDICTIONS_FROZEN", "2026-11-24T14:30:00Z", "2026-11-24T14:30:00Z")]).outcome, "FROZEN_AFTER_OPEN");
  assert.equal(sessionFreeze("2026-11-23", [rec("2026-11-23", "FROZEN", "PREDICTIONS_FROZEN")]).outcome, "FROZEN_AFTER_OPEN");
  assert.equal(sessionFreeze("2026-11-23", []).outcome, "NO_RECORD");
  const evidence = sessionFreeze("2026-11-20", [
    rec("2026-11-20", "UNAVAILABLE", "SOURCE_COLLECTION_FAILED", undefined, undefined, "2026-11-21T06:00:00Z"),
    rec("2026-11-20", "UNAVAILABLE", "EVIDENCE_ONLY", undefined, undefined, "2026-11-24T06:00:00Z"),
  ]);
  assert.equal(evidence.outcome, "EVIDENCE_ONLY");
  // A late UNAVAILABLE after an on-time freeze does not undo the freeze.
  assert.equal(sessionFreeze("2026-11-23", [rec("2026-11-23", "FROZEN", "PREDICTIONS_FROZEN", "2026-11-24T06:00:00Z", "2026-11-24T14:30:00Z"), rec("2026-11-23", "UNAVAILABLE", "EVIDENCE_ONLY", undefined, undefined, "2026-11-25T00:00:00Z")]).onTime, true);
});

test("streaks count consecutive trading sessions (calendar-aware) and every miss is listed", () => {
  const ok = (d: string, next: string) => rec(d, "FROZEN", "PREDICTIONS_FROZEN", `${next}T06:00:00Z`, `${next}T14:30:00Z`);
  const records = [ok("2026-11-16", "2026-11-17"), ok("2026-11-17", "2026-11-18"), rec("2026-11-18", "UNAVAILABLE", "EVIDENCE_ONLY"), ok("2026-11-19", "2026-11-20"), ok("2026-11-20", "2026-11-23"), ok("2026-11-23", "2026-11-24")];
  const report = scanReliability(records, "2026-11-16", "2026-11-23");
  assert.equal(report.sessions, 6); // weekend skipped
  assert.equal(report.onTime, 5);
  assert.equal(report.currentStreak, 3);
  assert.equal(report.longestStreak, 3);
  assert.deepEqual(report.misses, [{ sessionDate: "2026-11-18", outcome: "EVIDENCE_ONLY" }]);
  assert.equal(scanReliability(records, "2026-11-16", "2026-11-24").currentStreak, 0); // 11-24 has no record
  // Thanksgiving 2026-11-26 is closed: not a miss.
  assert.equal(scanReliability([], "2026-11-26", "2026-11-26").sessions, 0);
});

test("Actions runs are joined to the session whose close-to-next-open window they started in", () => {
  const run = (id: number, createdAt: string, jobs: ScannerRunSummary["jobs"]): ScannerRunSummary => ({ id, event: "workflow_dispatch", createdAt, conclusion: "success", jobs });
  const runs = [
    run(1, "2026-11-20T20:30:00Z", [{ name: "scan", conclusion: "failure" }]), // Fri 15:30 ET: before the close, not counted
    run(2, "2026-11-21T06:00:00Z", [{ name: "scan", conclusion: "failure" }, { name: "scan_backstop", conclusion: "skipped" }]),
    run(3, "2026-11-23T14:00:00Z", [{ name: "scan", conclusion: "skipped" }, { name: "scan_backstop_after_history / backstop", conclusion: "success" }]),
    run(4, "2026-11-23T14:30:00Z", [{ name: "scan", conclusion: "success" }]), // Mon 09:30 ET: the open itself, next window
  ];
  const [fri, mon] = actionsBySession(runs, ["2026-11-20", "2026-11-23"]);
  assert.deepEqual([fri!.runs, fri!.scanRan, fri!.scanSucceeded, fri!.scanFailed, fri!.backstopSucceeded], [2, 1, 0, 1, 1]);
  assert.equal(fri!.windowEnd, "2026-11-23T14:30:00.000Z");
  assert.equal(mon!.runs, 0);
});
