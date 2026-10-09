// Auto re-dispatch for tenmin_history. Two triggers share one pure decision:
// - chain: the last step of a tenmin_history run dispatches the next run;
// - fallback: a separate scheduled workflow (tenmin-history-fallback.yml) restarts a chain that a
//   guard window, a queued run, or a lost pending run broke.
// Dispatched runs are ordinary scanner.yml workflow_dispatch runs (mode tenmin_history), so they
// stay in the peacestocks-r2-writer concurrency group and keep the in-run scanYieldReason.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCAN_GUARD_WINDOWS_UTC } from "./scan-yield";
import type { DatedTickerRunSummary } from "./ticker-reference-dated";
import {
  type TenMinHistoryRunReport,
  type TenMinRangeRemaining,
  parseTenMinMaxRangeEnd,
} from "./tenmin-history";

export const TENMIN_OUTCOME_SCHEMA = "tenmin-history-outcome-v1" as const;
/** Don't start a run this close before a guard window: a pending run could start inside it. */
export const TENMIN_REDISPATCH_LEAD_MINUTES = 10;
/** Default and hard ceiling for runs in one chain without a human (repo variable may lower it). */
export const TENMIN_REDISPATCH_DEFAULT_MAX_CHAIN = 24;
export const TENMIN_REDISPATCH_HARD_MAX_CHAIN = 100;
/** Outcome/decision reason prefix: every range up to TENMIN_HISTORY_MAX_RANGE_END is done. */
export const TENMIN_STOP_RANGE_END_CAP = "STOP_RANGE_END_CAP" as const;
/** Post-dispatch: a scheduled scanner.yml run created this recently and cancelled fails the step. */
export const TENMIN_SCAN_CANCELLED_WINDOW_MINUTES = 10;
export const TENMIN_REDISPATCH_SCAN_CANCELLED = "TENMIN_REDISPATCH_SCAN_CANCELLED" as const;
/** Hard stop written into the run record when a post-dispatch cancelled-scan check fires. */
export const TENMIN_STOP_SCAN_CANCELLED = "STOP_SCAN_CANCELLED" as const;
/** Dispatched tenmin_history run statuses that must be cancelled on SCAN_CANCELLED (incl. in_progress). */
export const TENMIN_CANCELABLE_DISPATCH_STATUSES = new Set([
  "queued",
  "waiting",
  "pending",
  "requested",
  "in_progress",
]);

/** Error codes that are refusals: the plan is wrong, a human must look. */
export const TENMIN_REFUSAL_CODES = [
  "TENMIN_DAILY_COVERAGE_HOLE",
  "TENMIN_UNIVERSE_EMPTY",
  "TENMIN_UNIVERSE_TOO_SMALL",
] as const;

export interface TenMinRunOutcome {
  schemaVersion: typeof TENMIN_OUTCOME_SCHEMA;
  runId: string;
  /** What this run's result says about the next run. */
  nextAction: "continue" | "stop";
  reason: string;
  rangesPlanned: number;
  rangesSealed: number;
  rangesRemaining: number;
  madeProgress: boolean;
  /** Seal progress for the range this run worked (tolerated when absent on older records). */
  rangeRemaining?: TenMinRangeRemaining;
  /**
   * Dated ticker-index work this run (FULL mode only; absent on older records or when the phase
   * was off). Counts toward madeProgress: see tenMinDatedIndexMadeProgress.
   */
  datedTickerIndexProgress?: { sealed: number; pagesStored: number; requests: number };
}

const SEALED = new Set(["SEALED", "ALREADY_SEALED", "REOPENED"]);

/**
 * Pure: did the dated ticker-index phase do work that stuck this run? FULL mode only: a month
 * SEALED this run (ALREADY_SEALED does not count) or dated-list pages stored (pagesStored > 0).
 * Raw requests never count: a month that keeps coming out FAILED/CORRUPT after fetching would
 * otherwise keep the chain spending Massive requests forever. PROBE mode never counts.
 */
