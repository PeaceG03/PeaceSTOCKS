/**
 * Daily 10-minute picks runner (commit 3).
 *
 * Phase of the history run (first) and standalone `tenmin_daily` mode.
 * Kill switch: TENMIN_DAILY_PICKS must be exactly "true" (default off).
 *
 * - Live clock before every Massive fetch (injectable `clock`); no fetch inside
 *   SCAN_GUARD_WINDOWS_UTC.
 * - picksBacklog + runner step past CORRUPT/FAILED until the seal cap fills.
 * - Base seals only when D is settled (FROZEN or no_forward_scan after next
 *   session 09:30 ET open); not_yet_frozen days are skipped this run.
 * - Resume: reuse picks.json byte-for-byte; adopt existing .rdust; fetch order
 *   holding → index → top50 → random; each fetch persists immediately.
 */

import type { PredictionStatus } from "./contracts";
import type { MarketStore } from "./storage";
import type { ReplyDustStore } from "./intraday-reply-dust";
import { sha256Hex } from "./intraday-reply-dust";
import { inScanGuardWindow, scanYieldReason } from "./scan-yield";
import { nextSessionOpen } from "./session-open";
import { encodeReplyDust, nodeReplyDustBackend } from "./reply-dust";
import {
  TENMIN_DAY_OBJECT_CORRUPT,
  TENMIN_DAY_OBJECT_SCHEMA,
  type TenMinDaySecurityInput,
  classifyTop50Absence,
  loadExistingPicksBaseBytes,
  parsePicksBaseBytes,
  picksBacklog,
  putImmutableVerified,
  readTenMinDayPicks,
  sessionWithinMassiveWindow,
  tenMinDayObjectKey,
  writeTenMinDayPicks,
  writeTenMinDayTop50AddOn,
} from "./tenmin-day-picks";
import {
  type PickV1Pick,
  type PicksBaseV1,
  type PicksTop50V1,
  mergeDailyTenMinPicksV1,
  orderPicksForFetch,
} from "./tenmin-daily-picks";
import { resolveSessionPredictionStatus } from "./prediction-status";
import type { MassiveMarketProvider } from "./massive-provider";
import {
  TENMIN_DAILY_BASE_INPUT_FAILED,
  TENMIN_DAILY_BASE_INPUT_MISSING,
  TenMinDailyBaseCorruptError,
  TenMinDailyBaseFailedError,
  TenMinDailyBaseInputError,
  buildTenMinDailyPicksBaseFromStored,
} from "./tenmin-daily-picks-base";

const TENMIN_DAILY_BASE_INPUT_MISSING_PREFIX = `${TENMIN_DAILY_BASE_INPUT_MISSING}:`;

export const TENMIN_DAILY_PICKS_RUN_SCHEMA = "tenmin-daily-picks-run-v1" as const;
export const TENMIN_DAILY_PICKS_KILL_SWITCH = "TENMIN_DAILY_PICKS" as const;
export const TENMIN_DAILY_PICKS_DEFAULT_LIMIT = 5;

export interface TenMinDailyCorruptEntry {
  sessionDate: string;
  key: string;
}

export type TenMinDailyDayOutcome =
  | "SEALED"
  | "TOP50_ADDED"
  | "CORRUPT"
  | "SKIPPED_GUARD"
  | "SKIPPED_OUT_OF_WINDOW"
  | "SKIPPED_NOT_SETTLED"
  | "SKIPPED_BASE_INPUT"
  | "FAILED";

export interface TenMinDailyPicksDayResult {
  sessionDate: string;
  outcome: TenMinDailyDayOutcome;
  requests: number;
  corruptKey?: string;
  error?: string;
  /** When outcome is SKIPPED_BASE_INPUT: which input (grouped_reply | ticker_index). */
  baseInput?: string;
  /** Object key that was missing or undecodable. */
  baseInputKey?: string;
  /**
   * Informational: unique grouped-daily tickers with no entry in D's ticker reference index.
   * Copied from picks.json when sealed; does not affect seal/skip/pick logic.
   */
  groupedWithoutIndexEntry?: { count: number; sample: string[] };
}

