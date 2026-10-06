import assert from "node:assert/strict";
import test from "node:test";
import type { TenMinHistoryRangeReport, TenMinHistoryRunReport } from "./tenmin-history";
import {
  TENMIN_REDISPATCH_DEFAULT_MAX_CHAIN,
  TENMIN_STOP_SCAN_CANCELLED,
  type TenMinRedispatchInput,
  type TenMinRunOutcome,
  type TenMinRunRecord,
  assertCancelRunAccepted,
  cancelledScheduledScan,
  decideTenMinRedispatch,
  findDispatchedTenMinRun,
  guardWindowState,
  isCancelableDispatchStatus,
  maxChainOf,
  planCancelDispatchedRun,
  stopRecordForScanCancelled,
  tenMinRunOutcome,
} from "./tenmin-redispatch";

function range(status: TenMinHistoryRangeReport["status"], extra: Partial<TenMinHistoryRangeReport> = {}): TenMinHistoryRangeReport {
  return {
    calendarFrom: "2024-11-01",
    calendarTo: "2024-12-31",
    fetchFrom: "2024-11-01",
    fetchTo: "2024-12-31",
    status,
    securitiesPlanned: 10,
    fetchesPlanned: 10,
    securitiesWritten: 0,
    securitiesResumed: 0,
    gaps: [],
    symbolChangeWarnings: [],
    fallbackFiles: 0,
    massiveRequests: 0,
    zstdVersion: "1.5.7",
    delistedCoverage: "MISSING",
    ...extra,
  };
}

function report(extra: Partial<TenMinHistoryRunReport>): TenMinHistoryRunReport {
  return {
    schemaVersion: "tenmin-history-run-v1",
    runId: "tenmin-history-1",
    provider: "massive-stocks",
    configuredWindowStart: "2024-10-01",
    windowStart: "2024-10-08",
    lastCompletedSession: "2026-10-05",
    skippedBefore: [],
    reopen: false,
    securityLink: "PROVISIONAL",
    ranges: [],
    rangesPlanned: 12,
    stoppedOnError: false,
    warnings: [],
    zstdVersion: "1.5.7",
    massiveRequests: 0,
    groupedDailyRequests: 0,
    groupedDailyStored: 0,
    groupedDailyResumed: 0,
    completedAt: "2026-10-06T10:00:00.000Z",
    ...extra,
  } as TenMinHistoryRunReport;
}

const at = (hhmmss: string) => new Date(`2026-10-06T${hhmmss}Z`);

const continueOutcome: TenMinRunOutcome = tenMinRunOutcome(
  report({ ranges: [range("PARTIAL", { securitiesWritten: 3 })], yieldedForScan: "TIME_BUDGET:2026-10-06T10:00:00Z" }),
);

function input(extra: Partial<TenMinRedispatchInput> = {}): TenMinRedispatchInput {
  return {
    trigger: "chain",
    outcome: continueOutcome,
    jobResult: "success",
    // Outside both guard windows (05:15–06:15 and 09:15–10:15 UTC).
    nowUtc: at("12:00:00"),
    queue: { otherActiveRuns: 0 },
    killSwitch: "true",
    chain: 0,
    maxChain: undefined,
    ...extra,
  };
}

// ---- outcome ----

test("outcome: a clean partial continues (time budget with progress, scan yield, a range sealed with more to go)", () => {
  assert.deepEqual([continueOutcome.nextAction, continueOutcome.reason, continueOutcome.rangesRemaining], ["continue", "CONTINUE_TIME_BUDGET", 12]);
  const yielded = tenMinRunOutcome(report({ ranges: [range("PARTIAL")], yieldedForScan: "SCAN_RUN_WAITING:42:schedule:queued" }));
  assert.deepEqual([yielded.nextAction, yielded.reason], ["continue", "CONTINUE_YIELD:SCAN_RUN_WAITING"]);
  const guard = tenMinRunOutcome(report({ ranges: [], yieldedForScan: "SCAN_GUARD_WINDOW:2026-10-06T21:20:00Z" }));
  assert.deepEqual([guard.nextAction, guard.reason], ["continue", "CONTINUE_YIELD:SCAN_GUARD_WINDOW"]);
  const sealedMore = tenMinRunOutcome(report({ ranges: [range("SEALED"), range("PARTIAL", { securitiesWritten: 1 })], yieldedForScan: "TIME_BUDGET:x" }));
  assert.deepEqual([sealedMore.nextAction, sealedMore.rangesSealed, sealedMore.rangesRemaining], ["continue", 1, 11]);
});

