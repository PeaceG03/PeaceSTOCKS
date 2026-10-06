import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecurityMasterRecord, TenMinuteRangeReply } from "./contracts";
import { FileReplyDustStore, type ReplyDustStore } from "./intraday-reply-dust";
import { MassiveMarketProvider } from "./massive-provider";
import { R2ObjectClient } from "./object-store";
import { openMarketStore } from "./object-storage";
import { type ZstdVersionProbe, assertPinnedZstdForWriting } from "./reply-dust-pin";
import { scanYieldReason } from "./scan-yield";
import type { SessionCalendar } from "./scanner";
import type { MarketStore } from "./storage";
import { MarketStorage } from "./storage";
import { prepareSafeStoreFile } from "./store-path";
import {
  type TenMinRangeGapEntry,
  type TenMinRangePlannedFetch,
  type TenMinRangeWriteResult,
  writeTenMinRangeReplyDust,
} from "./tenmin-range-reply-dust";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

/** Default Massive Basic ~2y floor for the history window. */
export const DEFAULT_TENMIN_HISTORY_WINDOW_START = "2024-10-07";

export const TENMIN_HISTORY_RUN_SCHEMA = "tenmin-history-run-v1" as const;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function requireDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("INVALID_SESSION_DATE");
}

/** Add `days` (may be negative) to a YYYY-MM-DD using UTC calendar arithmetic. */
export function addCalendarDays(date: string, days: number): string {
  requireDate(date);
  const cursor = new Date(`${date}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
}

/**
 * Subtract/add whole calendar years. Feb 29 → Feb 28 in a non-leap destination year
 * (UTC Date.setUTCFullYear clamps).
 */
export function addCalendarYears(date: string, years: number): string {
  requireDate(date);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const targetYear = year + years;
  // Clamp Feb 29 → last day of Feb in target year.
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);
  return `${targetYear}-${String(month).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
}

/**
 * Effective history window start: max(configured floor, lastCompletedSession − 2y + 2d).
 * On 2026-10-06 (last completed 2026-10-05) → max(2024-10-07, 2024-10-07) = 2024-10-07.
 */
export function effectiveHistoryWindowStart(
  lastCompletedSession: string,
  configuredWindowStart: string = DEFAULT_TENMIN_HISTORY_WINDOW_START,
): string {
  requireDate(lastCompletedSession);
  requireDate(configuredWindowStart);
  const retention = addCalendarDays(addCalendarYears(lastCompletedSession, -2), 2);
  return configuredWindowStart > retention ? configuredWindowStart : retention;
}

function lastDayOfMonth(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function firstDayOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function pairStartMonth(month: number): number {
  if (month === 11) return 10;
  if (month === 1) return 12;
  if (month % 2 === 0) return month;
  return month - 1;
}

function pairEndMonth(startMonth: number): number {
  return startMonth === 12 ? 1 : startMonth + 1;
}

export function pairRangeForDate(date: string): { calendarFrom: string; calendarTo: string } {
  requireDate(date);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const startMonth = pairStartMonth(month);
  const startYear = month === 1 ? year - 1 : year;
  const endMonth = pairEndMonth(startMonth);
  const endYear = startMonth === 12 ? startYear + 1 : startYear;
  return {
    calendarFrom: firstDayOfMonth(startYear, startMonth),
    calendarTo: lastDayOfMonth(endYear, endMonth),
  };
}

function nextPairRange(calendarTo: string): { calendarFrom: string; calendarTo: string } {
  requireDate(calendarTo);
  const year = Number(calendarTo.slice(0, 4));
  const month = Number(calendarTo.slice(5, 7));
  const nextStart = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return pairRangeForDate(firstDayOfMonth(nextStart.year, nextStart.month));
}

export function lastCompletedSessionDate(
  now: Date = new Date(),
  calendar: SessionCalendar = US_EQUITY_MARKET_CALENDAR,
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const today = `${value("year")}-${value("month")}-${value("day")}`;
  const cursor = new Date(`${today}T00:00:00Z`);
  for (let i = 0; i < 14; i += 1) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const date = cursor.toISOString().slice(0, 10);
    const kind = calendar.getSession(date).kind;
    if (kind === "NORMAL" || kind === "HALF_DAY") return date;
  }
  throw new Error("NO_COMPLETED_SESSION");
}

/**
 * One two-month history range. Folder keys use calendarFrom/calendarTo (stable). fetchFrom is
 * clamped to the effective window start on the first overlapping range.
 */
export interface TenMinHistoryRange {
  /** Stable folder identity start (e.g. 2024-10-01). */
  calendarFrom: string;
  /** Stable folder identity end (e.g. 2024-11-30). */
  calendarTo: string;
  /** Actual earliest date this run fetches inside the range (>= calendarFrom). */
  fetchFrom: string;
  fetchTo: string;
}

export interface TenMinHistoryPlan {
  windowStart: string;
  ranges: TenMinHistoryRange[];
  /** Calendar ranges entirely before the effective window (skipped). */
  skippedBefore: Array<{ calendarFrom: string; calendarTo: string }>;
}

/**
 * Two-calendar-month ranges oldest first. Folder identity is always the full calendar pair.
 * Effective window = max(configured, lastCompleted − 2y + 2d). Ranges entirely before the window
 * are skipped; the first overlapping range clamps fetchFrom to the window start.
 */
export function planTenMinHistoryRanges(options: {
  windowStart?: string;
  lastCompletedSession: string;
}): TenMinHistoryPlan {
  const configured = options.windowStart ?? DEFAULT_TENMIN_HISTORY_WINDOW_START;
  requireDate(options.lastCompletedSession);
  const windowStart = effectiveHistoryWindowStart(options.lastCompletedSession, configured);
  if (windowStart >= options.lastCompletedSession)
    return { windowStart, ranges: [], skippedBefore: [] };

  const first = pairRangeForDate(windowStart);
  // Walk from a range that could contain the configured floor, recording skips.
  let cursor = pairRangeForDate(
    configured < windowStart ? configured : windowStart,
  );
  // If configured is much earlier, start from a range near windowStart's pair.
  if (cursor.calendarTo < windowStart) cursor = first;

  // Also walk any earlier calendar pairs from configured for skippedBefore reporting.
  const skippedBefore: Array<{ calendarFrom: string; calendarTo: string }> = [];
  let skipCursor = pairRangeForDate(configured);
  while (skipCursor.calendarTo < windowStart) {
    skippedBefore.push({
      calendarFrom: skipCursor.calendarFrom,
      calendarTo: skipCursor.calendarTo,
    });
    const next = nextPairRange(skipCursor.calendarTo);
    if (next.calendarTo <= skipCursor.calendarTo) break;
    skipCursor = next;
    if (skippedBefore.length > 48) break;
  }

  const ranges: TenMinHistoryRange[] = [];
  let { calendarFrom, calendarTo } = first;
  for (;;) {
    if (calendarTo < options.lastCompletedSession && calendarTo >= windowStart) {
      const fetchFrom = windowStart > calendarFrom ? windowStart : calendarFrom;
      if (fetchFrom <= calendarTo)
        ranges.push({
          calendarFrom,
          calendarTo,
          fetchFrom,
          fetchTo: calendarTo,
        });
    } else if (calendarTo < windowStart) {
      // already in skippedBefore
    }
    const next = nextPairRange(calendarTo);
    if (next.calendarFrom >= options.lastCompletedSession) break;
    if (next.calendarTo <= calendarTo) break;
    calendarFrom = next.calendarFrom;
    calendarTo = next.calendarTo;
    if (ranges.length > 48) break;
  }
  return { windowStart, ranges, skippedBefore };
}

export interface TenMinUniverseSecurity {
  securityId: string;
  fetches: TenMinRangePlannedFetch[];
}

export interface TenMinUniversePlan {
  securities: TenMinUniverseSecurity[];
  /** Flattened planned fetches for the writer. */
  fetches: TenMinRangePlannedFetch[];
  gaps: TenMinRangeGapEntry[];
}

function listingInterval(security: SecurityMasterRecord): { from: string; to: string } {
  const from =
    security.listingDate ??
    security.historicalSymbols.map((h) => h.effectiveFrom).sort(byCodeUnit)[0] ??
    security.firstSeenAt;
  const to = security.delistedAt ?? security.inactiveAt ?? "9999-12-31";
  return { from, to };
}

function overlaps(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom <= bTo && aTo >= bFrom;
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

/**
 * Securities whose listing overlaps [rangeFetchFrom, rangeFetchTo]. Every historicalSymbols
 * ticker whose span overlaps is planned for its own sub-span
 * [max(effectiveFrom, rangeFetchFrom, listedFrom), min(effectiveTo, rangeFetchTo, listedTo)].
 */
export function universeForTenMinRange(
  securities: readonly SecurityMasterRecord[],
  rangeFetchFrom: string,
  rangeFetchTo: string,
  nowIso: string = new Date().toISOString(),
): TenMinUniversePlan {
  requireDate(rangeFetchFrom);
  requireDate(rangeFetchTo);
  const planned: TenMinUniverseSecurity[] = [];
  const gaps: TenMinRangeGapEntry[] = [];
  for (const security of [...securities].sort((a, b) => byCodeUnit(a.securityId, b.securityId))) {
    const listed = listingInterval(security);
    if (!overlaps(listed.from, listed.to, rangeFetchFrom, rangeFetchTo)) continue;
    const overlapping = security.historicalSymbols.filter((entry) =>
      overlaps(entry.effectiveFrom, entry.effectiveTo ?? "9999-12-31", rangeFetchFrom, rangeFetchTo),
    );
    if (!overlapping.length) {
      if (!security.historicalSymbols.length && security.currentSymbol) {
        const fetchFrom = maxDate(rangeFetchFrom, listed.from);
        const fetchTo = minDate(rangeFetchTo, listed.to);
        if (fetchFrom <= fetchTo) {
          const fetch: TenMinRangePlannedFetch = {
            securityId: security.securityId,
            symbol: security.currentSymbol,
            fetchFrom,
            fetchTo,
          };
          planned.push({ securityId: security.securityId, fetches: [fetch] });
        }
        continue;
      }
      gaps.push({
        securityId: security.securityId,
        symbol: "",
        reason: "NO_HISTORICAL_SYMBOL",
        at: nowIso,
      });
      continue;
    }
    const fetches: TenMinRangePlannedFetch[] = [];
    for (const entry of overlapping) {
      const fetchFrom = maxDate(maxDate(entry.effectiveFrom, rangeFetchFrom), listed.from);
      const fetchTo = minDate(
        minDate(entry.effectiveTo ?? rangeFetchTo, rangeFetchTo),
        listed.to,
      );
      if (fetchFrom > fetchTo) continue;
      fetches.push({
        securityId: security.securityId,
        symbol: entry.symbol,
        fetchFrom,
        fetchTo,
      });
    }
    fetches.sort(
      (a, b) =>
        byCodeUnit(a.fetchFrom, b.fetchFrom) ||
        byCodeUnit(a.fetchTo, b.fetchTo) ||
        byCodeUnit(a.symbol, b.symbol),
    );
    if (!fetches.length) {
      gaps.push({
        securityId: security.securityId,
        symbol: "",
        reason: "NO_HISTORICAL_SYMBOL",
        at: nowIso,
      });
      continue;
    }
    planned.push({ securityId: security.securityId, fetches });
  }
  return {
    securities: planned,
    fetches: planned.flatMap((s) => s.fetches),
    gaps,
  };
}

export interface TenMinHistoryRangeReport {
  calendarFrom: string;
  calendarTo: string;
  fetchFrom: string;
  fetchTo: string;
  status: "SEALED" | "ALREADY_SEALED" | "PARTIAL" | "REOPENED" | "OUTAGE_STOP";
  securitiesPlanned: number;
  fetchesPlanned: number;
  securitiesWritten: number;
  securitiesResumed: number;
  gaps: TenMinRangeGapEntry[];
  symbolChangeWarnings: string[];
  fallbackFiles: number;
  massiveRequests: number;
  zstdVersion: string;
}

export interface TenMinHistoryRunReport {
  schemaVersion: typeof TENMIN_HISTORY_RUN_SCHEMA;
  runId: string;
  provider: string;
  configuredWindowStart: string;
  windowStart: string;
  lastCompletedSession: string;
  skippedBefore: Array<{ calendarFrom: string; calendarTo: string }>;
  reopen: boolean;
  ranges: TenMinHistoryRangeReport[];
  yieldedForScan?: string;
  outageStop?: string;
  stoppedOnError: boolean;
  error?: string;
  warnings: string[];
  zstdVersion: string;
  massiveRequests: number;
  completedAt: string;
}

export interface TenMinHistoryRunResult {
  report: TenMinHistoryRunReport;
  rangeResults: TenMinRangeWriteResult[];
}

function openTenMinReplyDustStore(root: string, env: NodeJS.ProcessEnv): ReplyDustStore {
  if (env.PEACESTOCKS_R2_BUCKET?.trim()) return R2ObjectClient.fromEnv(env);
  if (env.PEACESTOCKS_REQUIRE_OBJECT_STORE === "1") throw new Error("OBJECT_STORE_REQUIRED");
  return new FileReplyDustStore(root);
}

export async function runTenMinHistory(options: {
  root: string;
  store?: ReplyDustStore;
  storage?: MarketStore;
  provider?: MassiveMarketProvider;
  providerName?: string;
  securities?: readonly SecurityMasterRecord[];
  windowStart?: string;
  lastCompletedSession?: string;
  maxRanges?: number;
  reopen?: boolean;
  deadlineMs?: number;
  shouldYield?: () => Promise<string | undefined>;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  nowIso?: () => string;
  zstdVersionProbe?: ZstdVersionProbe;
  fetchPages?: (
    security: { securityId: string; symbol: string },
    from: string,
    to: string,
  ) => Promise<TenMinuteRangeReply[]>;
  writeReport?: boolean;
}): Promise<TenMinHistoryRunResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const stamp = options.nowIso ?? (() => new Date().toISOString());
  const zstdVersion = assertPinnedZstdForWriting(options.zstdVersionProbe);
  const root = options.root;
  const storage = options.storage ?? openMarketStore(root, env);
  await storage.initialize();
  const store = options.store ?? openTenMinReplyDustStore(root, env);
  if (
    env.PEACESTOCKS_REQUIRE_OBJECT_STORE === "1" &&
    !env.PEACESTOCKS_R2_BUCKET?.trim() &&
    !(storage instanceof MarketStorage) &&
    !options.store
  )
    throw new Error("OBJECT_STORE_REQUIRED");

  const provider = options.provider ?? new MassiveMarketProvider({ keepRawReplies: true });
  const providerName = options.providerName ?? provider.providerName;
  const fetchPages =
    options.fetchPages ??
    ((security, from, to) => {
      if (!provider.getTenMinuteRangeReplies) throw new Error("TENMIN_RANGE_PROVIDER_UNSUPPORTED");
      return provider.getTenMinuteRangeReplies(security, from, to);
    });

  const shouldYield =
    options.shouldYield ??
    (env.GITHUB_ACTIONS === "true"
      ? async () => {
          if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs)
            return `TIME_BUDGET:${stamp()}`;
          return scanYieldReason({ env });
        }
      : async () => {
          if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs)
            return `TIME_BUDGET:${stamp()}`;
          return undefined;
        });

  const lastCompleted = options.lastCompletedSession ?? lastCompletedSessionDate(now);
  const configuredWindowStart = options.windowStart ?? DEFAULT_TENMIN_HISTORY_WINDOW_START;
  const plan = planTenMinHistoryRanges({
    windowStart: configuredWindowStart,
    lastCompletedSession: lastCompleted,
  });
  const ranges = plan.ranges.slice(0, options.maxRanges ?? Number.MAX_SAFE_INTEGER);
  const securities = options.securities ?? (await storage.loadSecurities());
  const reopen = options.reopen === true;
  const runId = `tenmin-history-${stamp().replaceAll(/[^0-9]/gu, "").slice(0, 17)}`;
  const rangeReports: TenMinHistoryRangeReport[] = [];
  const rangeResults: TenMinRangeWriteResult[] = [];
  const warnings: string[] = [];
  let massiveRequests = 0;
  let yieldedForScan: string | undefined;
  let outageStop: string | undefined;
  let stoppedOnError = false;
  let error: string | undefined;

  for (const range of ranges) {
    const pause = await shouldYield();
    if (pause) {
      yieldedForScan = pause;
      break;
    }
    const universe = universeForTenMinRange(
      securities,
      range.fetchFrom,
      range.fetchTo,
      stamp(),
    );
    try {
      const result = await writeTenMinRangeReplyDust({
        store,
        root,
        provider: providerName,
        from: range.calendarFrom,
        to: range.calendarTo,
        fetches: universe.fetches,
        initialGaps: universe.gaps,
        ...(reopen ? { reopen: true } : {}),
        shouldYield,
        fetchPages,
        ...(options.zstdVersionProbe ? { zstdVersionProbe: options.zstdVersionProbe } : {}),
        now: stamp,
      });
      rangeResults.push(result);
      massiveRequests += result.massiveRequests;
      const symbolWarnings = (result.warnings ?? []).filter((w) =>
        w.startsWith("TENMIN_RANGE_SYMBOL_CHANGED:"),
      );
      warnings.push(...(result.warnings ?? []));
      if (result.outageStop) {
        outageStop = result.outageStop;
        rangeReports.push({
          calendarFrom: range.calendarFrom,
          calendarTo: range.calendarTo,
          fetchFrom: range.fetchFrom,
          fetchTo: range.fetchTo,
          status: "OUTAGE_STOP",
          securitiesPlanned: universe.securities.length + universe.gaps.length,
          fetchesPlanned: universe.fetches.length,
          securitiesWritten: result.securitiesWritten.length,
          securitiesResumed: result.securitiesResumed.length,
          gaps: result.gaps,
          symbolChangeWarnings: symbolWarnings,
          fallbackFiles: result.fallbackFiles,
          massiveRequests: result.massiveRequests,
          zstdVersion: result.zstdVersion,
        });
        break;
      }
      if (result.yieldedForScan) {
        yieldedForScan = result.yieldedForScan;
        rangeReports.push({
          calendarFrom: range.calendarFrom,
          calendarTo: range.calendarTo,
          fetchFrom: range.fetchFrom,
          fetchTo: range.fetchTo,
          status: "PARTIAL",
          securitiesPlanned: universe.securities.length + universe.gaps.length,
          fetchesPlanned: universe.fetches.length,
          securitiesWritten: result.securitiesWritten.length,
          securitiesResumed: result.securitiesResumed.length,
          gaps: result.gaps,
          symbolChangeWarnings: symbolWarnings,
          fallbackFiles: result.fallbackFiles,
          massiveRequests: result.massiveRequests,
          zstdVersion: result.zstdVersion,
        });
        break;
      }
      const status: TenMinHistoryRangeReport["status"] = result.alreadySealed
        ? "ALREADY_SEALED"
        : reopen
          ? "REOPENED"
          : "SEALED";
      rangeReports.push({
        calendarFrom: range.calendarFrom,
        calendarTo: range.calendarTo,
        fetchFrom: range.fetchFrom,
        fetchTo: range.fetchTo,
        status,
        securitiesPlanned: universe.securities.length + universe.gaps.length,
        fetchesPlanned: universe.fetches.length,
        securitiesWritten: result.securitiesWritten.length,
        securitiesResumed: result.securitiesResumed.length,
        gaps: result.gaps,
        symbolChangeWarnings: symbolWarnings,
        fallbackFiles: result.fallbackFiles,
        massiveRequests: result.massiveRequests,
        zstdVersion: result.zstdVersion,
      });
    } catch (err) {
      stoppedOnError = true;
      error = err instanceof Error ? err.message : String(err);
      break;
    }
  }

  const report: TenMinHistoryRunReport = {
    schemaVersion: TENMIN_HISTORY_RUN_SCHEMA,
    runId,
    provider: providerName,
    configuredWindowStart,
    windowStart: plan.windowStart,
    lastCompletedSession: lastCompleted,
    skippedBefore: plan.skippedBefore,
    reopen,
    ranges: rangeReports,
    ...(yieldedForScan ? { yieldedForScan } : {}),
    ...(outageStop ? { outageStop } : {}),
    stoppedOnError,
    ...(error ? { error } : {}),
    warnings: [...new Set(warnings)],
    zstdVersion,
    massiveRequests,
    completedAt: stamp(),
  };

  if (options.writeReport !== false) {
    const key = `transient/tenmin-history-runs/${runId}.json`;
    const bytes = new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`);
    try {
      await store.put(key, bytes);
    } catch {
      try {
        const target = prepareSafeStoreFile(join(root, key), "TENMIN_HISTORY_PATH_INVALID");
        await writeFile(target, bytes);
      } catch {
        // ignore
      }
    }
  }

  return { report, rangeResults };
}

export async function runTenMinHistoryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Parameters<typeof runTenMinHistory>[0]> = {},
): Promise<TenMinHistoryRunResult | undefined> {
  if (env.PEACESTOCKS_TENMIN_HISTORY !== "1") return undefined;
  const root =
    overrides.root ??
    env.PEACEAI_MARKETS_ROOT ??
    env.MARKETS_STORAGE_ROOT ??
    "C:\\ProgramData\\PeaceAI\\Markets";
  const maxRanges = env.PEACESTOCKS_TENMIN_HISTORY_MAX_RANGES
    ? Number(env.PEACESTOCKS_TENMIN_HISTORY_MAX_RANGES)
    : undefined;
  const budgetMs = env.PEACESTOCKS_TENMIN_HISTORY_BUDGET_MS
    ? Number(env.PEACESTOCKS_TENMIN_HISTORY_BUDGET_MS)
    : undefined;
  const deadlineMs =
    budgetMs !== undefined && Number.isFinite(budgetMs) ? Date.now() + budgetMs : undefined;
  return runTenMinHistory({
    root,
    env,
    reopen: env.PEACESTOCKS_TENMIN_HISTORY_REOPEN === "1",
    ...(maxRanges !== undefined && Number.isFinite(maxRanges) ? { maxRanges } : {}),
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    ...overrides,
  });
}