export function tenMinDatedIndexMadeProgress(summary: DatedTickerRunSummary | undefined): boolean {
  if (!summary || summary.mode !== "full") return false;
  return summary.sealed > 0 || (summary.pagesStored ?? 0) > 0;
}

/**
 * Pure: classify a finished run. Continue only on a clean partial (time budget, scan yield, or
 * ranges left after a clean stop); stop on any refusal or error, an outage stop, a bounded manual
 * run (reopen or maxRanges), a time-budget stop with no progress, or nothing left to fetch.
 */
export function tenMinRunOutcome(report: TenMinHistoryRunReport): TenMinRunOutcome {
  const rangesSealed = report.ranges.filter((r) => SEALED.has(r.status)).length;
  // A yield in the dated ticker-index phase returns before any range is looked at: the run is
  // unfinished, never "no range left". Older reports from that path had rangesPlanned 0 and no
  // yieldedInPhase; recognize them by a dated-phase yield with no ranges attempted.
  const earlyPhaseYield =
    !!report.yieldedForScan &&
    report.ranges.length === 0 &&
    (report.yieldedInPhase === "dated_ticker_index" || !!report.datedTickerIndex?.yieldedForScan);
  // At least 1 so the decision step's no-range-left stop cannot fire; the next run replans.
  const rangesRemaining = earlyPhaseYield
    ? Math.max(1, report.rangesPlanned - rangesSealed)
    : Math.max(0, report.rangesPlanned - rangesSealed);
  const rangeProgress = report.ranges.some(
    (r) =>
      r.status === "SEALED" ||
      r.status === "REOPENED" ||
      r.securitiesWritten > 0 ||
      (r.groupedDailyStored ?? 0) > 0,
  );
  // A run that spends its budget sealing dated ticker indexes (0 range fetches) still advanced
  // the chain; without this, run 37526098534 (24/24 SEALED, 301 requests) stranded it.
  const indexProgress = tenMinDatedIndexMadeProgress(report.datedTickerIndex);
  const madeProgress = rangeProgress || indexProgress;
  const dated = report.datedTickerIndex;
  const out = (nextAction: TenMinRunOutcome["nextAction"], reason: string): TenMinRunOutcome => ({
    schemaVersion: TENMIN_OUTCOME_SCHEMA,
    runId: report.runId,
    nextAction,
    reason,
    rangesPlanned: report.rangesPlanned,
    rangesSealed,
    rangesRemaining,
    madeProgress,
    ...(report.rangeRemaining ? { rangeRemaining: report.rangeRemaining } : {}),
    ...(dated && dated.mode === "full"
      ? {
          datedTickerIndexProgress: {
            sealed: dated.sealed,
            pagesStored: dated.pagesStored ?? 0,
            requests: dated.requests,
          },
        }
      : {}),
  });
  if (report.stoppedOnError || report.error) {
    const message = report.error ?? "UNKNOWN";
    const refusal = TENMIN_REFUSAL_CODES.find((code) => message.includes(code));
    return out("stop", refusal ? `STOP_REFUSAL:${refusal}` : `STOP_ERROR:${message.slice(0, 160)}`);
  }
  if (report.outageStop) return out("stop", `STOP_OUTAGE:${report.outageStop.slice(0, 160)}`);
  if (report.reopen) return out("stop", "STOP_BOUNDED_MANUAL_RUN:reopen");
  if (report.maxRanges !== undefined) return out("stop", `STOP_BOUNDED_MANUAL_RUN:maxRanges=${report.maxRanges}`);
  if (!earlyPhaseYield && rangesRemaining === 0 && report.rangeEndCap && report.rangeEndCap.rangesBeyondCap > 0)
    return out("stop", `${TENMIN_STOP_RANGE_END_CAP}:${report.rangeEndCap.maxRangeEnd}`);
  if (!earlyPhaseYield && rangesRemaining === 0) return out("stop", "STOP_DONE:no-range-left");
  const yielded = report.yieldedForScan;
  if (yielded?.startsWith("TIME_BUDGET")) {
    return madeProgress ? out("continue", "CONTINUE_TIME_BUDGET") : out("stop", "STOP_NO_PROGRESS:TIME_BUDGET");
  }
  if (yielded) return out("continue", `CONTINUE_YIELD:${yielded.split(":")[0]}`);
  return out("continue", "CONTINUE_RANGES_LEFT");
}