test("outcome: every stop reason", () => {
  const cases: Array<[Partial<TenMinHistoryRunReport>, string]> = [
    [{ stoppedOnError: true, error: "TENMIN_DAILY_COVERAGE_HOLE:2025-01-01_2025-02-28:missing=2025-01-09" }, "STOP_REFUSAL:TENMIN_DAILY_COVERAGE_HOLE"],
    [{ stoppedOnError: true, error: "TENMIN_UNIVERSE_EMPTY:2024-11-01_2024-12-31:securities=0:gaps=0" }, "STOP_REFUSAL:TENMIN_UNIVERSE_EMPTY"],
    [{ stoppedOnError: true, error: "TENMIN_UNIVERSE_TOO_SMALL:2024-11-01_2024-12-31:planned=10:median=100" }, "STOP_REFUSAL:TENMIN_UNIVERSE_TOO_SMALL"],
    [{ stoppedOnError: true, error: "REPLY_DUST_METADATA_READBACK_MISMATCH" }, "STOP_ERROR:REPLY_DUST_METADATA_READBACK_MISMATCH"],
    [{ outageStop: "MASSIVE_OUTAGE:MASSIVE_HTTP_503:x" }, "STOP_OUTAGE:MASSIVE_OUTAGE:MASSIVE_HTTP_503:x"],
    [{ reopen: true, yieldedForScan: "TIME_BUDGET:x", ranges: [range("PARTIAL", { securitiesWritten: 1 })] }, "STOP_BOUNDED_MANUAL_RUN:reopen"],
    [{ maxRanges: 1, ranges: [range("SEALED")] }, "STOP_BOUNDED_MANUAL_RUN:maxRanges=1"],
    [{ rangesPlanned: 2, ranges: [range("ALREADY_SEALED"), range("SEALED")] }, "STOP_DONE:no-range-left"],
    [{ ranges: [range("PARTIAL")], yieldedForScan: "TIME_BUDGET:x" }, "STOP_NO_PROGRESS:TIME_BUDGET"],
  ];
  for (const [extra, reason] of cases) {
    const outcome = tenMinRunOutcome(report(extra));
    assert.deepEqual([outcome.nextAction, outcome.reason], ["stop", reason], reason);
    const decision = decideTenMinRedispatch(input({ outcome }));
    assert.deepEqual([decision.dispatch, decision.nextAction, decision.reason], [false, "stop", reason], reason);
  }
});

// ---- decision ----

test("decision: the clean partial dispatches the next run with the chain number incremented", () => {
  assert.deepEqual(decideTenMinRedispatch(input({ chain: 3 })), {
    dispatch: true,
    nextAction: "continue",
    reason: "CONTINUE_TIME_BUDGET",
    nextChain: 4,
  });
  assert.equal(decideTenMinRedispatch(input({ trigger: "fallback" })).dispatch, true);
});

