// Stop alert for the ten-minute history chain: opens (or comments on) ONE GitHub issue labeled
// scanner-alert when the chain really stops or fails, and closes it when the chain runs again.
// Free: built-in GITHUB_TOKEN only (issues: write). No personal data.
//
// No alert for: a manual pause (TENMIN_AUTO_REDISPATCH not "true") unless the history step
// itself failed; "wait" decisions (guard window, run active, queue check) that the fallback
// handles; a fallback that sees another scanner.yml run active (that run's own chain step reports).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TenMinRunRecord } from "./tenmin-redispatch";

export const SCANNER_ALERT_LABEL = "scanner-alert";
export const SCANNER_ALERT_ASSIGNEE = "PeaceG03";

export interface TenMinAlertInput {
  trigger: "chain" | "fallback";
  /** chain: this run's record; fallback: the newest stored record (may be absent). */
  record: TenMinRunRecord | undefined;
  /** chain only: outcome of the history step (success/failure/cancelled/skipped). */
  historyStep?: string;
  /** Outcome of the redispatch/decide step (success/failure/cancelled/skipped). */
  redispatchStep: string;
  /** Decision outputs of the redispatch/decide step (GITHUB_OUTPUT next_action / reason). */
  nextAction?: string;
  reason?: string;
  killSwitch: string | undefined;
  /** fallback only: other scanner.yml runs queued/in progress right now. */
  otherActiveRuns?: number;
}

export type TenMinAlertPlan =
  | { action: "none"; why: string }
  | { action: "close"; why: string }
  | { action: "alert"; reason: string; key: string };

/** Pure: should this run open/comment an alert, close an open one, or do nothing? */
export function planTenMinAlert(input: TenMinAlertInput): TenMinAlertPlan {
  const reason = input.reason || input.record?.decision.reason || "";
  const nextAction = input.nextAction || input.record?.decision.nextAction || "";
  const runKey = input.record?.githubRunId || "none";
  const alert = (r: string): TenMinAlertPlan => ({ action: "alert", reason: r, key: `${runKey}:${r.split(":")[0]}` });
  const paused = input.killSwitch !== "true";

  if (input.trigger === "chain") {
    const history = input.historyStep ?? "unknown";
    if (paused) {
      return history === "failure"
        ? alert(`STOP_JOB_FAILURE${reason ? ` (${reason})` : ""}`)
        : { action: "none", why: "manual pause (TENMIN_AUTO_REDISPATCH not true)" };
    }
    if (input.redispatchStep !== "success") {
      // Record may have been rewritten (e.g. STOP_SCAN_CANCELLED) before the step failed.
      const recorded = input.record?.decision.nextAction === "stop" ? input.record.decision.reason : "";
      return alert(recorded || `STOP_REDISPATCH_STEP_${(input.redispatchStep || "unknown").toUpperCase()}`);
    }
    if (nextAction === "continue") return { action: "close", why: "chain dispatched the next run" };
    if (nextAction === "wait") return { action: "none", why: `planned wait (${reason}); fallback restarts` };
    if (nextAction === "stop") return alert(reason || "STOP_UNKNOWN");
    return alert(`STOP_NO_DECISION:${history}`);
  }

  // fallback
  if (paused) return { action: "none", why: "manual pause (TENMIN_AUTO_REDISPATCH not true)" };
  if (input.redispatchStep !== "success") {
    const recorded = input.record?.decision.nextAction === "stop" ? input.record.decision.reason : "";
    return { action: "alert", reason: recorded || `STOP_FALLBACK_STEP_${(input.redispatchStep || "unknown").toUpperCase()}`, key: `fallback:${runKey}:${input.redispatchStep}` };
  }
  if (nextAction === "continue") return { action: "close", why: "fallback restarted the chain" };
  if (nextAction === "wait") return { action: "none", why: `planned wait (${reason})` };
  if (nextAction === "stop") {
    if ((input.otherActiveRuns ?? 0) > 0) return { action: "none", why: "another scanner run is active; it reports itself" };
    return alert(reason || "STOP_UNKNOWN");
  }
  return { action: "none", why: "no decision" };
}

/** Pure: Denver wall time with a short label. */
export function mountainTime(date: Date): string {
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${text} MT`;
}

export function alertMarker(key: string): string {
  return `<!-- scanner-alert-key: ${key} -->`;
}

/** Pure: issue title and body (no personal data). */
export function alertText(opts: {
  reason: string;
  key: string;
  runUrl: string;
  trigger: "chain" | "fallback";
  record: TenMinRunRecord | undefined;
  now: Date;
}): { title: string; body: string } {
  const short = opts.reason.length > 90 ? `${opts.reason.slice(0, 87)}...` : opts.reason;
  const r = opts.record?.outcome?.rangeRemaining;
  const lines = [
    `The ten-minute history chain stopped and did not start a next run.`,
    ``,
    `- Reason: \`${opts.reason}\``,
    `- Seen by: ${opts.trigger === "chain" ? "the history run's chain step" : "the 2-hourly fallback check"}`,
    `- Run: ${opts.runUrl}`,
    ...(opts.record?.githubRunId ? [`- Last history run: ${opts.record.githubRunId} (chain #${opts.record.chain})`] : []),
    ...(r
      ? [`- Progress ${r.range}: ${r.storedFetches} of ${r.plannedFetches} fetches stored, ${r.remainingFetches} remaining, ${r.gappedFetches} gaps`]
      : []),
    ...(opts.record?.outcome
      ? [`- Ranges: ${opts.record.outcome.rangesSealed} sealed of ${opts.record.outcome.rangesPlanned} planned, ${opts.record.outcome.rangesRemaining} remaining`]
      : []),
    `- Time: ${mountainTime(opts.now)}`,
    ``,
    `This issue closes itself with "Chain running again" when a later run chains successfully.`,
    alertMarker(opts.key),
  ];
  return { title: `Scanner stopped: ${short}`, body: lines.join("\n") };
}