/** Minutes until the next guard window starts, and whether now is inside one. */
export function guardWindowState(nowUtc: Date): { inside: boolean; minutesUntilNext: number } {
  const minute = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes() + nowUtc.getUTCSeconds() / 60;
  let inside = false;
  let until = Number.POSITIVE_INFINITY;
  for (const [start, end] of SCAN_GUARD_WINDOWS_UTC) {
    if (minute >= start && minute < end) inside = true;
    const delta = (start - minute + 1440) % 1440;
    until = Math.min(until, delta);
  }
  return { inside, minutesUntilNext: until };
}

export interface TenMinRedispatchInput {
  trigger: "chain" | "fallback";
  /** The last finished tenmin_history run's outcome (chain: this run's; fallback: newest stored). */
  outcome: TenMinRunOutcome | undefined;
  /** That run's history step result. */
  jobResult: string;
  nowUtc: Date;
  /** Other scanner.yml runs queued/waiting/pending/in progress (own run excluded). */
  queue: { otherActiveRuns: number; checkFailed?: string };
  /** Repo variable TENMIN_AUTO_REDISPATCH; must be exactly "true". */
  killSwitch: string | undefined;
  /** Runs already in this chain (the finished run's number; a manual dispatch is 0). */
  chain: number;
  /** Repo variable TENMIN_AUTO_REDISPATCH_MAX_CHAIN (default 24, capped at 100). */
  maxChain: string | number | undefined;
  /** fallback: a scanner.yml dispatch newer than the outcome ended failure/timed_out. */
  newerFailedRun?: string;
  /**
   * fallback: today's TENMIN_HISTORY_MAX_RANGE_END (parsed; undefined = no cap). A run that stopped
   * at an older, lower cap restarts the chain when the variable is raised or cleared.
   */
  currentMaxRangeEnd?: string;
}

export interface TenMinRedispatchDecision {
  dispatch: boolean;
  /** continue: dispatching now; wait: chain intact, not now (fallback may pick it up); stop: chain over. */
  nextAction: "continue" | "wait" | "stop";
  reason: string;
  nextChain: number;
}

export function maxChainOf(value: string | number | undefined): number {
  const n = typeof value === "number" ? value : value ? Number(value) : TENMIN_REDISPATCH_DEFAULT_MAX_CHAIN;
  if (!Number.isSafeInteger(n) || n < 0) return TENMIN_REDISPATCH_DEFAULT_MAX_CHAIN;
  return Math.min(n, TENMIN_REDISPATCH_HARD_MAX_CHAIN);
}

/** Pure decision: dispatch the next tenmin_history run now, wait, or stop the chain. */
export function decideTenMinRedispatch(input: TenMinRedispatchInput): TenMinRedispatchDecision {
  const nextChain = input.chain + 1;
  const stop = (reason: string): TenMinRedispatchDecision => ({ dispatch: false, nextAction: "stop", reason, nextChain });
  const wait = (reason: string): TenMinRedispatchDecision => ({ dispatch: false, nextAction: "wait", reason, nextChain });
  if (input.killSwitch !== "true") return stop("KILL_SWITCH_OFF");
  if (!input.outcome) return stop("STOP_NO_OUTCOME");
  const capRaised = rangeEndCapRaised(input);
  if (input.outcome.nextAction !== "continue" && !capRaised) return stop(input.outcome.reason);
  if (input.jobResult !== "success") return stop(`STOP_JOB_${input.jobResult.toUpperCase() || "UNKNOWN"}`);
  if (input.newerFailedRun) return stop(`STOP_NEWER_RUN_FAILED:${input.newerFailedRun}`);
  if (input.outcome.rangesRemaining <= 0 && !capRaised) return stop("STOP_DONE:no-range-left");
  const maxChain = maxChainOf(input.maxChain);
  // Raising the cap is a human action: the restarted chain counts from 1 again.
  const chainNext = capRaised ? 1 : nextChain;
  if (chainNext > maxChain) return stop(`STOP_CHAIN_CAP:${maxChain}`);
  if (capRaised) {
    const reason = `CONTINUE_RANGE_END_CAP_RAISED:${capRaised.from}->${capRaised.to}`;
    const gate = queueAndGuard(input);
    return gate
      ? { dispatch: false, nextAction: "wait", reason: gate, nextChain: chainNext }
      : { dispatch: true, nextAction: "continue", reason, nextChain: chainNext };
  }
  const gate = queueAndGuard(input);
  if (gate) return wait(gate);
  return { dispatch: true, nextAction: "continue", reason: input.outcome.reason, nextChain };
}