test("decision: guard windows and the lead before them, at the edges", () => {
  const cases: Array<[string, boolean, string]> = [
    // 05:15–06:15 (lead from 05:05)
    ["05:04:59", true, "CONTINUE_TIME_BUDGET"],
    ["05:05:00", false, "WAIT_NEAR_GUARD_WINDOW"],
    ["05:14:59", false, "WAIT_NEAR_GUARD_WINDOW"],
    ["05:15:00", false, "WAIT_GUARD_WINDOW"],
    ["05:17:00", false, "WAIT_GUARD_WINDOW"], // fallback :17 tick inside window
    ["05:30:00", false, "WAIT_GUARD_WINDOW"],
    ["06:14:59", false, "WAIT_GUARD_WINDOW"],
    ["06:15:00", true, "CONTINUE_TIME_BUDGET"],
    // 09:15–10:15 (lead from 09:05)
    ["09:04:59", true, "CONTINUE_TIME_BUDGET"],
    ["09:05:00", false, "WAIT_NEAR_GUARD_WINDOW"],
    ["09:14:59", false, "WAIT_NEAR_GUARD_WINDOW"],
    ["09:15:00", false, "WAIT_GUARD_WINDOW"],
    ["09:17:00", false, "WAIT_GUARD_WINDOW"], // fallback :17 tick inside window
    ["09:30:00", false, "WAIT_GUARD_WINDOW"],
    ["10:14:59", false, "WAIT_GUARD_WINDOW"],
    ["10:15:00", true, "CONTINUE_TIME_BUDGET"],
    // Former windows / scan times are now allowed
    ["21:30:00", true, "CONTINUE_TIME_BUDGET"],
    ["01:30:00", true, "CONTINUE_TIME_BUDGET"],
    ["00:17:00", true, "CONTINUE_TIME_BUDGET"],
  ];
  for (const [time, dispatch, reason] of cases) {
    const decision = decideTenMinRedispatch(input({ nowUtc: at(time) }));
    assert.deepEqual([decision.dispatch, decision.reason], [dispatch, reason], time);
    if (!dispatch) assert.equal(decision.nextAction, "wait", time);
  }
  assert.deepEqual(guardWindowState(at("05:15:00")), { inside: true, minutesUntilNext: 0 });
  // 23:00 → next window 05:15 = 6h15m = 375
  assert.equal(guardWindowState(at("23:00:00")).minutesUntilNext, 375);
});

test("decision: a queued scan (or any other active scanner.yml run) waits; a failed queue check waits", () => {
  assert.deepEqual(decideTenMinRedispatch(input({ queue: { otherActiveRuns: 1 } })).reason, "WAIT_RUN_ACTIVE:1");
  assert.equal(decideTenMinRedispatch(input({ queue: { otherActiveRuns: 1 } })).nextAction, "wait");
  assert.equal(decideTenMinRedispatch(input({ queue: { otherActiveRuns: 0, checkFailed: "http-500" } })).reason, "WAIT_QUEUE_CHECK_FAILED:http-500");
  assert.equal(decideTenMinRedispatch(input({ queue: { otherActiveRuns: 0, checkFailed: "http-500" } })).dispatch, false);
});

test("decision: kill switch off, job failure, missing outcome, ranges done, a newer failed run, and the chain cap stop", () => {
  for (const killSwitch of [undefined, "", "false", "TRUE", "1"])
    assert.deepEqual(
      [decideTenMinRedispatch(input({ killSwitch })).dispatch, decideTenMinRedispatch(input({ killSwitch })).reason],
      [false, "KILL_SWITCH_OFF"],
    );
  assert.equal(decideTenMinRedispatch(input({ jobResult: "failure" })).reason, "STOP_JOB_FAILURE");
  assert.deepEqual(
    [decideTenMinRedispatch(input({ jobResult: "cancelled" })).dispatch, decideTenMinRedispatch(input({ jobResult: "cancelled" })).reason],
    [false, "STOP_JOB_CANCELLED"],
  );
  assert.equal(decideTenMinRedispatch(input({ outcome: undefined })).reason, "STOP_NO_OUTCOME");
  assert.equal(
    decideTenMinRedispatch(input({ outcome: { ...continueOutcome, rangesRemaining: 0 } })).reason,
    "STOP_DONE:no-range-left",
  );
  assert.equal(decideTenMinRedispatch(input({ trigger: "fallback", newerFailedRun: "99:failure" })).reason, "STOP_NEWER_RUN_FAILED:99:failure");
  assert.equal(decideTenMinRedispatch(input({ chain: TENMIN_REDISPATCH_DEFAULT_MAX_CHAIN - 1 })).dispatch, true);
  assert.equal(decideTenMinRedispatch(input({ chain: TENMIN_REDISPATCH_DEFAULT_MAX_CHAIN })).reason, "STOP_CHAIN_CAP:24");
  assert.equal(decideTenMinRedispatch(input({ chain: 5, maxChain: "5" })).reason, "STOP_CHAIN_CAP:5");
  assert.deepEqual([maxChainOf("500"), maxChainOf("x"), maxChainOf(undefined), maxChainOf("0")], [100, 24, 24, 0]);
  // A stop always wins over a guard window or a queue.
  assert.equal(
    decideTenMinRedispatch(input({ killSwitch: "false", nowUtc: at("05:30:00"), queue: { otherActiveRuns: 2 } })).nextAction,
    "stop",
  );
});

