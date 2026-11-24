// Auditor's #114 PASS note: an after-scan refill that reaches DEADLINE after repeated RUNS_CHECK_FAILED
// (the runs API kept failing) checks in as non-OK so health raises the issue; it is not a quiet exit 0.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEADLINE_RUNS_CHECK_FAILED, deadlineStopReason, refillCheckin, refillStopExit } from "./gap-refill";
import { evaluateHealth } from "./health-check";

const source = readFileSync(new URL("./gap-refill.ts", import.meta.url), "utf8");

test("runs check: the budget stop after repeated RUNS_CHECK_FAILED is not the planned cap", () => {
  assert.equal(deadlineStopReason(0), "DEADLINE");
  assert.equal(deadlineStopReason(1), "DEADLINE", "one failed check is a blip");
  assert.equal(deadlineStopReason(2), DEADLINE_RUNS_CHECK_FAILED);
  assert.equal(deadlineStopReason(30), DEADLINE_RUNS_CHECK_FAILED);
  // The gate counts consecutive RUNS_CHECK_FAILED pauses and uses them at the deadline.
  assert.match(source, /if \(Date\.now\(\) >= deadline\) return deadlineStopReason\(runsCheckFailedStreak\);/u);
  assert.match(source, /runsCheckFailedStreak = why === "RUNS_CHECK_FAILED" \? runsCheckFailedStreak \+ 1 : 0;/u);
});

test("runs check: after a scan it checks in ERROR (health raises the issue); not BEHIND, not OK", () => {
  const stop = refillStopExit(DEADLINE_RUNS_CHECK_FAILED, true, { fetched: 0, sessions: 5 });
  assert.equal(stop.code, 0, "the scan step stays green; the shared tail does not alert twice");
  assert.equal(stop.behind, undefined);
  assert.equal(stop.runsCheckFailed, true);
  assert.match(stop.line, /::warning title=Gap refill after scan::/u);
  const checkin = refillCheckin(["--after-scan"], { code: stop.code, runsCheckFailed: true })!;
  assert.deepEqual(checkin, { state: "ERROR", message: "GAP_REFILL_DEADLINE_RUNS_CHECK_FAILED (after-scan)" });
  const health = evaluateHealth({
    parts: [{ name: "gap refill", allowedSilenceMinutes: 8 * 24 * 60 }],
    latest: new Map([["gap refill", { part: "gap-refill", state: checkin.state, at: "2026-11-24T10:40:00Z", message: checkin.message! }]]),
    now: new Date("2026-11-24T13:40:00Z"),
  });
  assert.equal(health.parts[0]!.status, "error");
  assert.equal(health.attention, true);
  // The weekly refill: any stop but its own DEADLINE cap already exits 4 (unchanged).
  assert.equal(refillStopExit(DEADLINE_RUNS_CHECK_FAILED, false, { fetched: 0, sessions: 5 }).code, 4);
});
