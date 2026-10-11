/**
 * The daily scan always gets the Massive request budget (5/min). Backfill checks this before
 * starting and before every session, and stops at the session boundary when a scan is due or
 * waiting, so a scan never competes with it for requests.
 */

/** UTC minute-of-day windows that start 15 minutes before each scheduled scan (05:30 and 09:30 UTC). */
export const SCAN_GUARD_WINDOWS_UTC: ReadonlyArray<readonly [number, number]> = [
  [5 * 60 + 15, 6 * 60 + 15],
  [9 * 60 + 15, 10 * 60 + 15],
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
 * scanner.yml run-name for runs started by the hourly restarter cron. They only decide whether to
 * restart the ten-minute history chain (no Massive, no R2), so no yield or active-run check counts them.
 */
export const TENMIN_RESTARTER_RUN_NAME = "Scanner restarter" as const;

/** Pure: a scanner.yml run started by the restarter cron (matched by its run-name). */
export function isTenMinRestarterRun(run: { display_title?: string | null }): boolean {
  return run.display_title === TENMIN_RESTARTER_RUN_NAME;
}

/**
 * scanner.yml run-name for a daily liquid 10-minute cron tick while its kill switch
 * (vars.TENMIN_DAILY_ENABLED) is off: the job is skipped, nothing calls Massive or writes R2.
 * When on, the run is named "Scanner tenmin daily" and counts as a working run.
 */
export const TENMIN_DAILY_OFF_RUN_NAME = "Scanner tenmin daily (off)" as const;

/** Pure: a scanner.yml run that never calls Massive or writes R2 (restarter, or daily tick switched off). */
export function isIdleScannerRun(run: { display_title?: string | null }): boolean {
  return isTenMinRestarterRun(run) || run.display_title === TENMIN_DAILY_OFF_RUN_NAME;
}

export interface ScannerRunLike {
  id: number;
  status: string;
  event: string;
  display_title?: string | null;
}

/** Picks the run this caller must yield to (a reason string), or undefined to continue. */
export type ScanRunPick = (runs: readonly ScannerRunLike[], selfRunId: number) => string | undefined;

/** Default pick (history, backfill): any other active scanner.yml run that is not idle. */
export const pickActiveScannerRun: ScanRunPick = (runs, self) => {
  // Restarter runs never write R2 or call Massive: yielding to them would break the chain hourly.
  const waiting = runs.find((run) => run.id !== self && !isIdleScannerRun(run) && ACTIVE_RUN_STATES.has(run.status));
  return waiting ? `SCAN_RUN_WAITING:${waiting.id}:${waiting.event}:${waiting.status}` : undefined;
};

export type ScanRunsCheck =
  | { ok: true; waiting?: string }
  | {
      ok: false;
      /** e.g. "http-403", "http-403:rate-limited", "workflow-ref", a fetch error. */
      failure: string;
      /** From retry-after or x-ratelimit-reset: how long GitHub asks us to wait. */
      retryAfterMs?: number;
    };

/**
 * One GitHub API call: list this workflow's recent runs and pick one to yield to. Returns undefined
 * off Actions (no token/repository/workflow ref). A 403/429 from the primary or secondary rate
 * limit is marked ":rate-limited" with GitHub's requested wait.
 */
export async function checkScannerRuns(
  options: ScanYieldOptions & { pick?: ScanRunPick } = {},
): Promise<ScanRunsCheck | undefined> {
  const env = options.env ?? process.env;
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  const workflowRef = env.GITHUB_WORKFLOW_REF;
  if (!token || !repository || !workflowRef) return undefined;
  const workflowFile = workflowRef.split("@")[0]?.split("/").pop();
  if (!workflowFile) return { ok: false, failure: "workflow-ref" };
  const api = env.GITHUB_API_URL ?? "https://api.github.com";
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${api}/repos/${repository}/actions/workflows/${workflowFile}/runs?per_page=30`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
    );
    if (!response.ok) {
      const nowMs = (options.now ?? (() => new Date()))().getTime();
      return { ok: false, ...rateLimitInfo(response, await response.text().catch(() => ""), nowMs) };
    }
    const body = (await response.json()) as { workflow_runs?: ScannerRunLike[] };
    const waiting = (options.pick ?? pickActiveScannerRun)(body.workflow_runs ?? [], Number(env.GITHUB_RUN_ID));
    return waiting ? { ok: true, waiting } : { ok: true };
  } catch (error) {
    return { ok: false, failure: String(error).slice(0, 120) };
  }
}

/** Pure: classify a failed GitHub API response (rate limit or not) and the wait it asks for. */
export function rateLimitInfo(
  response: { status: number; headers: { get(name: string): string | null } },
  bodyText: string,
  nowMs: number,
): { failure: string; retryAfterMs?: number } {
  const status = response.status;
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryAfter = response.headers.get("retry-after");
  const reset = response.headers.get("x-ratelimit-reset");
  const rateLimited =
    (status === 403 || status === 429) &&
    (status === 429 || remaining === "0" || retryAfter !== null || /rate limit/iu.test(bodyText));
  if (!rateLimited) return { failure: `http-${status}` };
  let retryAfterMs: number | undefined;
  if (retryAfter !== null && Number.isFinite(Number(retryAfter))) retryAfterMs = Math.max(0, Number(retryAfter) * 1000);
  else if (remaining === "0" && reset !== null && Number.isFinite(Number(reset)))
    retryAfterMs = Math.max(0, Number(reset) * 1000 - nowMs);
  return { failure: `http-${status}:rate-limited`, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

/**
 * Returns why backfill must yield, or undefined when it may continue. On Actions it also asks the
 * GitHub API whether any other run of this workflow is queued or running; a failed check yields.
 * Stateless: one API call per call. Long loops use createScanYieldCheck (throttled, retried).
 */
export async function scanYieldReason(options: ScanYieldOptions = {}): Promise<string | undefined> {
  const now = (options.now ?? (() => new Date()))();
  if (inScanGuardWindow(now)) return `SCAN_GUARD_WINDOW:${now.toISOString()}`;
  const result = await checkScannerRuns(options);
  if (!result) return undefined;
  return result.ok ? result.waiting : `${SCAN_CHECK_FAILED}:${result.failure}`;
}

/** Yield-reason prefix: the active-run check failed and was not recovered by retries. */
export const SCAN_CHECK_FAILED = "SCAN_CHECK_FAILED" as const;

/**
 * Minimum time between active-run API calls in one run. Run 38117572660 (Oct 11 2026) called the
 * API before every planned fetch, including ~5,000 already-stored fetches it only re-verified (no
 * Massive request), used up the GITHUB_TOKEN REST rate limit in under an hour, and got 403. At 60 s
 * a run makes at most ~60 calls/hour; a scan queued meanwhile is seen within a minute (at most
 * ~5 Massive requests at 12.5 s each), and the scan's concurrency group already waits for us.
 */
export const SCAN_CHECK_INTERVAL_MS = 60_000;
/** Waits before each retry of a failed check (then it fails closed). */
export const SCAN_CHECK_RETRY_DELAYS_MS: readonly number[] = [30_000, 60_000, 120_000];
/** A rate limit that resets later than this is not waited out: the run stops at once. */
export const SCAN_CHECK_MAX_RETRY_WAIT_MS = 300_000;

export interface ScanYieldCheckOptions extends ScanYieldOptions {
  pick?: ScanRunPick;
  intervalMs?: number;
  retryDelaysMs?: readonly number[];
  maxRetryWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Stateful yield check for long loops (history, backfill, daily). Guard windows are checked on
 * every call (no API). The active-run API call is made at most once per intervalMs while it keeps
 * saying "nothing waiting"; a run found waiting is never cached. A failed call is retried
 * (SCAN_CHECK_RETRY_DELAYS_MS, or GitHub's retry-after / rate-limit reset when longer). If it still
 * fails, or GitHub asks for a wait over maxRetryWaitMs, it returns
 * "SCAN_CHECK_FAILED:<failure>:attempts=<n>": fail closed, no Massive request is made on an
 * unverified check, and the caller stops the run and alerts.
 */
export function createScanYieldCheck(options: ScanYieldCheckOptions = {}): () => Promise<string | undefined> {
  const clock = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? SCAN_CHECK_INTERVAL_MS;
  const delays = options.retryDelaysMs ?? SCAN_CHECK_RETRY_DELAYS_MS;
  const maxWait = options.maxRetryWaitMs ?? SCAN_CHECK_MAX_RETRY_WAIT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let lastClearAt: number | undefined;
  return async () => {
    const now = clock();
    if (inScanGuardWindow(now)) return `SCAN_GUARD_WINDOW:${now.toISOString()}`;
    if (lastClearAt !== undefined && now.getTime() - lastClearAt < intervalMs) return undefined;
    for (let attempt = 1; ; attempt += 1) {
      const result = await checkScannerRuns({ ...options, now: clock });
      if (!result) return undefined;
      if (result.ok) {
        if (result.waiting) {
          lastClearAt = undefined;
          return result.waiting;
        }
        lastClearAt = clock().getTime();
        return undefined;
      }
      lastClearAt = undefined;
      const planned = delays[attempt - 1];
      const wait = planned === undefined ? undefined : Math.max(planned, result.retryAfterMs ?? 0);
      if (wait === undefined || wait > maxWait) return `${SCAN_CHECK_FAILED}:${result.failure}:attempts=${attempt}`;
      await sleep(wait);
      const after = clock();
      if (inScanGuardWindow(after)) return `SCAN_GUARD_WINDOW:${after.toISOString()}`;
    }
  };
}

/** Pure: a yield reason that means the active-run check failed for good (stop + alert). */
export function isScanCheckFailure(reason: string | undefined): boolean {
  return !!reason && reason.startsWith(`${SCAN_CHECK_FAILED}:`);
}

/** Thrown from inside a paged provider call when a scan becomes due; nothing partial is kept. */
export class ScanYieldError extends Error {
  constructor(readonly reason: string) {
    super(`SCAN_YIELD:${reason}`);
    this.name = "ScanYieldError";
  }
}