function queueAndGuard(input: TenMinRedispatchInput): string | undefined {
  if (input.queue.checkFailed) return `WAIT_QUEUE_CHECK_FAILED:${input.queue.checkFailed}`;
  if (input.queue.otherActiveRuns > 0) return `WAIT_RUN_ACTIVE:${input.queue.otherActiveRuns}`;
  const guard = guardWindowState(input.nowUtc);
  if (guard.inside) return "WAIT_GUARD_WINDOW";
  if (guard.minutesUntilNext <= TENMIN_REDISPATCH_LEAD_MINUTES) return "WAIT_NEAR_GUARD_WINDOW";
  return undefined;
}

/** fallback only: the outcome stopped at a range-end cap lower than today's (or today has none). */
function rangeEndCapRaised(input: TenMinRedispatchInput): { from: string; to: string } | undefined {
  if (input.trigger !== "fallback" || !input.outcome) return undefined;
  const prefix = `${TENMIN_STOP_RANGE_END_CAP}:`;
  if (!input.outcome.reason.startsWith(prefix)) return undefined;
  const from = input.outcome.reason.slice(prefix.length);
  const to = input.currentMaxRangeEnd;
  if (to !== undefined && to <= from) return undefined;
  return { from, to: to ?? "none" };
}

export interface ScannerRunSummary {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
}

/**
 * Pure post-dispatch check: a scanner.yml run with event "schedule", created within the last
 * TENMIN_SCAN_CANCELLED_WINDOW_MINUTES of nowUtc, that ended "cancelled" (e.g. a pending scan the
 * dispatched run displaced in the concurrency group). Returns the first such run, else undefined.
 */
export function cancelledScheduledScan(
  runs: readonly ScannerRunSummary[],
  nowUtc: Date,
  windowMinutes: number = TENMIN_SCAN_CANCELLED_WINDOW_MINUTES,
): ScannerRunSummary | undefined {
  const since = nowUtc.getTime() - windowMinutes * 60_000;
  return runs.find((run) => {
    const created = Date.parse(run.created_at);
    return run.event === "schedule" && run.conclusion === "cancelled" && Number.isFinite(created) && created >= since;
  });
}

/** Pure: statuses where the just-dispatched tenmin_history run may still be cancelled. */
export function isCancelableDispatchStatus(status: string): boolean {
  return TENMIN_CANCELABLE_DISPATCH_STATUSES.has(status);
}

/**
 * Pure: newest workflow_dispatch scanner.yml run created at/after afterIso, excluding excludeRunId.
 * Used to find the tenmin_history run a dispatch just created (GitHub's dispatch API returns no id).
 */
export function findDispatchedTenMinRun(
  runs: readonly ScannerRunSummary[],
  opts: { afterIso: string; excludeRunId?: number },
): ScannerRunSummary | undefined {
  const afterMs = Date.parse(opts.afterIso);
  if (!Number.isFinite(afterMs)) return undefined;
  // 2s slack: clock skew between the local stamp and GitHub's created_at.
  const since = afterMs - 2000;
  let best: ScannerRunSummary | undefined;
  for (const run of runs) {
    if (run.event !== "workflow_dispatch") continue;
    if (opts.excludeRunId !== undefined && run.id === opts.excludeRunId) continue;
    const created = Date.parse(run.created_at);
    if (!Number.isFinite(created) || created < since) continue;
    if (!best) {
      best = run;
      continue;
    }
    const bestCreated = Date.parse(best.created_at);
    if (created > bestCreated || (created === bestCreated && run.id > best.id)) best = run;
  }
  return best;
}