// ---- CLI (thin I/O) ----

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

async function ok<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) throw new Error(`SCANNER_ALERT_HTTP:${what}:${response.status}`);
  return (await response.json()) as T;
}

interface Issue {
  number: number;
  body: string | null;
  pull_request?: unknown;
}

function readJson<T>(path: string | undefined): T | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function runTenMinAlert(trigger: "chain" | "fallback"): Promise<string> {
  const env = process.env;
  const label = env.SCANNER_ALERT_LABEL || SCANNER_ALERT_LABEL;
  const record = readJson<TenMinRunRecord>(env.TENMIN_RECORD_FILE);
  let otherActiveRuns: number | undefined;
  if (trigger === "fallback") {
    const runs = await ok<{ workflow_runs?: { status: string }[] }>(
      await gh(`/actions/workflows/scanner.yml/runs?per_page=30`),
      "runs",
    );
    otherActiveRuns = (runs.workflow_runs ?? []).filter((r) =>
      ["queued", "in_progress", "waiting", "pending", "requested"].includes(r.status),
    ).length;
  }
  const plan =
    env.SCANNER_ALERT_FORCE_REASON
      ? ({ action: "alert", reason: env.SCANNER_ALERT_FORCE_REASON, key: `test:${env.GITHUB_RUN_ID}` } as const)
      : planTenMinAlert({
          trigger,
          record,
          ...(env.TENMIN_HISTORY_STEP ? { historyStep: env.TENMIN_HISTORY_STEP } : {}),
          redispatchStep: env.TENMIN_REDISPATCH_STEP ?? "unknown",
          ...(env.TENMIN_NEXT_ACTION ? { nextAction: env.TENMIN_NEXT_ACTION } : {}),
          ...(env.TENMIN_REASON ? { reason: env.TENMIN_REASON } : {}),
          killSwitch: env.TENMIN_AUTO_REDISPATCH,
          ...(otherActiveRuns !== undefined ? { otherActiveRuns } : {}),
        });
  const runUrl = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const open = (await ok<Issue[]>(await gh(`/issues?state=open&labels=${encodeURIComponent(label)}&per_page=20`), "list")).filter(
    (i) => !i.pull_request,
  );

  if (plan.action === "none") return `none: ${plan.why}`;
  if (plan.action === "close") {
    for (const issue of open) {
      await ok(await gh(`/issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body: `Chain running again (${runUrl}, ${mountainTime(new Date())}).` }) }), "comment");
      await ok(await gh(`/issues/${issue.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) }), "close");
    }
    return `close: ${open.length} closed (${plan.why})`;
  }

  // Dedupe: the same key already reported on any recent scanner-alert issue (open or closed).
  const marker = alertMarker(plan.key);
  const recent = (await ok<Issue[]>(await gh(`/issues?state=all&labels=${encodeURIComponent(label)}&per_page=10`), "recent")).filter(
    (i) => !i.pull_request,
  );
  for (const issue of recent) {
    if (issue.body?.includes(marker)) return `alert: already reported in #${issue.number}`;
    const comments = await ok<{ body: string | null }[]>(await gh(`/issues/${issue.number}/comments?per_page=100`), "comments");
    if (comments.some((c) => c.body?.includes(marker))) return `alert: already reported in #${issue.number}`;
  }
  const text = alertText({ reason: plan.reason, key: plan.key, runUrl, trigger, record, now: new Date() });
  const existing = open[0];
  if (existing) {
    await ok(await gh(`/issues/${existing.number}/comments`, { method: "POST", body: JSON.stringify({ body: `**${text.title}**\n\n${text.body}` }) }), "comment");
    return `alert: commented on #${existing.number}`;
  }
  const created = await ok<{ number: number }>(
    await gh(`/issues`, { method: "POST", body: JSON.stringify({ title: text.title, body: text.body, labels: [label], assignees: [SCANNER_ALERT_ASSIGNEE] }) }),
    "create",
  );
  return `alert: opened #${created.number}`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const trigger = process.argv[2];
  if (trigger !== "chain" && trigger !== "fallback") {
    process.stderr.write("SCANNER_ALERT_MODE:chain|fallback\n");
    process.exitCode = 2;
  } else {
    runTenMinAlert(trigger).then(
      (result) => process.stdout.write(`${JSON.stringify({ mode: "scanner-alert", trigger, result })}\n`),
      (error: unknown) => {
        process.stderr.write(`SCANNER_ALERT_FAILED:${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 2;
      },
    );
  }
}
