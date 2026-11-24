/**
 * Backfill job with per-session pack verification (the pre-upgrade readiness proof).
 *
 * One run: the production historical backfill (src/backfill.ts: point-in-time universe, resumable
 * progress in backfill-state.json, one session at a time) with grouped-daily Reply Dust on, through
 * the production Massive adapter (its own request spacing), then for every session of the range that
 * the checkpoint marks complete:
 *   1. the session's daily-bars pack is written with the scanner's own writer (new keys only; an
 *      existing pack is never replaced, a different one is refused), bound to the day's Reply Dust;
 *   2. the pack is re-read and checked (checkSealedDailyBarsPack: file sha, manifest, every packed line
 *      is a stored row) and the Reply Dust file is re-read against its manifest sha.
 * Any sha mismatch refuses the run (status REFUSED_SHA_MISMATCH). A provider 403 (plan window or
 * not authorized) or any other session failure stops at the session boundary with the checkpoint
 * saved; the next run with the same range resumes after the last completed session.
 *
 * This module never builds a network client: the caller passes `fetchImpl`. The dry-run CLI passes
 * a fake Massive; nothing here is wired to a workflow.
 */
import type { CanonicalDailyBar, SecurityMasterRecord } from "./contracts";
import { backfillHistoricalEvidence, type BackfillResult, type BackfillState } from "./backfill";
import { readDailyReplyDustManifest, readDailyReplyDustReply } from "./daily-reply-dust";
import { checkSealedDailyBarsPack, maybeWriteScanDailyBarsSidecar } from "./daily-bars-sidecar";
import type { ReplyDustStore } from "./intraday-reply-dust";
import { MassiveMarketProvider } from "./massive-provider";
import type { ReplyDustBackend } from "./reply-dust";
import type { ZstdVersionProbe } from "./reply-dust-pin";
import type { MarketStore } from "./storage";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

export type BackfillJobStatus = "COMPLETE" | "STOPPED_RESUMABLE" | "REFUSED_SHA_MISMATCH" | "REFUSED_PACK_CONFLICT";
export type BackfillStopReason = "PLAN_WINDOW" | "NOT_AUTHORIZED" | "PROVIDER_NOT_READY" | "CREDENTIAL_REJECTED" | "SESSION_FAILED" | "MAX_SESSIONS" | "YIELDED";

export interface BackfillJobReport {
  status: BackfillJobStatus;
  stopReason?: BackfillStopReason;
  from: string;
  to: string;
  /** Sessions the checkpoint marks complete (all runs so far). */
  checkpointSessions: number;
  attemptedThisRun: number;
  completedThisRun: number;
  packsWritten: number;
  packsAlreadySealed: number;
  sessionsVerified: number;
  shaMismatches: string[];
  packConflicts: string[];
  /** Stored bar rows and distinct (security, session, revision) keys in the range: equal = no duplicates. */
  barRows: number;
  distinctBarKeys: number;
  requests: number;
  /** Smallest gap between two consecutive provider requests (ms, by the job clock). */
  minRequestGapMs: number | null;
  /** First request to last, by the job clock (ms). */
  elapsedMs: number;
  failedSessions: Record<string, string>;
  backfill: Pick<BackfillResult, "barsStored" | "actionsStored" | "survivorship" | "warnings">;
}

export interface BackfillJobOptions {
  from: string;
  to: string;
  storage: MarketStore;
  /** Reply Dust and daily-bars packs. */
  store: ReplyDustStore;
  fetchImpl: typeof fetch;
  apiKey: string;
  baseUrl?: string;
  minRequestIntervalMs: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  maxSessions?: number;
  backend?: ReplyDustBackend;
  zstdVersionProbe?: ZstdVersionProbe;
}

export function classifyStop(message: string): BackfillStopReason {
  if (/MASSIVE_CREDENTIAL_REJECTED/u.test(message)) return "CREDENTIAL_REJECTED";
  if (/PROVIDER_NOT_READY/u.test(message)) return "PROVIDER_NOT_READY";
  if (/MASSIVE_HTTP_403/u.test(message)) return /timeframe|plan|upgrade/iu.test(message) ? "PLAN_WINDOW" : "NOT_AUTHORIZED";
  return "SESSION_FAILED";
}