export type DispatchedRunCancelPlan =
  | { action: "cancel"; runId: number }
  | { action: "none"; detail: string };

/**
 * Pure: cancel the dispatched run while it is still active (queued/waiting/pending/requested/
 * in_progress). Cancelling in_progress is safe: its always() chain step sees the history step
 * cancelled, records STOP_JOB_CANCELLED, and uploads a stop (never dispatches). Already-completed
 * runs are skipped and reported.
 */
export function planCancelDispatchedRun(run: ScannerRunSummary | undefined): DispatchedRunCancelPlan {
  if (!run) return { action: "none", detail: "dispatched-run-not-found" };
  if (isCancelableDispatchStatus(run.status)) return { action: "cancel", runId: run.id };
  return { action: "none", detail: `status=${run.status}:conclusion=${run.conclusion ?? "none"}` };
}

/** The record the chain step stores as the run's artifact (read by the fallback). */
export interface TenMinRunRecord {
  outcome: TenMinRunOutcome | undefined;
  jobResult: string;
  chain: number;
  githubRunId: string;
  finishedAt: string;
  decision: TenMinRedispatchDecision;
}

/**
 * Pure: rewrite a run record into a hard stop so the fallback never restarts this chain
 * (not even via CONTINUE_RANGE_END_CAP_RAISED; only a new manual unbounded dispatch restarts).
 */
export function stopRecordForScanCancelled(
  record: TenMinRunRecord,
  scanRunId: number | string,
  finishedAt: string,
): TenMinRunRecord {
  const reason = `${TENMIN_STOP_SCAN_CANCELLED}:run=${scanRunId}`;
  const outcome: TenMinRunOutcome = record.outcome
    ? { ...record.outcome, nextAction: "stop", reason }
    : {
        schemaVersion: TENMIN_OUTCOME_SCHEMA,
        runId: record.githubRunId || "unknown",
        nextAction: "stop",
        reason,
        rangesPlanned: 0,
        rangesSealed: 0,
        rangesRemaining: 0,
        madeProgress: false,
      };
  return {
    ...record,
    outcome,
    finishedAt,
    decision: {
      dispatch: false,
      nextAction: "stop",
      reason,
      nextChain: record.decision.nextChain,
    },
  };
}

/** Pure: GitHub's cancel-run API accepts 202; anything else is a loud failure. */
export function assertCancelRunAccepted(httpStatus: number, runId: number): void {
  if (httpStatus !== 202 && httpStatus !== 204) {
    throw new Error(`TENMIN_REDISPATCH_CANCEL_FAILED:run=${runId}:http-${httpStatus}`);
  }
}

// ---- CLI (thin I/O around the pure functions) ----

const ACTIVE = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

interface Run {
  id: number;
  status: string;
  conclusion: string | null;
  event: string;
  created_at: string;
}

async function gh(path: string, init: RequestInit = {}): Promise<Response> {
  const env = process.env;
  const api = env.GITHUB_API_URL ?? "https://api.github.com";
  return fetch(`${api}/repos/${env.GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
}

async function scannerRuns(): Promise<{ runs: Run[]; checkFailed?: string }> {
  try {
    const response = await gh(`/actions/workflows/scanner.yml/runs?per_page=30`);
    if (!response.ok) return { runs: [], checkFailed: `http-${response.status}` };
    const body = (await response.json()) as { workflow_runs?: Run[] };
    return { runs: body.workflow_runs ?? [] };
  } catch (error) {
    return { runs: [], checkFailed: String(error).slice(0, 80) };
  }
}

function output(name: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value.replaceAll("\n", " ")}\n`);
}

