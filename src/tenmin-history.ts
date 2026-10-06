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
  type TenMinRangeWriteResult,
  writeTenMinRangeReplyDust,
} from "./tenmin-range-reply-dust";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

/** Default Massive Basic ~2y window start for 10-minute history ranges. */
export const DEFAULT_TENMIN_HISTORY_WINDOW_START = "2024-10-07";

export const TENMIN_HISTORY_RUN_SCHEMA = "tenmin-history-run-v1" as const;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function requireDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("INVALID_SESSION_DATE");
}

function lastDayOfMonth(year: number, month: number): string {
  // month is 1-based; day 0 of next month is last day of this month.
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function firstDayOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

/** Two-month pair start months: Oct, Dec, Feb, Apr, Jun, Aug (aligned so Oct-Nov is one range). */
function pairStartMonth(month: number): number {
  if (month === 11) return 10;
  if (month === 1) return 12;
  if (month % 2 === 0) return month;
  return month - 1;
}

function pairEndMonth(startMonth: number): number {
  return startMonth === 12 ? 1 : startMonth + 1;
}

function pairRangeForDate(date: string): { from: string; to: string } {
  requireDate(date);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const startMonth = pairStartMonth(month);
  const startYear = month === 1 ? year - 1 : year;
  const endMonth = pairEndMonth(startMonth);
  const endYear = startMonth === 12 ? startYear + 1 : startYear;
  return {
    from: firstDayOfMonth(startYear, startMonth),
    to: lastDayOfMonth(endYear, endMonth),
  };
}

function nextPairRange(to: string): { from: string; to: string } {
  requireDate(to);
  const year = Number(to.slice(0, 4));
  const month = Number(to.slice(5, 7));
  // to is the last day of a pair-end month; next starts on the following month.
  const nextStart = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const start = firstDayOfMonth(nextStart.year, nextStart.month);
  return pairRangeForDate(start);
}

/**
 * Most recent eligible (NORMAL/HALF_DAY) session strictly before today's America/New_York date.
 * History ranges must end before this date.
 */
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

export interface TenMinHistoryRange {
  from: string;
  to: string;
}

/**
 * Two-calendar-month history ranges, oldest first. The first range is clamped so it starts at
 * `windowStart` (default 2024-10-07 → 2024-10-07..2024-11-30). Ranges whose end is not strictly
 * before `lastCompletedSession` are excluded (current/incomplete range is never included).
 */
export function planTenMinHistoryRanges(options: {
  windowStart?: string;
  lastCompletedSession: string;
}): TenMinHistoryRange[] {
  const windowStart = options.windowStart ?? DEFAULT_TENMIN_HISTORY_WINDOW_START;
  requireDate(windowStart);
  requireDate(options.lastCompletedSession);
  if (windowStart >= options.lastCompletedSession) return [];
  const first = pairRangeForDate(windowStart);
  let from = windowStart > first.from ? windowStart : first.from;
  let to = first.to;
  const output: TenMinHistoryRange[] = [];
  for (;;) {
    if (to < options.lastCompletedSession && from <= to) output.push({ from, to });
    const next = nextPairRange(to);
    if (next.from >= options.lastCompletedSession) break;
    // Stop if we cannot make progress (safety).
    if (next.to <= to) break;
    from = next.from;
    to = next.to;
    // Cap runaway plans (Massive Basic ~2y is far smaller).
    if (output.length > 48) break;
  }
  return output;
}

export interface TenMinUniverseSecurity {
  securityId: string;
  /** Historical ticker valid for the range (deterministic choice when several overlap). */
  symbol: string;
  /** How the ticker was chosen when more than one historicalSymbols entry overlapped. */
  symbolChoice?: "SOLE_OVERLAP" | "MAX_COVERAGE" | "CURRENT_FALLBACK";
}

export interface TenMinUniversePlan {
  securities: TenMinUniverseSecurity[];
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

function coverageDays(overlapFrom: string, overlapTo: string): number {
  if (overlapFrom > overlapTo) return 0;
  const start = Date.parse(`${overlapFrom}T00:00:00Z`);
  const end = Date.parse(`${overlapTo}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

/**
 * Securities whose listing interval overlaps [from, to], each with the historical ticker that
 * covers the most of the range (ties: earlier effectiveFrom, then symbol code-unit order). Delisted
 * names are included. No known ticker → gap NO_HISTORICAL_SYMBOL.
 */
export function universeForTenMinRange(
  securities: readonly SecurityMasterRecord[],
  from: string,
  to: string,
  nowIso: string = new Date().toISOString(),
): TenMinUniversePlan {
  requireDate(from);
  requireDate(to);
  const planned: TenMinUniverseSecurity[] = [];
  const gaps: TenMinRangeGapEntry[] = [];
  for (const security of [...securities].sort((a, b) => byCodeUnit(a.securityId, b.securityId))) {
    const listed = listingInterval(security);
    if (!overlaps(listed.from, listed.to, from, to)) continue;
    const overlapping = security.historicalSymbols.filter((entry) =>
      overlaps(entry.effectiveFrom, entry.effectiveTo ?? "9999-12-31", from, to),
    );
    if (!overlapping.length) {
      // No historical span: only fall back to currentSymbol when history is empty entirely.
      if (!security.historicalSymbols.length && security.currentSymbol) {
        planned.push({
          securityId: security.securityId,
          symbol: security.currentSymbol,
          symbolChoice: "CURRENT_FALLBACK",
        });
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
    const scored = overlapping
      .map((entry) => {
        const overlapFrom = entry.effectiveFrom > from ? entry.effectiveFrom : from;
        const end = entry.effectiveTo ?? to;
        const overlapTo = end < to ? end : to;
        return { entry, days: coverageDays(overlapFrom, overlapTo) };
      })
      .sort(
        (a, b) =>
          b.days - a.days ||
          byCodeUnit(a.entry.effectiveFrom, b.entry.effectiveFrom) ||
          byCodeUnit(a.entry.symbol, b.entry.symbol),
      );
    const best = scored[0]!;
    planned.push({
      securityId: security.securityId,
      symbol: best.entry.symbol,
      symbolChoice: overlapping.length === 1 ? "SOLE_OVERLAP" : "MAX_COVERAGE",
    });
  }
  return { securities: planned, gaps };
}

export interface TenMinHistoryRangeReport {
  from: string;
  to: string;
  status: "SEALED" | "ALREADY_SEALED" | "PARTIAL" | "REOPENED";
  securitiesPlanned: number;
  securitiesWritten: number;
  securitiesResumed: number;
  gaps: TenMinRangeGapEntry[];
  symbolChangeWarnings: string[];
  fallbackFiles: number;
  massiveRequests: number;
  zstdVersion: string;
  symbolChoices?: Array<{ securityId: string; symbol: string; choice: string }>;
}

export interface TenMinHistoryRunReport {
  schemaVersion: typeof TENMIN_HISTORY_RUN_SCHEMA;
  runId: string;
  provider: string;
  windowStart: string;
  lastCompletedSession: string;
  reopen: boolean;
  ranges: TenMinHistoryRangeReport[];
  yieldedForScan?: string;
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

/**
 * Process whole two-month ranges oldest-first. Within a range every overlapping security is
 * requested once (plus next_url pages). Yields between securities for the daily scan / guard
 * windows / time budget; per-security Massive failures become gaps and the range still seals.
 */
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
  /** Wall-clock deadline; checked between securities / ranges. */
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
  /** When false, do not persist the run report via MarketStore.writeRunReport. Default true. */
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

  const provider =
    options.provider ??
    new MassiveMarketProvider({ keepRawReplies: true });
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

  const lastCompleted =
    options.lastCompletedSession ?? lastCompletedSessionDate(now);
  const windowStart = options.windowStart ?? DEFAULT_TENMIN_HISTORY_WINDOW_START;
  const ranges = planTenMinHistoryRanges({
    windowStart,
    lastCompletedSession: lastCompleted,
  }).slice(0, options.maxRanges ?? Number.MAX_SAFE_INTEGER);

  const securities = options.securities ?? (await storage.loadSecurities());
  const reopen = options.reopen === true;
  const runId = `tenmin-history-${stamp().replaceAll(/[^0-9]/gu, "").slice(0, 17)}`;
  const rangeReports: TenMinHistoryRangeReport[] = [];
  const rangeResults: TenMinRangeWriteResult[] = [];
  const warnings: string[] = [];
  let massiveRequests = 0;
  let yieldedForScan: string | undefined;
  let stoppedOnError = false;
  let error: string | undefined;

  for (const range of ranges) {
    const pause = await shouldYield();
    if (pause) {
      yieldedForScan = pause;
      break;
    }
    const universe = universeForTenMinRange(securities, range.from, range.to, stamp());
    try {
      const result = await writeTenMinRangeReplyDust({
        store,
        root,
        provider: providerName,
        from: range.from,
        to: range.to,
        securities: universe.securities.map((s) => ({
          securityId: s.securityId,
          symbol: s.symbol,
        })),
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
      if (result.yieldedForScan) {
        yieldedForScan = result.yieldedForScan;
        rangeReports.push({
          from: range.from,
          to: range.to,
          status: "PARTIAL",
          securitiesPlanned: universe.securities.length + universe.gaps.length,
          securitiesWritten: result.securitiesWritten.length,
          securitiesResumed: result.securitiesResumed.length,
          gaps: result.gaps,
          symbolChangeWarnings: symbolWarnings,
          fallbackFiles: result.fallbackFiles,
          massiveRequests: result.massiveRequests,
          zstdVersion: result.zstdVersion,
          symbolChoices: universe.securities
            .filter((s) => s.symbolChoice)
            .map((s) => ({
              securityId: s.securityId,
              symbol: s.symbol,
              choice: s.symbolChoice!,
            })),
        });
        break;
      }
      const status: TenMinHistoryRangeReport["status"] = result.alreadySealed
        ? "ALREADY_SEALED"
        : reopen
          ? "REOPENED"
          : "SEALED";
      rangeReports.push({
        from: range.from,
        to: range.to,
        status,
        securitiesPlanned: universe.securities.length + universe.gaps.length,
        securitiesWritten: result.securitiesWritten.length,
        securitiesResumed: result.securitiesResumed.length,
        gaps: result.gaps,
        symbolChangeWarnings: symbolWarnings,
        fallbackFiles: result.fallbackFiles,
        massiveRequests: result.massiveRequests,
        zstdVersion: result.zstdVersion,
        symbolChoices: universe.securities
          .filter((s) => s.symbolChoice)
          .map((s) => ({
            securityId: s.securityId,
            symbol: s.symbol,
            choice: s.symbolChoice!,
          })),
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
    windowStart,
    lastCompletedSession: lastCompleted,
    reopen,
    ranges: rangeReports,
    ...(yieldedForScan ? { yieldedForScan } : {}),
    stoppedOnError,
    ...(error ? { error } : {}),
    warnings: [...new Set(warnings)],
    zstdVersion,
    massiveRequests,
    completedAt: stamp(),
  };

  if (options.writeReport !== false) {
    // Dedicated prefix: never write into runs/ (scanner loadRunReports would treat these as sessions).
    const key = `transient/tenmin-history-runs/${runId}.json`;
    const bytes = new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`);
    try {
      await store.put(key, bytes);
    } catch {
      try {
        const target = prepareSafeStoreFile(join(root, key), "TENMIN_HISTORY_PATH_INVALID");
        await writeFile(target, bytes);
      } catch {
        // Report persistence must not hide the run outcome; caller still gets `report`.
      }
    }
  }

  return { report, rangeResults };
}

/** Host entry: run only when PEACESTOCKS_TENMIN_HISTORY=1. Returns undefined when the mode is off. */
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

