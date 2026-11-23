import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryObjectClient } from "./object-store";
import { tenMinHistoryDailyStepHold } from "./tenmin-daily-liquid";
import { runTenMinHistory } from "./tenmin-history";
import { planTenMinAlert } from "./tenmin-alert";
import {
  TENMIN_CONTINUE_DAILY_STEP_RAN,
  TENMIN_WAIT_DAILY_STEP,
  type TenMinRedispatchInput,
  decideTenMinRedispatch,
  tenMinDailyRunSince,
  tenMinRunOutcome,
} from "./tenmin-redispatch";

const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";

async function heldRun(hold: string | undefined) {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-hold-"));
  let requests = 0;
  try {
    const result = await runTenMinHistory({
      root,
      store: new MemoryObjectClient(),
      securities: [],
      loadDailyBarSessions: async () => new Map(),
      lastCompletedSession: "2026-10-09",
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      maxRanges: 0,
      fetchPages: async () => {
        requests += 1;
        throw new Error("no request expected");
      },
      fetchGroupedDaily: async () => {
        requests += 1;
        throw new Error("no request expected");
      },
      dailyStepHold: async () => hold,
    });
    return { result, requests };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("history run: a held day stops the run before any Massive request and names the day", async () => {
  const { result, requests } = await heldRun("2026-10-08");
  assert.equal(requests, 0);
  assert.equal(result.report.dailyStepHold, "2026-10-08");
  assert.equal(result.report.massiveRequests, 0);
  assert.ok(result.report.rangesPlanned > 0, "the real plan is kept so the chain is never read as finished");
  const outcome = tenMinRunOutcome(result.report);
  assert.equal(outcome.reason, `${TENMIN_WAIT_DAILY_STEP}:2026-10-08`);
  assert.equal(outcome.nextAction, "stop", "never 'continue': that would re-dispatch at once and spend the chain");
});

test("history run: no hold, the run goes on as before", async () => {
  const { result } = await heldRun(undefined);
  assert.equal(result.report.dailyStepHold, undefined);
});

function input(extra: Partial<TenMinRedispatchInput>): TenMinRedispatchInput {
  return {
    trigger: "chain",
    outcome: {
      schemaVersion: "tenmin-history-outcome-v1",
      runId: "r",
      nextAction: "stop",
      reason: `${TENMIN_WAIT_DAILY_STEP}:2026-10-08`,
      rangesPlanned: 12,
      rangesSealed: 0,
      rangesRemaining: 12,
      madeProgress: false,
    },
    jobResult: "success",
    nowUtc: new Date("2026-10-13T12:00:00Z"),
    queue: { otherActiveRuns: 0 },
    killSwitch: "true",
    chain: 3,
    maxChain: undefined,
    ...extra,
  };
}

test("decision: a held chain waits (no alert); the fallback restarts it only after a daily step ran", () => {
  const chain = decideTenMinRedispatch(input({}));
  assert.deepEqual([chain.dispatch, chain.nextAction, chain.reason], [false, "wait", `${TENMIN_WAIT_DAILY_STEP}:2026-10-08`]);
  assert.equal(planTenMinAlert({ trigger: "chain", record: undefined, historyStep: "success", redispatchStep: "success", nextAction: chain.nextAction, reason: chain.reason, killSwitch: "true" }).action, "none");
  const idle = decideTenMinRedispatch(input({ trigger: "fallback" }));
  assert.deepEqual([idle.dispatch, idle.nextAction], [false, "wait"]);
  const after = decideTenMinRedispatch(input({ trigger: "fallback", dailyStepRanSince: "777" }));
  assert.deepEqual([after.dispatch, after.nextAction, after.reason], [true, "continue", `${TENMIN_CONTINUE_DAILY_STEP_RAN}:777`]);
  const guard = decideTenMinRedispatch(input({ trigger: "fallback", dailyStepRanSince: "777", nowUtc: new Date("2026-10-13T05:30:00Z") }));
  assert.equal(guard.dispatch, false, "guard windows still win");
  assert.equal(decideTenMinRedispatch(input({ trigger: "fallback", dailyStepRanSince: "777", killSwitch: "false" })).nextAction, "stop");
});

test("fallback: only a completed 'Scanner tenmin daily' run created after the held run counts", () => {
  const since = "2026-10-13T03:00:00Z";
  const runs = [
    { id: 1, status: "completed", created_at: "2026-10-13T02:00:00Z", display_title: "Scanner tenmin daily" },
    { id: 2, status: "in_progress", created_at: "2026-10-13T06:20:00Z", display_title: "Scanner tenmin daily" },
    { id: 3, status: "completed", created_at: "2026-10-13T06:21:00Z", display_title: "Scanner tenmin daily (off)" },
    { id: 4, status: "completed", created_at: "2026-10-13T05:30:00Z", display_title: "Scanner" },
  ];
  assert.equal(tenMinDailyRunSince(runs, since), undefined);
  assert.equal(tenMinDailyRunSince([...runs, { id: 5, status: "completed", created_at: "2026-10-13T10:20:00Z", display_title: "Scanner tenmin daily" }], since)?.id, 5);
});

test("host wiring: the hold is on only with the daily step on and R2 configured", async () => {
  assert.deepEqual(tenMinHistoryDailyStepHold({}), {});
  assert.deepEqual(tenMinHistoryDailyStepHold({ TENMIN_DAILY_ENABLED: "true" }), {});
  assert.deepEqual(tenMinHistoryDailyStepHold({ PEACESTOCKS_R2_BUCKET: "b" }), {});
  const on = tenMinHistoryDailyStepHold({ TENMIN_DAILY_ENABLED: "true", PEACESTOCKS_R2_BUCKET: "b" }, () => new MemoryObjectClient());
  assert.equal(typeof on.dailyStepHold, "function");
  assert.equal(await on.dailyStepHold!(), undefined, "an empty store holds nothing");
  const host = await readFile(new URL("./host.ts", import.meta.url), "utf8");
  assert.match(host, /runTenMinHistoryFromEnv\(process\.env, tenMinHistoryDailyStepHold\(process\.env\)\)/u);
  const workflow = await readFile(new URL("../.github/workflows/scanner.yml", import.meta.url), "utf8");
  const job = workflow.slice(workflow.indexOf("\n  tenmin_history:"), workflow.indexOf("\n    steps:", workflow.indexOf("\n  tenmin_history:")));
  assert.match(job, /TENMIN_DAILY_ENABLED: \$\{\{ vars\.TENMIN_DAILY_ENABLED \}\}/u);
});