/**
 * After a dispatch: wait, list scanner.yml runs, and if a recent scheduled scan was cancelled:
 * rewrite the run record to STOP_SCAN_CANCELLED (so the fallback never restarts), cancel the
 * just-dispatched tenmin_history run while it is still queued/waiting/pending/requested/in_progress
 * (skip and report if it already completed), then fail the step. Cancel API failure fails loudly.
 * Cancelling in_progress is safe: that run's always() chain step records STOP_JOB_CANCELLED.
 */
async function checkNoScheduledScanCancelled(opts: {
  record: TenMinRunRecord;
  recordFile: string | undefined;
  dispatchedAfterIso: string;
  excludeRunId?: number;
}): Promise<void> {
  const delayMs = Number(process.env.TENMIN_POST_DISPATCH_CHECK_DELAY_MS ?? "15000");
  if (Number.isFinite(delayMs) && delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
  const { runs, checkFailed } = await scannerRuns();
  if (checkFailed) throw new Error(`${TENMIN_REDISPATCH_SCAN_CANCELLED}:check-failed:${checkFailed}`);
  const cancelled = cancelledScheduledScan(runs, new Date());
  if (!cancelled) {
    process.stdout.write(
      `${JSON.stringify({ mode: "tenmin-redispatch", postDispatchCheck: "OK", runsListed: runs.length })}\n`,
    );
    return;
  }
  const finishedAt = new Date().toISOString();
  const stopRecord = stopRecordForScanCancelled(opts.record, cancelled.id, finishedAt);
  if (opts.recordFile) writeFileSync(opts.recordFile, `${JSON.stringify(stopRecord, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      mode: "tenmin-redispatch",
      postDispatchCheck: TENMIN_REDISPATCH_SCAN_CANCELLED,
      scanRunId: cancelled.id,
      stopReason: stopRecord.decision.reason,
    })}\n`,
  );
  const dispatched = findDispatchedTenMinRun(runs, {
    afterIso: opts.dispatchedAfterIso,
    ...(opts.excludeRunId !== undefined ? { excludeRunId: opts.excludeRunId } : {}),
  });
  const plan = planCancelDispatchedRun(dispatched);
  if (plan.action === "cancel") {
    const response = await gh(`/actions/runs/${plan.runId}/cancel`, { method: "POST" });
    assertCancelRunAccepted(response.status, plan.runId);
    process.stdout.write(
      `${JSON.stringify({ mode: "tenmin-redispatch", cancelledDispatchedRun: plan.runId, status: dispatched?.status })}\n`,
    );
  } else {
    process.stdout.write(
      `${JSON.stringify({ mode: "tenmin-redispatch", dispatchedRunCancelSkipped: plan.detail })}\n`,
    );
  }
  throw new Error(`${TENMIN_REDISPATCH_SCAN_CANCELLED}:run=${cancelled.id}:created=${cancelled.created_at}`);
}

async function dispatch(chain: number): Promise<void> {
  const ref = process.env.TENMIN_DISPATCH_REF || process.env.GITHUB_REF_NAME || "main";
  if (process.env.TENMIN_REDISPATCH_DRY_RUN === "1") {
    process.stdout.write(`DRY_RUN: would dispatch scanner.yml ref=${ref} chain=${chain}\n`);
    return;
  }
  const response = await gh(`/actions/workflows/scanner.yml/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref, inputs: { mode: "tenmin_history", tenmin_history_chain: String(chain) } }),
  });
  if (response.status !== 204) throw new Error(`TENMIN_REDISPATCH_FAILED:http-${response.status}`);
}

function readJson<T>(path: string | undefined): T | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function main(mode: string | undefined): Promise<void> {
  const env = process.env;
  const now = new Date();
  if (mode === "chain") {
    const outcome = readJson<TenMinRunOutcome>(env.TENMIN_OUTCOME_FILE);
    const chain = Number(env.TENMIN_CHAIN || "0") || 0;
    const { runs, checkFailed } = await scannerRuns();
    const self = Number(env.GITHUB_RUN_ID);
    const decision = decideTenMinRedispatch({
      trigger: "chain",
      outcome,
      jobResult: env.TENMIN_STEP_OUTCOME ?? "unknown",
      nowUtc: now,
      queue: {
        otherActiveRuns: runs.filter((r) => r.id !== self && ACTIVE.has(r.status)).length,
        ...(checkFailed ? { checkFailed } : {}),
      },
      killSwitch: env.TENMIN_AUTO_REDISPATCH,
      chain,
      maxChain: env.TENMIN_AUTO_REDISPATCH_MAX_CHAIN,
    });
    const record: TenMinRunRecord = {
      outcome,
      jobResult: env.TENMIN_STEP_OUTCOME ?? "unknown",
      chain,
      githubRunId: env.GITHUB_RUN_ID ?? "",
      finishedAt: now.toISOString(),
      decision,
    };
    if (env.TENMIN_RECORD_FILE) writeFileSync(env.TENMIN_RECORD_FILE, `${JSON.stringify(record, null, 2)}\n`);
    output("next_action", decision.nextAction);
    output("reason", decision.reason);
    process.stdout.write(`${JSON.stringify({ mode: "tenmin-redispatch", trigger: "chain", ...decision })}\n`);
    if (decision.dispatch) {
      const dispatchedAfterIso = new Date().toISOString();
      await dispatch(decision.nextChain);
      await checkNoScheduledScanCancelled({
        record,
        recordFile: env.TENMIN_RECORD_FILE,
        dispatchedAfterIso,
        ...(Number.isFinite(self) ? { excludeRunId: self } : {}),
      });
    }
    return;
  }
  if (mode === "fallback") {
    // Invalid cap fails the fallback loudly (same rule as the history run).
    const currentMaxRangeEnd = parseTenMinMaxRangeEnd(env.TENMIN_HISTORY_MAX_RANGE_END);
    const record = readJson<TenMinRunRecord>(env.TENMIN_RECORD_FILE);
    const { runs, checkFailed } = await scannerRuns();
    const recordRun = runs.find((r) => String(r.id) === record?.githubRunId);
    const newerFailed = record
      ? runs.find(
          (r) =>
            r.event === "workflow_dispatch" &&
            r.id !== Number(record.githubRunId) &&
            r.created_at > (recordRun?.created_at ?? record.finishedAt) &&
            r.conclusion !== null &&
            FAILED.has(r.conclusion),
        )
      : undefined;
    const decision = decideTenMinRedispatch({
      trigger: "fallback",
      outcome: record?.outcome,
      jobResult: record?.jobResult ?? "unknown",
      nowUtc: now,
      queue: { otherActiveRuns: runs.filter((r) => ACTIVE.has(r.status)).length, ...(checkFailed ? { checkFailed } : {}) },
      killSwitch: env.TENMIN_AUTO_REDISPATCH,
      chain: record?.chain ?? 0,
      maxChain: env.TENMIN_AUTO_REDISPATCH_MAX_CHAIN,
      ...(newerFailed ? { newerFailedRun: `${newerFailed.id}:${newerFailed.conclusion}` } : {}),
      ...(currentMaxRangeEnd ? { currentMaxRangeEnd } : {}),
    });
    output("next_action", decision.nextAction);
    output("reason", decision.reason);
    process.stdout.write(`${JSON.stringify({ mode: "tenmin-redispatch", trigger: "fallback", lastRun: record?.githubRunId, ...decision })}\n`);
    if (decision.dispatch) {
      // Build a record so a cancelled-scan stop can be written for the next fallback to read.
      const fallbackRecord: TenMinRunRecord = record ?? {
        outcome: undefined,
        jobResult: "unknown",
        chain: 0,
        githubRunId: env.GITHUB_RUN_ID ?? "",
        finishedAt: now.toISOString(),
        decision,
      };
      const dispatchedAfterIso = new Date().toISOString();
      await dispatch(decision.nextChain);
      await checkNoScheduledScanCancelled({
        record: { ...fallbackRecord, decision },
        recordFile: env.TENMIN_RECORD_FILE,
        dispatchedAfterIso,
      });
    }
    return;
  }
  throw new Error("TENMIN_REDISPATCH_MODE:chain|fallback");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv[2]).catch((error: unknown) => {
    process.stderr.write(`TENMIN_REDISPATCH_FAILED:${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