export interface TenMinDailyPicksRunReport {
  schemaVersion: typeof TENMIN_DAILY_PICKS_RUN_SCHEMA;
  enabled: boolean;
  killSwitch: string | undefined;
  startedAt: string;
  completedAt: string;
  backlogConsidered: number;
  days: TenMinDailyPicksDayResult[];
  sealed: string[];
  corrupt: TenMinDailyCorruptEntry[];
  skippedOutOfWindow: string[];
  skippedNotSettled: string[];
  skippedBaseInput: Array<{ sessionDate: string; input: string; key: string }>;
  totalRequests: number;
  yieldedForScan?: string;
}

/** Concise picks section for history summary / R2 run report / Actions logs. */
export interface TenMinDailyPicksSummary {
  enabled: boolean;
  backlogConsidered: number;
  sealed: number;
  top50Added: number;
  skippedBaseInput: number;
  skippedNotSettled: number;
  skippedOutOfWindow: number;
  corrupt: number;
  failed: number;
  /** Massive 10-minute requests made by the picks phase this run. */
  totalRequests: number;
  days: Array<{
    sessionDate: string;
    outcome: TenMinDailyDayOutcome;
    requests: number;
    baseInput?: string;
    groupedWithoutIndexEntry?: { count: number; sample: string[] };
  }>;
  yieldedForScan?: string;
}

export function tenMinDailyPicksSummary(
  report: TenMinDailyPicksRunReport,
): TenMinDailyPicksSummary {
  let top50Added = 0;
  let failed = 0;
  for (const d of report.days) {
    if (d.outcome === "TOP50_ADDED") top50Added += 1;
    if (d.outcome === "FAILED") failed += 1;
  }
  return {
    enabled: report.enabled,
    backlogConsidered: report.backlogConsidered,
    sealed: report.sealed.length,
    top50Added,
    skippedBaseInput: report.skippedBaseInput.length,
    skippedNotSettled: report.skippedNotSettled.length,
    skippedOutOfWindow: report.skippedOutOfWindow.length,
    corrupt: report.corrupt.length,
    failed,
    totalRequests: report.totalRequests,
    days: report.days.map((d) => ({
      sessionDate: d.sessionDate,
      outcome: d.outcome,
      requests: d.requests,
      ...(d.baseInput ? { baseInput: d.baseInput } : {}),
      ...(d.groupedWithoutIndexEntry
        ? { groupedWithoutIndexEntry: d.groupedWithoutIndexEntry }
        : {}),
    })),
    ...(report.yieldedForScan ? { yieldedForScan: report.yieldedForScan } : {}),
  };
}

export function tenMinDailyPicksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TENMIN_DAILY_PICKS_KILL_SWITCH] === "true";
}

/** Settlement of D for base sealing (Architect). */
export type DaySettlement =
  | { kind: "FROZEN"; status: PredictionStatus }
  | { kind: "no_forward_scan" }
  | { kind: "not_yet_frozen" };

/**
 * FROZEN → seal with top50 when available.
 * After next session's 09:30 ET open, any non-FROZEN (including no records) → no_forward_scan.
 * Before that open and not FROZEN → not_yet_frozen (skip this run).
 */
export function resolveDaySettlement(
  sessionDate: string,
  statuses: readonly PredictionStatus[],
  now: Date,
): DaySettlement {
  const resolved = resolveSessionPredictionStatus(statuses);
  if (resolved?.status === "FROZEN") return { kind: "FROZEN", status: resolved };
  const absence = classifyTop50Absence(statuses, { sessionDate, now });
  if (absence.reason === "no_forward_scan") return { kind: "no_forward_scan" };
  return { kind: "not_yet_frozen" };
}

export interface RunTenMinDailyPicksOptions {
  store: ReplyDustStore;
  storage: MarketStore;
  /** Candidate session dates (oldest-first preferred; backlog sorts). */
  days: readonly string[];
  limit?: number;
  /** Fixed run-start instant for report timestamps / window bounds. Prefer `clock` for guards. */
  now?: Date;
  /**
   * Live clock read before every fetch and by the default shouldYield.
   * Defaults to `() => options.now ?? new Date()`.
   */
  clock?: () => Date;
  env?: NodeJS.ProcessEnv;
  provider?: MassiveMarketProvider;
  fetchReply?: (
    security: { securityId: string; symbol: string },
    sessionDate: string,
  ) => Promise<Uint8Array>;
  buildBase?: (sessionDate: string) => Promise<PicksBaseV1> | PicksBaseV1;
  buildTop50?: (sessionDate: string) => Promise<PicksTop50V1 | undefined> | PicksTop50V1 | undefined;
  withinWindow?: (sessionDate: string) => boolean;
  shouldYield?: () => Promise<string | undefined>;
  observedAt?: string;
}

