/**
 * The daily scan always gets the Massive request budget (5/min). Backfill checks this before
 * starting and before every session, and stops at the session boundary when a scan is due or
 * waiting, so a scan never competes with it for requests.
 */

/** UTC minute-of-day windows that start 15 minutes before each scheduled scan (21:30 and 01:30 UTC). */
export const SCAN_GUARD_WINDOWS_UTC: ReadonlyArray<readonly [number, number]> = [
  [21 * 60 + 15, 22 * 60 + 15],
  [1 * 60 + 15, 2 * 60 + 15],
];

export interface ScanYieldOptions {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function inScanGuardWindow(at: Date): boolean {
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  return SCAN_GUARD_WINDOWS_UTC.some(([start, end]) => minute >= start && minute < end);
}

const ACTIVE_RUN_STATES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

/**
 * Returns why backfill must yield, or undefined when it may continue. On Actions it also asks the
 * GitHub API whether any other run of this workflow is queued or running; a failed check yields.
 */
export async function scanYieldReason(options: ScanYieldOptions = {}): Promise<string | undefined> {
  const now = (options.now ?? (() => new Date()))();
  if (inScanGuardWindow(now)) return `SCAN_GUARD_WINDOW:${now.toISOString()}`;
  const env = options.env ?? process.env;
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  const workflowRef = env.GITHUB_WORKFLOW_REF;
  if (!token || !repository || !workflowRef) return undefined;
  const workflowFile = workflowRef.split("@")[0]?.split("/").pop();
  if (!workflowFile) return "SCAN_CHECK_FAILED:workflow-ref";
  const api = env.GITHUB_API_URL ?? "https://api.github.com";
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${api}/repos/${repository}/actions/workflows/${workflowFile}/runs?per_page=30`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
    );
    if (!response.ok) return `SCAN_CHECK_FAILED:http-${response.status}`;
    const body = (await response.json()) as { workflow_runs?: { id: number; status: string; event: string }[] };
    const self = Number(env.GITHUB_RUN_ID);
    const waiting = (body.workflow_runs ?? []).find(
      (run) => run.id !== self && ACTIVE_RUN_STATES.has(run.status),
    );
    return waiting ? `SCAN_RUN_WAITING:${waiting.id}:${waiting.event}:${waiting.status}` : undefined;
  } catch (error) {
    return `SCAN_CHECK_FAILED:${String(error).slice(0, 120)}`;
  }
}

/** Thrown from inside a paged provider call when a scan becomes due; nothing partial is kept. */
export class ScanYieldError extends Error {
  constructor(readonly reason: string) {
    super(`SCAN_YIELD:${reason}`);
    this.name = "ScanYieldError";
  }
}
