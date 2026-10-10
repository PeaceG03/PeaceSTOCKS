import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  TENMIN_HEAL_MARGIN_MINUTES,
  TENMIN_RESTARTER_CRON,
  TENMIN_RESTARTER_RUN_NAME,
  type TenMinRedispatchDecision,
  cancelledScheduledScan,
  countOtherActiveScannerRuns,
  decideTenMinRedispatch,
  healWaitSeconds,
  isTenMinRestarterRun,
  minutesUntilGuardWindowEnd,
  shouldDispatchHeal,
} from "./tenmin-redispatch";
import { planTenMinAlert } from "./tenmin-alert";

const at = (hhmmss: string) => new Date(`2026-10-06T${hhmmss}Z`);

test("heal wait: inside a window sleeps to its end + margin; in the lead sleeps through the window; else 0", () => {
  const cases: Array<[string, number | undefined]> = [
    ["05:04:59", undefined],
    ["05:05:00", 70], // 10 min lead + 60 min window
    ["05:14:00", 61],
    ["05:15:00", 60], // run 38021279274's chain yielded here (WAIT_GUARD_WINDOW)
    ["05:30:00", 45],
    ["06:14:00", 1],
    ["06:15:00", undefined],
    ["09:05:00", 70],
    ["09:15:00", 60],
    ["10:14:30", 0.5],
    ["10:15:00", undefined],
    ["19:47:00", undefined],
    ["00:00:00", undefined],
  ];
  for (const [time, minutes] of cases) assert.equal(minutesUntilGuardWindowEnd(at(time)), minutes, time);
  assert.equal(healWaitSeconds(at("05:15:00")), (60 + TENMIN_HEAL_MARGIN_MINUTES) * 60);
  assert.equal(healWaitSeconds(at("05:05:00")), (70 + TENMIN_HEAL_MARGIN_MINUTES) * 60);
  assert.equal(healWaitSeconds(at("12:00:00")), 0);
  // After sleeping healWaitSeconds the same decision rules allow a dispatch.
  for (const time of ["05:05:00", "05:15:00", "05:59:00", "09:10:00", "10:14:59"]) {
    const woke = new Date(at(time).getTime() + healWaitSeconds(at(time)) * 1000);
    assert.equal(minutesUntilGuardWindowEnd(woke), undefined, `${time} wakes outside every window`);
  }
});

test("heal dispatch: only on a guard-window wait; never on dispatch, stop, run-active or queue-check waits", () => {
  const d = (over: Partial<TenMinRedispatchDecision>): TenMinRedispatchDecision => ({
    dispatch: false,
    nextAction: "wait",
    reason: "WAIT_GUARD_WINDOW",
    nextChain: 4,
    ...over,
  });
  assert.equal(shouldDispatchHeal(d({})), true);
  assert.equal(shouldDispatchHeal(d({ reason: "WAIT_NEAR_GUARD_WINDOW" })), true);
  assert.equal(shouldDispatchHeal(d({ reason: "WAIT_RUN_ACTIVE:1" })), false);
  assert.equal(shouldDispatchHeal(d({ reason: "WAIT_QUEUE_CHECK_FAILED:http-500" })), false);
  assert.equal(shouldDispatchHeal(d({ nextAction: "stop", reason: "KILL_SWITCH_OFF" })), false);
  assert.equal(shouldDispatchHeal(d({ dispatch: true, nextAction: "continue", reason: "CONTINUE_YIELD:WAIT_GUARD_WINDOW" })), false);
  // The real chain decision at 05:15 with a clean yield is a heal case.
  const decision = decideTenMinRedispatch({
    trigger: "chain",
    outcome: {
      schemaVersion: "tenmin-history-outcome-v1",
      runId: "38021279274",
      nextAction: "continue",
      reason: "CONTINUE_YIELD:WAIT_GUARD_WINDOW",
      rangesPlanned: 1,
      rangesSealed: 0,
      rangesRemaining: 1,
      madeProgress: true,
    },
    jobResult: "success",
    nowUtc: at("05:15:10"),
    queue: { otherActiveRuns: 0 },
    killSwitch: "true",
    chain: 3,
    maxChain: undefined,
  });
  assert.equal(shouldDispatchHeal(decision), true);
});

