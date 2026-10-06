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
import type { TenMinHistoryRunReport } from "./tenmin-history";

export const TENMIN_OUTCOME_SCHEMA = "tenmin-history-outcome-v1" as const;
/** Don't start a run this close before a guard window: a pending run could start inside it. */
export const TENMIN_REDISPATCH_LEAD_MINUTES = 10;
/** Default and hard ceiling for runs in one chain without a human (repo variable may lower it). */
export const TENMIN_REDISPATCH_DEFAULT_MAX_CHAIN = 24;
export const TENMIN_REDISPATCH_HARD_MAX_CHAIN = 100;

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
}

const SEALED = new Set(["SEALED", "ALREADY_SEALED", "REOPENED"]);

/**
 * Pure: classify a finished run. Continue only on a clean partial (time budget, scan yield, or
 * ranges left after a clean stop); stop on any refusal or error, an outage stop, a bounded manual
 * run (reopen or maxRanges), a time-budget stop with no progress, or nothing left to fetch.
 */
export function tenMinRunOutcome(report: TenMinHistoryRunReport): TenMinRunOutcome {
  const rangesSealed = report.ranges.filter((r) => SEALED.has(r.status)).length;
  const rangesRemaining = Math.max(0, report.rangesPlanned - rangesSealed);
  const madeProgress = report.ranges.some(
    (r) =>
      r.status === "SEALED" ||
      r.status === "REOPENED" ||
      r.securitiesWritten > 0 ||
      (r.groupedDailyStored ?? 0) > 0,
  );
  const out = (nextAction: TenMinRunOutcome["nextAction"], reason: string): TenMinRunOutcome => ({
    schemaVersion: TENMIN_OUTCOME_SCHEMA,
    runId: report.runId,
    nextAction,
    reason,
    rangesPlanned: report.rangesPlanned,
    rangesSealed,
    rangesRemaining,
    madeProgress,
  });
  if (report.stoppedOnError || report.error) {
    const message = report.error ?? "UNKNOWN";
    const refusal = TENMIN_REFUSAL_CODES.find((code) => message.includes(code));
    return out("stop", refusal ? `STOP_REFUSAL:${refusal}` : `STOP_ERROR:${message.slice(0, 160)}`);
  }
  if (report.outageStop) return out("stop", `STOP_OUTAGE:${report.outageStop.slice(0, 160)}`);
  if (report.reopen) return out("stop", "STOP_BOUNDED_MANUAL_RUN:reopen");
  if (report.maxRanges !== undefined) return out("stop", `STOP_BOUNDED_MANUAL_RUN:maxRanges=${report.maxRanges}`);
  if (rangesRemaining === 0) return out("stop", "STOP_DONE:no-range-left");
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
  if (input.outcome.nextAction !== "continue") return stop(input.outcome.reason);
  if (input.jobResult !== "success") return stop(`STOP_JOB_${input.jobResult.toUpperCase() || "UNKNOWN"}`);
  if (input.newerFailedRun) return stop(`STOP_NEWER_RUN_FAILED:${input.newerFailedRun}`);
  if (input.outcome.rangesRemaining <= 0) return stop("STOP_DONE:no-range-left");
  const maxChain = maxChainOf(input.maxChain);
  if (nextChain > maxChain) return stop(`STOP_CHAIN_CAP:${maxChain}`);
  if (input.queue.checkFailed) return wait(`WAIT_QUEUE_CHECK_FAILED:${input.queue.checkFailed}`);
  if (input.queue.otherActiveRuns > 0) return wait(`WAIT_RUN_ACTIVE:${input.queue.otherActiveRuns}`);
  const guard = guardWindowState(input.nowUtc);
  if (guard.inside) return wait("WAIT_GUARD_WINDOW");
  if (guard.minutesUntilNext <= TENMIN_REDISPATCH_LEAD_MINUTES) return wait("WAIT_NEAR_GUARD_WINDOW");
  return { dispatch: true, nextAction: "continue", reason: input.outcome.reason, nextChain };
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

/** The record the chain step stores as the run's artifact (read by the fallback). */
export interface TenMinRunRecord {
  outcome: TenMinRunOutcome | undefined;
  jobResult: string;
  chain: number;
  githubRunId: string;
  finishedAt: string;
  decision: TenMinRedispatchDecision;
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
    if (decision.dispatch) await dispatch(decision.nextChain);
    return;
  }
  if (mode === "fallback") {
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
    });
    output("next_action", decision.nextAction);
    output("reason", decision.reason);
    process.stdout.write(`${JSON.stringify({ mode: "tenmin-redispatch", trigger: "fallback", lastRun: record?.githubRunId, ...decision })}\n`);
    if (decision.dispatch) await dispatch(decision.nextChain);
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