export class TenMinDailyFetchCutoffError extends Error {
  constructor(
    readonly reason: string,
    readonly requests: number,
  ) {
    super(reason);
    this.name = "TenMinDailyFetchCutoffError";
  }
}

function extractCorruptKey(message: string): string {
  const prefix = `${TENMIN_DAY_OBJECT_CORRUPT}:`;
  if (!message.startsWith(prefix)) return message;
  const rest = message.slice(prefix.length);
  for (const suffix of [":missing", ":metadata", ":decode", ":readback"]) {
    const i = rest.indexOf(suffix);
    if (i >= 0) return rest.slice(0, i);
  }
  return rest;
}

/**
 * Live wall clock unless tests inject `clock`.
 * `now` is only a fixed as-of for window bounds / report start — never a frozen fetch clock.
 */
function resolveClock(options: RunTenMinDailyPicksOptions): () => Date {
  if (options.clock) return options.clock;
  return () => new Date();
}

/**
 * Run the daily picks phase. No-op (enabled:false) unless TENMIN_DAILY_PICKS === "true".
 */
export async function runTenMinDailyPicks(
  options: RunTenMinDailyPicksOptions,
): Promise<TenMinDailyPicksRunReport> {
  const env = options.env ?? process.env;
  const clock = resolveClock(options);
  const startedAt = clock().toISOString();
  const killSwitch = env[TENMIN_DAILY_PICKS_KILL_SWITCH];
  const enabled = killSwitch === "true";
  const empty = (): TenMinDailyPicksRunReport => ({
    schemaVersion: TENMIN_DAILY_PICKS_RUN_SCHEMA,
    enabled,
    killSwitch,
    startedAt,
    completedAt: clock().toISOString(),
    backlogConsidered: 0,
    days: [],
    sealed: [],
    corrupt: [],
    skippedOutOfWindow: [],
    skippedNotSettled: [],
    skippedBaseInput: [],
    totalRequests: 0,
  });
  if (!enabled) return empty();

  const limit = options.limit ?? TENMIN_DAILY_PICKS_DEFAULT_LIMIT;
  const windowAsOf = options.now ?? clock();
  const withinWindow =
    options.withinWindow ?? ((d: string) => sessionWithinMassiveWindow(d, windowAsOf));
  const shouldYield =
    options.shouldYield ??
    (async () => {
      const t = clock();
      if (inScanGuardWindow(t)) return `SCAN_GUARD_WINDOW:${t.toISOString()}`;
      return scanYieldReason({ now: clock, env });
    });

  const hasFrozen = async (d: string): Promise<boolean> => {
    const statuses = await options.storage.loadPredictionStatuses(d);
    return resolveSessionPredictionStatus(statuses)?.status === "FROZEN";
  };

  // Consider the full candidate list so CORRUPT/FAILED days cannot starve the seal cap
  // (limit*4 alone would stop before a later good day).
  const backlog = await picksBacklog(options.store, {
    days: options.days,
    limit: Math.max(options.days.length, limit * 4),
    withinWindow: () => true,
    hasFrozenPredictions: hasFrozen,
  });

  const dayResults: TenMinDailyPicksDayResult[] = [];
  const sealed: string[] = [];
  const corrupt: TenMinDailyCorruptEntry[] = [];
  const skippedOutOfWindow: string[] = [];
  const skippedNotSettled: string[] = [];
  const skippedBaseInput: Array<{ sessionDate: string; input: string; key: string }> = [];
  const skippedThisRun = new Set<string>();
  let totalRequests = 0;
  let yieldedForScan: string | undefined;
  let sealedCount = 0;

  for (const entry of backlog) {
    if (sealedCount >= limit) break;
    if (skippedThisRun.has(entry.sessionDate)) continue;

    if (!withinWindow(entry.sessionDate)) {
      skippedOutOfWindow.push(entry.sessionDate);
      dayResults.push({
        sessionDate: entry.sessionDate,
        outcome: "SKIPPED_OUT_OF_WINDOW",
        requests: 0,
      });
      continue;
    }

    const pause = await shouldYield();
    if (pause) {
      yieldedForScan = pause;
      dayResults.push({
        sessionDate: entry.sessionDate,
        outcome: "SKIPPED_GUARD",
        requests: 0,
        error: pause,
      });
      break;
    }

    try {
      const result = await sealOneDay(options, entry.sessionDate, withinWindow, clock);
      totalRequests += result.requests;
      dayResults.push(result);
      if (result.outcome === "SEALED" || result.outcome === "TOP50_ADDED") {
        sealed.push(entry.sessionDate);
        sealedCount += 1;
      } else if (result.outcome === "SKIPPED_GUARD") {
        yieldedForScan = result.error;
        break;
      } else if (result.outcome === "CORRUPT" && result.corruptKey) {
        corrupt.push({ sessionDate: entry.sessionDate, key: result.corruptKey });
        skippedThisRun.add(entry.sessionDate);
      } else if (result.outcome === "FAILED") {
        skippedThisRun.add(entry.sessionDate);
      } else if (result.outcome === "SKIPPED_NOT_SETTLED") {
        skippedNotSettled.push(entry.sessionDate);
      } else if (result.outcome === "SKIPPED_BASE_INPUT") {
        skippedThisRun.add(entry.sessionDate);
        skippedBaseInput.push({
          sessionDate: entry.sessionDate,
          input: result.baseInput ?? "unknown",
          key: result.baseInputKey ?? result.error ?? "",
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("SCAN_GUARD_WINDOW:") || message.startsWith("TIME_BUDGET:")) {
        yieldedForScan = message;
        dayResults.push({
          sessionDate: entry.sessionDate,
          outcome: "SKIPPED_GUARD",
          requests: 0,
          error: message,
        });
        break;
      }
      if (message.startsWith(TENMIN_DAY_OBJECT_CORRUPT)) {
        const key = extractCorruptKey(message);
        corrupt.push({ sessionDate: entry.sessionDate, key });
        skippedThisRun.add(entry.sessionDate);
        dayResults.push({
          sessionDate: entry.sessionDate,
          outcome: "CORRUPT",
          requests: 0,
          corruptKey: key,
          error: message,
        });
        continue;
      }
      if (
        error instanceof TenMinDailyBaseInputError ||
        message.startsWith(TENMIN_DAILY_BASE_INPUT_MISSING_PREFIX)
      ) {
        const baseErr = error instanceof TenMinDailyBaseInputError ? error : null;
        const input = baseErr?.input ?? message.split(":")[1] ?? "unknown";
        const key = baseErr?.key ?? message.split(":").slice(2).join(":");
        skippedThisRun.add(entry.sessionDate);
        skippedBaseInput.push({ sessionDate: entry.sessionDate, input, key });
        dayResults.push({
          sessionDate: entry.sessionDate,
          outcome: "SKIPPED_BASE_INPUT",
          requests: 0,
          error: message,
          baseInput: input,
          baseInputKey: key,
        });
        continue;
      }
      if (
        error instanceof TenMinDailyBaseFailedError ||
        message.startsWith(`${TENMIN_DAILY_BASE_INPUT_FAILED}:`)
      ) {
        const key =
          error instanceof TenMinDailyBaseFailedError
            ? error.key
            : message.split(":")[1] ?? message;
        skippedThisRun.add(entry.sessionDate);
        dayResults.push({
          sessionDate: entry.sessionDate,
          outcome: "FAILED",
          requests: 0,
          error: message,
          baseInputKey: key,
        });
        continue;
      }
      skippedThisRun.add(entry.sessionDate);
      dayResults.push({
        sessionDate: entry.sessionDate,
        outcome: "FAILED",
        requests: 0,
        error: message,
      });
    }
  }

  return {
    schemaVersion: TENMIN_DAILY_PICKS_RUN_SCHEMA,
    enabled: true,
    killSwitch,
    startedAt,
    completedAt: clock().toISOString(),
    backlogConsidered: backlog.length,
    days: dayResults,
    sealed,
    corrupt,
    skippedOutOfWindow,
    skippedNotSettled,
    skippedBaseInput,
    totalRequests,
    ...(yieldedForScan ? { yieldedForScan } : {}),
  };
}

async function sealOneDay(
  options: RunTenMinDailyPicksOptions,
  sessionDate: string,
  withinWindow: (d: string) => boolean,
  clock: () => Date,
): Promise<TenMinDailyPicksDayResult> {
  const store = options.store;
  const now = clock();
  const observedAt = options.observedAt ?? now.toISOString();
  const existing = await readTenMinDayPicks(store, sessionDate);

  if (existing.status === "SEALED" && existing.top50.state === "present") {
    return { sessionDate, outcome: "SEALED", requests: 0 };
  }

  if (existing.status === "SEALED" && existing.top50.state === "absent") {
    if (existing.top50.reason === "no_forward_scan") {
      return { sessionDate, outcome: "SEALED", requests: 0 };
    }
    if (!withinWindow(sessionDate)) {
      return { sessionDate, outcome: "SKIPPED_OUT_OF_WINDOW", requests: 0 };
    }
    const statuses = await options.storage.loadPredictionStatuses(sessionDate);
    const settlement = resolveDaySettlement(sessionDate, statuses, clock());
    if (settlement.kind !== "FROZEN") {
      return { sessionDate, outcome: "SKIPPED_NOT_SETTLED", requests: 0 };
    }
    const top50 = options.buildTop50 ? await options.buildTop50(sessionDate) : undefined;
    if (!top50) return { sessionDate, outcome: "SEALED", requests: 0 };
    const baseBytes = await loadExistingPicksBaseBytes(store, sessionDate);
    if (!baseBytes) throw new Error(`TENMIN_DAY_PICKS_MISSING:${sessionDate}`);
    const picksBase = parsePicksBaseBytes(baseBytes);
    const already = new Set(existing.securities.map((s) => s.securityId));
    let securities: TenMinDaySecurityInput[];
    let requests: number;
    try {
      ({ securities, requests } = await collectSecurities(
        options,
        sessionDate,
        top50.picks.filter((p) => !already.has(p.securityId)),
        clock,
      ));
    } catch (error) {
      if (error instanceof TenMinDailyFetchCutoffError) {
        return {
          sessionDate,
          outcome: "SKIPPED_GUARD",
          requests: error.requests,
          error: error.reason,
        };
      }
      throw error;
    }
    await writeTenMinDayTop50AddOn(store, {
      sessionDate,
      picksBase,
      picksTop50: top50,
      securities,
      observedAt,
      withinWindow: true,
    });
    return {
      sessionDate,
      outcome: "TOP50_ADDED",
      requests,
      ...(picksBase.groupedWithoutIndexEntry
        ? { groupedWithoutIndexEntry: picksBase.groupedWithoutIndexEntry }
        : {}),
    };
  }

  const statuses = await options.storage.loadPredictionStatuses(sessionDate);
  const settlement = resolveDaySettlement(sessionDate, statuses, clock());
  if (settlement.kind === "not_yet_frozen") {
    return { sessionDate, outcome: "SKIPPED_NOT_SETTLED", requests: 0 };
  }

  const existingPicksBytes = await loadExistingPicksBaseBytes(store, sessionDate);
  let picksBase: PicksBaseV1;
  if (existingPicksBytes) {
    picksBase = parsePicksBaseBytes(existingPicksBytes);
  } else {
    try {
      const builder =
        options.buildBase ??
        ((d: string) => buildTenMinDailyPicksBaseFromStored({ store: options.store, sessionDate: d }));
      picksBase = await builder(sessionDate);
    } catch (error) {
      if (error instanceof TenMinDailyBaseInputError) {
        return {
          sessionDate,
          outcome: "SKIPPED_BASE_INPUT",
          requests: 0,
          error: error.message,
          baseInput: error.input,
          baseInputKey: error.key,
        };
      }
      if (error instanceof TenMinDailyBaseCorruptError) {
        return {
          sessionDate,
          outcome: "CORRUPT",
          requests: 0,
          corruptKey: error.key,
          error: error.message,
        };
      }
      if (error instanceof TenMinDailyBaseFailedError) {
        return {
          sessionDate,
          outcome: "FAILED",
          requests: 0,
          error: error.message,
          baseInputKey: error.key,
        };
      }
      throw error;
    }
  }

  const picksTop50 =
    settlement.kind === "FROZEN" && options.buildTop50
      ? await options.buildTop50(sessionDate)
      : undefined;

  const merged = orderPicksForFetch(mergeDailyTenMinPicksV1(picksBase, picksTop50));
  let securities: TenMinDaySecurityInput[];
  let requests: number;
  try {
    ({ securities, requests } = await collectSecurities(options, sessionDate, merged, clock));
  } catch (error) {
    if (error instanceof TenMinDailyFetchCutoffError) {
      return {
        sessionDate,
        outcome: "SKIPPED_GUARD",
        requests: error.requests,
        error: error.reason,
      };
    }
    throw error;
  }

  await writeTenMinDayPicks(store, {
    sessionDate,
    picksBase,
    ...(picksTop50 ? { picksTop50 } : {}),
    predictionStatuses: statuses,
    securities,
    observedAt,
    settlementNow: clock(),
  });
  return {
    sessionDate,
    outcome: "SEALED",
    requests,
    ...(picksBase.groupedWithoutIndexEntry
      ? { groupedWithoutIndexEntry: picksBase.groupedWithoutIndexEntry }
      : {}),
  };
}


async function collectSecurities(
  options: RunTenMinDailyPicksOptions,
  sessionDate: string,
  picks: readonly PickV1Pick[] | readonly { securityId: string; symbol: string }[],
  clock: () => Date,
): Promise<{ securities: TenMinDaySecurityInput[]; requests: number }> {
  const securities: TenMinDaySecurityInput[] = [];
  let requests = 0;
  const backend = nodeReplyDustBackend;

  for (const pick of picks) {
    const key = tenMinDayObjectKey(sessionDate, pick.securityId, pick.symbol);
    const existing = await options.store.get(key);
    if (existing) {
      securities.push({
        securityId: pick.securityId,
        symbol: pick.symbol,
        status: "STORED",
      });
      continue;
    }

    // Live clock before EVERY fetch (guard window + optional injected yield).
    const t = clock();
    if (inScanGuardWindow(t)) {
      throw new TenMinDailyFetchCutoffError(`SCAN_GUARD_WINDOW:${t.toISOString()}`, requests);
    }
    if (options.shouldYield) {
      const pause = await options.shouldYield();
      if (pause) throw new TenMinDailyFetchCutoffError(pause, requests);
    }

    const body = await fetchOne(options, pick, sessionDate);
    requests += 1;

    // Persist immediately so a mid-day cutoff leaves priority names stored.
    const encoded = encodeReplyDust(body, backend);
    await putImmutableVerified(options.store, key, encoded, {
      "rd-schema": TENMIN_DAY_OBJECT_SCHEMA,
      "rd-file-sha256": sha256Hex(encoded),
      "rd-session-date": sessionDate,
      "rd-security-id": pick.securityId,
      "rd-symbol": pick.symbol,
    });

    securities.push({
      securityId: pick.securityId,
      symbol: pick.symbol,
      status: "STORED",
    });
  }
  return { securities, requests };
}

async function fetchOne(
  options: RunTenMinDailyPicksOptions,
  security: { securityId: string; symbol: string },
  sessionDate: string,
): Promise<Uint8Array> {
  if (options.fetchReply) return options.fetchReply(security, sessionDate);
  const provider = options.provider;
  if (!provider?.getTenMinuteRangeReplies)
    throw new Error("TENMIN_DAILY_FETCH_UNAVAILABLE");
  const pages = await provider.getTenMinuteRangeReplies(security, sessionDate, sessionDate);
  const first = pages[0];
  if (!first) throw new Error(`TENMIN_DAILY_EMPTY_REPLY:${security.securityId}`);
  return first.body;
}

/** Env entry for standalone / history-first phase. */
export async function runTenMinDailyPicksFromEnv(
  options: Omit<RunTenMinDailyPicksOptions, "env"> & { env?: NodeJS.ProcessEnv },
): Promise<TenMinDailyPicksRunReport | undefined> {
  const env = options.env ?? process.env;
  if (!tenMinDailyPicksEnabled(env)) return undefined;
  return runTenMinDailyPicks({ ...options, env });
}

/** Test helper: whether next session open after D has passed. */
export function nextSessionOpenPassed(sessionDate: string, now: Date): boolean {
  const next = nextSessionOpen(sessionDate);
  return !next || now.getTime() >= next.nextSessionOpen.getTime();
}