test("restarter runs never count as active scan/history runs, nor as a cancelled scheduled scan", () => {
  const runs = [
    { id: 1, status: "in_progress", display_title: TENMIN_RESTARTER_RUN_NAME },
    { id: 2, status: "queued", display_title: "Scanner" },
    { id: 3, status: "in_progress", display_title: "Scanner" },
    { id: 4, status: "completed", display_title: "Scanner" },
    { id: 5, status: "waiting" },
  ];
  assert.equal(isTenMinRestarterRun(runs[0]!), true);
  assert.equal(isTenMinRestarterRun({ display_title: "Scanner" }), false);
  assert.equal(countOtherActiveScannerRuns(runs), 3);
  assert.equal(countOtherActiveScannerRuns(runs, 3), 2, "self excluded");
  assert.equal(countOtherActiveScannerRuns([runs[0]!], 99), 0, "only a restarter running: nothing active");
  const now = at("10:00:00");
  const cancelled = (id: number, display_title: string) => ({
    id,
    event: "schedule",
    status: "completed",
    conclusion: "cancelled",
    created_at: "2026-10-06T09:58:00Z",
    display_title,
  });
  assert.equal(cancelledScheduledScan([cancelled(7, TENMIN_RESTARTER_RUN_NAME)], now), undefined);
  assert.equal(cancelledScheduledScan([cancelled(7, TENMIN_RESTARTER_RUN_NAME), cancelled(8, "Scanner")], now)?.id, 8);
});

test("alert: a fallback stop seen only next to restarter runs still alerts (count excludes them)", () => {
  const otherActiveRuns = countOtherActiveScannerRuns([{ id: 10, status: "in_progress", display_title: TENMIN_RESTARTER_RUN_NAME }], 10);
  const plan = planTenMinAlert({ trigger: "fallback", record: undefined, redispatchStep: "success", nextAction: "stop", reason: "STOP_NO_OUTCOME", killSwitch: "true", otherActiveRuns });
  assert.equal(plan.action, "alert");
});

test("workflows: scanner.yml restarter cron, run-name, scan gate, concurrency, and the restarter job agree", () => {
  const scanner = readFileSync(new URL("../.github/workflows/scanner.yml", import.meta.url), "utf8");
  const cron = TENMIN_RESTARTER_CRON;
  assert.ok(scanner.includes(`    - cron: "${cron}"`), "cron in on.schedule");
  assert.ok(scanner.includes(`run-name: \${{ github.event.schedule == '${cron}' && '${TENMIN_RESTARTER_RUN_NAME}' || 'Scanner' }}`));
  assert.ok(
    scanner.includes(`group: \${{ github.event.schedule == '${cron}' && format('scanner-restarter-{0}', github.run_id) || 'peacestocks-r2-writer' }}`),
    "restarter runs never join peacestocks-r2-writer",
  );
  assert.ok(
    scanner.includes(`if: \${{ (github.event_name == 'schedule' && github.event.schedule != '${cron}') || github.event.inputs.mode == 'scan' }}`),
    "scan skips the restarter cron",
  );
  const job = scanner.slice(scanner.indexOf("\n  restarter:\n"), scanner.indexOf("\n  backfill:\n"));
  assert.ok(job.includes(`if: \${{ github.event_name == 'schedule' && github.event.schedule == '${cron}' }}`));
  assert.ok(job.includes("uses: ./.github/workflows/tenmin-history-fallback.yml"));
  for (const p of ["contents: read", "actions: write", "issues: write"]) assert.ok(job.includes(p), p);
  // Every other cron is a scan cron (05:30 / 09:30) and none sits on :00.
  const crons = [...scanner.matchAll(/- cron: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(crons, ["30 5 * * 2-6", "30 9 * * 2-6", cron]);

  const fallback = readFileSync(new URL("../.github/workflows/tenmin-history-fallback.yml", import.meta.url), "utf8");
  assert.ok(fallback.includes("\n  workflow_call:\n"));
  assert.ok(fallback.includes("wait_for_guard_window_end"));
  assert.ok(!fallback.includes("peacestocks-r2-writer\n  cancel"), "fallback never joins the writer group");
  assert.ok(!/^concurrency:/m.test(fallback), "no workflow-level concurrency: guard_wait must not hold a group");
});