// ---- TENMIN_HISTORY_MAX_RANGE_END ----

const capOutcome = (rangesBeyondCap: number, ranges = [range("ALREADY_SEALED")], rangesPlanned = 1) =>
  tenMinRunOutcome(
    report({ ranges, rangesPlanned, rangeEndCap: { maxRangeEnd: "2024-12-31", rangesBeyondCap, reason: "RANGE_END_CAP" } }),
  );

test("range-end cap: every range up to the cap done stops with STOP_RANGE_END_CAP; the decision stops", () => {
  const atCap = capOutcome(10);
  assert.equal(atCap.nextAction, "stop");
  assert.equal(atCap.reason, "STOP_RANGE_END_CAP:2024-12-31");
  // Sealed in this run, still at the cap.
  assert.equal(capOutcome(10, [range("SEALED", { securitiesWritten: 5 })]).reason, "STOP_RANGE_END_CAP:2024-12-31");
  // Nothing held back by the cap: an ordinary STOP_DONE.
  assert.equal(capOutcome(0).reason, "STOP_DONE:no-range-left");
  // Ranges under the cap still open: the chain continues as before.
  const open = capOutcome(10, [range("PARTIAL", { securitiesWritten: 2 })]);
  assert.equal(open.nextAction, "continue");
  for (const trigger of ["chain", "fallback"] as const) {
    const decision = decideTenMinRedispatch(input({ trigger, outcome: atCap, currentMaxRangeEnd: "2024-12-31" }));
    assert.deepEqual([decision.dispatch, decision.nextAction, decision.reason], [false, "stop", "STOP_RANGE_END_CAP:2024-12-31"]);
  }
  // The chain itself never restarts past its own cap, even if the variable changed mid-run.
  assert.equal(decideTenMinRedispatch(input({ outcome: atCap, currentMaxRangeEnd: "2025-12-31" })).dispatch, false);
});

test("range-end cap: raising or clearing the variable restarts the chain from the fallback (variable change only)", () => {
  const atCap = capOutcome(10);
  const raised = decideTenMinRedispatch(input({ trigger: "fallback", outcome: atCap, chain: 7, currentMaxRangeEnd: "2025-12-31" }));
  assert.deepEqual(raised, {
    dispatch: true,
    nextAction: "continue",
    reason: "CONTINUE_RANGE_END_CAP_RAISED:2024-12-31->2025-12-31",
    nextChain: 1,
  });
  const cleared = decideTenMinRedispatch(input({ trigger: "fallback", outcome: atCap, chain: 7 }));
  assert.equal(cleared.reason, "CONTINUE_RANGE_END_CAP_RAISED:2024-12-31->none");
  // Lowered or unchanged: stays stopped. Kill switch, guard window and queue still apply.
  assert.equal(decideTenMinRedispatch(input({ trigger: "fallback", outcome: atCap, currentMaxRangeEnd: "2024-10-31" })).nextAction, "stop");
  assert.equal(decideTenMinRedispatch(input({ trigger: "fallback", outcome: atCap, killSwitch: "" })).reason, "KILL_SWITCH_OFF");
  assert.equal(
    decideTenMinRedispatch(input({ trigger: "fallback", outcome: atCap, currentMaxRangeEnd: "2025-12-31", nowUtc: at("05:30:00") })).reason,
    "WAIT_GUARD_WINDOW",
  );
  assert.equal(
    decideTenMinRedispatch(input({ trigger: "fallback", outcome: atCap, currentMaxRangeEnd: "2025-12-31", queue: { otherActiveRuns: 1 } })).nextAction,
    "wait",
  );
  assert.equal(
    decideTenMinRedispatch(input({ trigger: "fallback", outcome: atCap, currentMaxRangeEnd: "2025-12-31", jobResult: "failure" })).reason,
    "STOP_JOB_FAILURE",
  );
});