export async function runBackfillJob(options: BackfillJobOptions): Promise<BackfillJobReport> {
  if (!(options.minRequestIntervalMs >= 0)) throw new Error("BACKFILL_JOB_RATE_LIMIT_REQUIRED");
  const clock = options.clock ?? Date.now;
  const requestTimes: number[] = [];
  const countingFetch: typeof fetch = async (input, init) => {
    requestTimes.push(clock());
    return options.fetchImpl(input, init);
  };
  const provider = new MassiveMarketProvider({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    fetchImpl: countingFetch,
    minRequestIntervalMs: options.minRequestIntervalMs,
    retryBackoffMs: 0,
    keepRawReplies: true,
    clock,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const result = await backfillHistoricalEvidence({
    root: "/unused-backfill-job",
    from: options.from,
    to: options.to,
    provider,
    storage: options.storage,
    env: {},
    shouldYield: async () => undefined,
    replyDust: true,
    replyDustStore: options.store,
    ...(options.backend ? { replyDustBackend: options.backend } : {}),
    ...(options.zstdVersionProbe ? { zstdVersionProbe: options.zstdVersionProbe } : {}),
    ...(options.maxSessions !== undefined ? { maxSessions: options.maxSessions } : {}),
  });
  const progress = (await options.storage.loadBackfillProgress()) as BackfillState | undefined;
  const completed = (progress?.completedSessions ?? []).filter((d) => d >= options.from && d <= options.to);
  const securities: SecurityMasterRecord[] = await options.storage.loadSecurities();
  let packsWritten = 0;
  let packsAlreadySealed = 0;
  let sessionsVerified = 0;
  const shaMismatches: string[] = [];
  const packConflicts: string[] = [];
  let barRows = 0;
  const keys = new Set<string>();
  for (const sessionDate of completed) {
    const rows: CanonicalDailyBar[] = await options.storage.loadBars(sessionDate);
    barRows += rows.length;
    for (const row of rows) keys.add(`${row.securityId}|${row.sessionDate}|${row.revision}`);
    try {
      const dust = await readDailyReplyDustManifest(options.store, sessionDate);
      if (!dust) throw new Error("REPLY_DUST_MANIFEST_MISSING");
      await readDailyReplyDustReply(options.store, dust, options.backend);
    } catch {
      shaMismatches.push(sessionDate);
      continue;
    }
    const pack = await maybeWriteScanDailyBarsSidecar({
      enabled: true,
      store: options.store,
      sessionDate,
      bars: rows,
      securities,
      ...(options.backend ? { backend: options.backend } : {}),
      ...(options.zstdVersionProbe ? { zstdVersionProbe: options.zstdVersionProbe } : {}),
    });
    if (pack.status === "stored") packsWritten += 1;
    else if (pack.status === "exists-same" || pack.status === "exists-equivalent") packsAlreadySealed += 1;
    else if (pack.status !== "no-rows") {
      (pack.status === "exists-different" ? packConflicts : shaMismatches).push(sessionDate);
      continue;
    }
    if (pack.status === "no-rows") {
      sessionsVerified += 1; // an empty session (no bars) has nothing to pack; its Reply Dust is verified
      continue;
    }
    const check = await checkSealedDailyBarsPack({ store: options.store, sessionDate, storedRows: rows, ...(options.backend ? { backend: options.backend } : {}) });
    if (check.state === "verified") sessionsVerified += 1;
    else shaMismatches.push(sessionDate);
  }
  const failedMessage = Object.values(result.failedSessions)[0];
  const stopReason: BackfillStopReason | undefined = result.stoppedOnError
    ? classifyStop(failedMessage ?? "")
    : result.yieldedForScan
      ? "YIELDED"
      : completed.length < sessionsIn(options.from, options.to)
        ? "MAX_SESSIONS"
        : undefined;
  const gaps = requestTimes.slice(1).map((t, k) => t - requestTimes[k]!);
  const status: BackfillJobStatus = shaMismatches.length
    ? "REFUSED_SHA_MISMATCH"
    : packConflicts.length
      ? "REFUSED_PACK_CONFLICT"
      : stopReason
        ? "STOPPED_RESUMABLE"
        : "COMPLETE";
  return {
    status,
    ...(stopReason ? { stopReason } : {}),
    from: options.from,
    to: options.to,
    checkpointSessions: completed.length,
    attemptedThisRun: result.attemptedSessions.length,
    completedThisRun: result.completedSessions.length,
    packsWritten,
    packsAlreadySealed,
    sessionsVerified,
    shaMismatches,
    packConflicts,
    barRows,
    distinctBarKeys: keys.size,
    requests: requestTimes.length,
    minRequestGapMs: gaps.length ? Math.min(...gaps) : null,
    elapsedMs: requestTimes.length ? requestTimes.at(-1)! - requestTimes[0]! : 0,
    failedSessions: result.failedSessions,
    backfill: {
      barsStored: result.barsStored,
      actionsStored: result.actionsStored,
      ...(result.survivorship ? { survivorship: result.survivorship } : {}),
      ...(result.warnings ? { warnings: result.warnings } : {}),
    },
  };
}

/** Trading sessions in [from, to] by the scanner calendar. */
function sessionsIn(from: string, to: string): number {
  let n = 0;
  for (const d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1))
    if (US_EQUITY_MARKET_CALENDAR.getSession(d.toISOString().slice(0, 10)).kind !== "CLOSED") n += 1;
  return n;
}