// ---- post-dispatch check ----

test("post-dispatch check: only a recent cancelled scheduled scanner.yml run fails the step", () => {
  const now = at("10:00:00");
  const run = (id: number, event: string, conclusion: string | null, created: string) => ({
    id,
    event,
    status: conclusion ? "completed" : "queued",
    conclusion,
    created_at: `2026-10-06T${created}Z`,
  });
  // A recent cancelled scheduled run.
  const recent = run(1, "schedule", "cancelled", "09:55:00");
  assert.equal(cancelledScheduledScan([run(9, "workflow_dispatch", null, "09:59:59"), recent], now), recent);
  assert.equal(cancelledScheduledScan([run(2, "schedule", "cancelled", "09:50:00")], now)?.id, 2, "exactly 10 minutes is inside");
  // An old one.
  assert.equal(cancelledScheduledScan([run(3, "schedule", "cancelled", "09:49:59")], now), undefined);
  // A cancelled non-schedule run.
  assert.equal(cancelledScheduledScan([run(4, "workflow_dispatch", "cancelled", "09:58:00")], now), undefined);
  // A recent scheduled run that is not cancelled (queued, success).
  assert.equal(
    cancelledScheduledScan([run(5, "schedule", null, "09:58:00"), run(6, "schedule", "success", "09:57:00")], now),
    undefined,
  );
  // None.
  assert.equal(cancelledScheduledScan([], now), undefined);
});


// ---- post-dispatch SCAN_CANCELLED: cancel dispatched run + hard stop record ----

const sampleContinueRecord = (): TenMinRunRecord => ({
  outcome: continueOutcome,
  jobResult: "success",
  chain: 2,
  githubRunId: "100",
  finishedAt: "2026-10-06T10:00:00.000Z",
  decision: {
    dispatch: true,
    nextAction: "continue",
    reason: "CONTINUE_TIME_BUDGET",
    nextChain: 3,
  },
});

const dispatchRun = (id: number, status: string, created: string, event = "workflow_dispatch") => ({
  id,
  event,
  status,
  conclusion: status === "completed" ? "success" : null,
  created_at: `2026-10-06T${created}Z`,
});

test("scan-cancelled stop record: chain-path cancel of a waiting run + stop record", () => {
  const record = sampleContinueRecord();
  const stopped = stopRecordForScanCancelled(record, 55, "2026-10-06T10:00:20.000Z");
  assert.equal(stopped.outcome?.nextAction, "stop");
  assert.equal(stopped.outcome?.reason, `${TENMIN_STOP_SCAN_CANCELLED}:run=55`);
  assert.deepEqual(stopped.decision, {
    dispatch: false,
    nextAction: "stop",
    reason: `${TENMIN_STOP_SCAN_CANCELLED}:run=55`,
    nextChain: 3,
  });
  assert.equal(stopped.finishedAt, "2026-10-06T10:00:20.000Z");
  // Original continue fields that identify the history run stay put.
  assert.equal(stopped.githubRunId, "100");
  assert.equal(stopped.chain, 2);
  assert.equal(stopped.jobResult, "success");
  // Waiting/queued/pending/requested/in_progress => cancel.
  for (const status of ["queued", "waiting", "pending", "requested", "in_progress"]) {
    assert.equal(isCancelableDispatchStatus(status), true, status);
    assert.deepEqual(planCancelDispatchedRun(dispatchRun(9, status, "10:00:05")), { action: "cancel", runId: 9 }, status);
  }
  const after = "2026-10-06T10:00:00.000Z";
  const found = findDispatchedTenMinRun(
    [dispatchRun(7, "queued", "09:59:00"), dispatchRun(8, "waiting", "10:00:01"), dispatchRun(100, "in_progress", "09:50:00", "schedule")],
    { afterIso: after, excludeRunId: 100 },
  );
  assert.equal(found?.id, 8);
  assert.deepEqual(planCancelDispatchedRun(found), { action: "cancel", runId: 8 });
});

test("scan-cancelled stop record: in_progress dispatched run gets the cancel plan; completed is skipped", () => {
  const stopped = stopRecordForScanCancelled(sampleContinueRecord(), 77, "2026-10-06T10:00:20.000Z");
  assert.equal(stopped.decision.reason, `${TENMIN_STOP_SCAN_CANCELLED}:run=77`);
  // Fallback path: the just-dispatched run is typically already in_progress — still cancel it.
  assert.equal(isCancelableDispatchStatus("in_progress"), true);
  assert.deepEqual(planCancelDispatchedRun(dispatchRun(12, "in_progress", "10:00:02")), {
    action: "cancel",
    runId: 12,
  });
  // Already-completed / missing: skip and report (do not cancel).
  assert.deepEqual(planCancelDispatchedRun(dispatchRun(13, "completed", "10:00:02")), {
    action: "none",
    detail: "status=completed:conclusion=success",
  });
  assert.deepEqual(planCancelDispatchedRun(undefined), { action: "none", detail: "dispatched-run-not-found" });
});

test("cancelled history step: chain decision is STOP_JOB_CANCELLED and never dispatches", () => {
  // When we cancel an in_progress tenmin_history run, its always() chain step sees
  // steps.history.outcome === "cancelled" and must stop (never re-dispatch).
  const cancelled = decideTenMinRedispatch(input({ jobResult: "cancelled", killSwitch: "true", chain: 4 }));
  assert.deepEqual(cancelled, {
    dispatch: false,
    nextAction: "stop",
    reason: "STOP_JOB_CANCELLED",
    nextChain: 5,
  });
  // Even with a continue outcome on disk, a cancelled history step wins.
  assert.equal(decideTenMinRedispatch(input({ jobResult: "cancelled", outcome: continueOutcome })).dispatch, false);
});

test("scan-cancelled stop record: fallback path writes stop; following decision stays stop even with a raised cap", () => {
  const stopped = stopRecordForScanCancelled(sampleContinueRecord(), 42, "2026-10-06T10:00:20.000Z");
  // What the next fallback would read from the uploaded artifact.
  const again = decideTenMinRedispatch(
    input({
      trigger: "fallback",
      outcome: stopped.outcome,
      jobResult: stopped.jobResult,
      chain: stopped.chain,
      currentMaxRangeEnd: "2099-12-31",
    }),
  );
  assert.deepEqual([again.dispatch, again.nextAction, again.reason], [false, "stop", `${TENMIN_STOP_SCAN_CANCELLED}:run=42`]);
  // Contrast: a real STOP_RANGE_END_CAP still restarts when the cap is raised.
  const atCap = capOutcome(10);
  assert.equal(
    decideTenMinRedispatch(input({ trigger: "fallback", outcome: atCap, currentMaxRangeEnd: "2025-12-31" })).reason,
    "CONTINUE_RANGE_END_CAP_RAISED:2024-12-31->2025-12-31",
  );
});

test("scan-cancelled: cancel API failure fails loudly; no cancelled scan is unchanged", () => {
  assert.throws(() => assertCancelRunAccepted(500, 99), /TENMIN_REDISPATCH_CANCEL_FAILED:run=99:http-500/);
  assert.throws(() => assertCancelRunAccepted(403, 99), /TENMIN_REDISPATCH_CANCEL_FAILED:run=99:http-403/);
  // 202 Accepted (and 204) are fine.
  assertCancelRunAccepted(202, 99);
  assertCancelRunAccepted(204, 99);
  // No cancelled scheduled scan => cancelledScheduledScan stays undefined (unchanged behavior).
  const now = at("10:00:00");
  assert.equal(
    cancelledScheduledScan(
      [
        dispatchRun(1, "queued", "09:59:50"),
        { id: 2, event: "schedule", status: "completed", conclusion: "success", created_at: "2026-10-06T09:58:00Z" },
      ],
      now,
    ),
    undefined,
  );
  // A continue record is left alone when there is nothing to stop for.
  const record = sampleContinueRecord();
  assert.equal(record.decision.nextAction, "continue");
  assert.equal(record.outcome?.nextAction, "continue");
});
