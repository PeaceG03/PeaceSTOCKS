import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecurityMasterRecord, TenMinuteRangeReply } from "./contracts";
import { type DailyBarSessionIndex, monthsBetween } from "./daily-bar-sessions";
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
  tenMinMassiveRequestsOf,
  TENMIN_AGED_OUT,
  TENMIN_DELISTED_COVERAGE_MISSING,
  type TenMinDelistedCoverage,
  tenMinRangeDelistedCoverage,
  TENMIN_UNIVERSE_EMPTY,
  isEmptyTenMinRangeManifest,
  readTenMinRangeManifest,
  type TenMinRangeGapEntry,
  type TenMinRangePlannedFetch,
  type TenMinRangeWriteResult,
  writeTenMinRangeReplyDust,
} from "./tenmin-range-reply-dust";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

/** Default Massive Basic ~2y floor for the history window. */
export const DEFAULT_TENMIN_HISTORY_WINDOW_START = "2024-10-07";

export const TENMIN_HISTORY_RUN_SCHEMA = "tenmin-history-run-v1" as const;

/** A range whose plan has no fetches is never sealed; the run stops with this error. */
export { TENMIN_UNIVERSE_EMPTY };

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

/**
 * First calendar day of the first history range. Ranges are two calendar months anchored here
 * (2024-11-01_2024-12-31, 2025-01-01_2025-02-28, ...); nothing before it is planned. Window days
 * before it are reported as SKIPPED_BEFORE_FIRST_RANGE (a choice, not an error). Change it here.
 */
export const TENMIN_HISTORY_FIRST_RANGE_START = "2024-11-01";
export const TENMIN_SKIPPED_BEFORE_FIRST_RANGE = "SKIPPED_BEFORE_FIRST_RANGE" as const;
/** Range-level gap for days of an unsealed range that fell out of the window before it sealed. */
export { TENMIN_AGED_OUT };

function lastDayOfMonth(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function firstDayOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

/** The two-calendar-month pair containing date, with pairs anchored on firstRangeStart's month. */
export function pairRangeForDate(
  date: string,
  firstRangeStart: string = TENMIN_HISTORY_FIRST_RANGE_START,
): { calendarFrom: string; calendarTo: string } {
  requireDate(date);
  requireDate(firstRangeStart);
  const anchorMonth = Number(firstRangeStart.slice(5, 7));
  let year = Number(date.slice(0, 4));
  let month = Number(date.slice(5, 7));
  if ((((month - anchorMonth) % 2) + 2) % 2 === 1) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  const endYear = month === 12 ? year + 1 : year;
  const endMonth = month === 12 ? 1 : month + 1;
  return { calendarFrom: firstDayOfMonth(year, month), calendarTo: lastDayOfMonth(endYear, endMonth) };
}

function nextPairRange(
  calendarTo: string,
  firstRangeStart: string,
): { calendarFrom: string; calendarTo: string } {
  return pairRangeForDate(addCalendarDays(calendarTo, 1), firstRangeStart);
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
 * clamped to the effective window start when the window starts inside the range.
 */
export interface TenMinHistoryRange {
  /** Stable folder identity start (e.g. 2024-11-01). */
  calendarFrom: string;
  /** Stable folder identity end (e.g. 2024-12-31). */
  calendarTo: string;
  /** Actual earliest date this run fetches inside the range (>= calendarFrom). */
  fetchFrom: string;
  fetchTo: string;
  /**
   * Calendar-day span [calendarFrom, fetchFrom - 1] that left the window before the range sealed
   * (a calendar date span, not a trading-session list). Recorded as one range-level AGED_OUT gap.
   */
  agedOut?: { from: string; to: string };
}

export interface TenMinSkippedBeforeFirstRange {
  /** Window start (inclusive). */
  from: string;
  /** Day before TENMIN_HISTORY_FIRST_RANGE_START (inclusive). */
  to: string;
  reason: typeof TENMIN_SKIPPED_BEFORE_FIRST_RANGE;
}

export interface TenMinHistoryPlan {
  windowStart: string;
  ranges: TenMinHistoryRange[];
  /** Anchored ranges entirely before the effective window (aged out; not planned). */
  skippedBefore: Array<{ calendarFrom: string; calendarTo: string }>;
  /** Window days before the first range start, skipped on purpose. */
  skippedBeforeFirstRange?: TenMinSkippedBeforeFirstRange;
}

/**
 * Two-calendar-month ranges oldest first, anchored on TENMIN_HISTORY_FIRST_RANGE_START; nothing
 * before it is planned. Effective window = max(configured, lastCompleted - 2y + 2d), applied
 * inside each range's fetch span. Only ranges that ended before lastCompleted are planned.
 */
export function planTenMinHistoryRanges(options: {
  windowStart?: string;
  lastCompletedSession: string;
  firstRangeStart?: string;
}): TenMinHistoryPlan {
  const configured = options.windowStart ?? DEFAULT_TENMIN_HISTORY_WINDOW_START;
  const firstRangeStart = options.firstRangeStart ?? TENMIN_HISTORY_FIRST_RANGE_START;
  requireDate(options.lastCompletedSession);
  requireDate(firstRangeStart);
  if (firstRangeStart.slice(8) !== "01") throw new Error("TENMIN_FIRST_RANGE_START_NOT_MONTH_START");
  const windowStart = effectiveHistoryWindowStart(options.lastCompletedSession, configured);
  const skippedBeforeFirstRange: TenMinSkippedBeforeFirstRange | undefined =
    windowStart < firstRangeStart
      ? {
          from: windowStart,
          to: addCalendarDays(firstRangeStart, -1),
          reason: TENMIN_SKIPPED_BEFORE_FIRST_RANGE,
        }
      : undefined;
  const result = (ranges: TenMinHistoryRange[], skippedBefore: TenMinHistoryPlan["skippedBefore"]) => ({
    windowStart,
    ranges,
    skippedBefore,
    ...(skippedBeforeFirstRange ? { skippedBeforeFirstRange } : {}),
  });
  if (windowStart >= options.lastCompletedSession) return result([], []);

  const ranges: TenMinHistoryRange[] = [];
  const skippedBefore: Array<{ calendarFrom: string; calendarTo: string }> = [];
  let cursor = pairRangeForDate(firstRangeStart, firstRangeStart);
  for (let i = 0; i < 240 && cursor.calendarTo < options.lastCompletedSession; i += 1) {
    const { calendarFrom, calendarTo } = cursor;
    if (calendarTo < windowStart) skippedBefore.push({ calendarFrom, calendarTo });
    else {
      const fetchFrom = windowStart > calendarFrom ? windowStart : calendarFrom;
      ranges.push({
        calendarFrom,
        calendarTo,
        fetchFrom,
        fetchTo: calendarTo,
        ...(fetchFrom > calendarFrom
          ? { agedOut: { from: calendarFrom, to: addCalendarDays(fetchFrom, -1) } }
          : {}),
      });
    }
    cursor = nextPairRange(calendarTo, firstRangeStart);
  }
  return result(ranges, skippedBefore);
}

export interface TenMinUniverseSecurity {
  securityId: string;
  fetches: TenMinRangePlannedFetch[];
}

/** Refuse to seal when planned securities < this × the median distinct securities per session. */
export const TENMIN_MIN_UNIVERSE_RATIO = 0.8;
export const TENMIN_DAILY_COVERAGE_HOLE = "TENMIN_DAILY_COVERAGE_HOLE";
export const TENMIN_UNIVERSE_TOO_SMALL = "TENMIN_UNIVERSE_TOO_SMALL";
/** Known gap (not an error): in the master but no stored daily bar inside the range. */
export const TENMIN_NO_DAILY_BAR = "NO_DAILY_BAR" as const;
export const TENMIN_NO_DAILY_BAR_SAMPLE_SIZE = 50;
/** The securityId -> ticker link comes from today's master, not point-in-time evidence. */
export const TENMIN_SECURITY_LINK = "PROVISIONAL" as const;

export interface TenMinUniversePlan {
  securities: TenMinUniverseSecurity[];
  /** Flattened planned fetches for the writer. */
  fetches: TenMinRangePlannedFetch[];
  /** NO_HISTORICAL_SYMBOL gaps: daily bars in range but no usable ticker in the master. */
  gaps: TenMinRangeGapEntry[];
  /** Trading sessions in [fetchFrom, fetchTo] by the session calendar. */
  tradingSessions: string[];
  /** Trading sessions with zero stored daily bars (any one blocks sealing). */
  missingSessions: string[];
  /** Median distinct securities with a stored bar per trading session. */
  medianSecuritiesPerSession: number;
  noDailyBarCount: number;
  noDailyBarSample: string[];
  /**
   * Securities whose master shows more than one held ticker but whose bar dates fall outside
   * every effective span, so currentSymbol (the backfill's binding) was used.
   */
  currentSymbolFallbackCount: number;
  securityLink: typeof TENMIN_SECURITY_LINK;
  /** Object metadata rd-link value, e.g. provisional-master-2026-10-05. */
  linkSource: string;
  /** Set when the range must not be fetched or sealed. */
  refusal?: { code: string; message: string };
}

/** Trading sessions (NORMAL or HALF_DAY) in [from, to], from the same calendar the planner uses. */
export function tradingSessionsBetween(
  from: string,
  to: string,
  calendar: SessionCalendar = US_EQUITY_MARKET_CALENDAR,
): string[] {
  requireDate(from);
  requireDate(to);
  const output: string[] = [];
  for (let date = from; date <= to; date = addCalendarDays(date, 1)) {
    const kind = calendar.getSession(date).kind;
    if (kind === "NORMAL" || kind === "HALF_DAY") output.push(date);
  }
  return output;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The ticker(s) the backfill matched for these stored sessions (sorted, inside the range).
 *
 * The backfill bound grouped-daily rows to securities by the master's currentSymbol at the time
 * it ran (providerRecords -> symbolBySecurityIdFor -> groupedDailySymbolIndex, ACTIVE ids only),
 * whatever the session date. The master records each symbol it held as current in
 * historicalSymbols with effectiveFrom on or after firstSeenAt (former tickers added from the
 * provider's inactive pass carry older provider dates, or effectiveFrom === effectiveTo when
 * undated, and were never matched). So:
 * - if every stored session falls inside exactly one held symbol's [effectiveFrom, effectiveTo),
 *   plan one sub-span per symbol, each from its first to its last stored session;
 * - otherwise (the usual case for history: the sessions predate every effective date) use
 *   currentSymbol over [first, last] stored session.
 */
function backfillSymbolSpans(
  security: SecurityMasterRecord,
  sessions: readonly string[],
): { spans: Array<{ symbol: string; from: string; to: string }>; fallback: boolean } {
  const firstSeen = security.firstSeenAt.slice(0, 10);
  const held = security.historicalSymbols.filter(
    (entry) =>
      !!entry.symbol &&
      entry.effectiveFrom >= firstSeen &&
      (entry.effectiveTo === undefined || entry.effectiveTo > entry.effectiveFrom),
  );
  const perSession: string[] = [];
  for (const date of sessions) {
    const matches = held.filter(
      (entry) => entry.effectiveFrom <= date && (entry.effectiveTo === undefined || date < entry.effectiveTo),
    );
    if (matches.length !== 1) break;
    perSession.push(matches[0]!.symbol);
  }
  if (sessions.length && perSession.length === sessions.length) {
    const spans: Array<{ symbol: string; from: string; to: string }> = [];
    sessions.forEach((date, index) => {
      const symbol = perSession[index]!;
      const last = spans.at(-1);
      if (last && last.symbol === symbol) last.to = date;
      else spans.push({ symbol, from: date, to: date });
    });
    return { spans, fallback: false };
  }
  const fallback = new Set(held.map((entry) => entry.symbol)).size > 1;
  if (!security.currentSymbol || !sessions.length) return { spans: [], fallback };
  return {
    spans: [{ symbol: security.currentSymbol, from: sessions[0]!, to: sessions.at(-1)! }],
    fallback,
  };
}

/**
 * Point-in-time universe for one range: a security is in the range if the stored daily bars have
 * at least one bar for it with sessionDate in [rangeFetchFrom, rangeFetchTo]. The master is used
 * only to look up the ticker(s) (see backfillSymbolSpans); each fetch spans that ticker's first to
 * last stored session in the range. Refuses (no fetch, no seal) on a trading session with zero
 * stored bars, an empty plan, or planned < TENMIN_MIN_UNIVERSE_RATIO × median per session.
 */
export function universeForTenMinRange(
  securities: readonly SecurityMasterRecord[],
  dailyBars: DailyBarSessionIndex,
  rangeFetchFrom: string,
  rangeFetchTo: string,
  options: { nowIso?: string; calendar?: SessionCalendar; linkDate?: string } = {},
): TenMinUniversePlan {
  requireDate(rangeFetchFrom);
  requireDate(rangeFetchTo);
  const nowIso = options.nowIso ?? new Date().toISOString();
  // The master's own date (latest lastUniverseSeenAt) names the provisional link.
  const masterDate = securities.reduce((latest, s) => {
    const day = (s.lastUniverseSeenAt ?? "").slice(0, 10);
    return day > latest ? day : latest;
  }, "");
  const linkSource = `provisional-master-${options.linkDate ?? (masterDate || nowIso.slice(0, 10))}`;
  const tradingSessions = tradingSessionsBetween(rangeFetchFrom, rangeFetchTo, options.calendar);
  const perSession = new Map<string, number>(tradingSessions.map((date) => [date, 0]));
  const inRange = new Map<string, string[]>();
  for (const [securityId, dates] of dailyBars) {
    const kept: string[] = [];
    for (const date of dates) {
      if (date < rangeFetchFrom || date > rangeFetchTo) continue;
      kept.push(date);
      const count = perSession.get(date);
      if (count !== undefined) perSession.set(date, count + 1);
    }
    if (kept.length) inRange.set(securityId, kept.sort(byCodeUnit));
  }
  const missingSessions = tradingSessions.filter((date) => (perSession.get(date) ?? 0) === 0);
  const medianSecuritiesPerSession = median([...perSession.values()]);

  const byId = new Map(securities.map((s) => [s.securityId, s]));
  const planned: TenMinUniverseSecurity[] = [];
  const gaps: TenMinRangeGapEntry[] = [];
  let currentSymbolFallbackCount = 0;
  for (const securityId of [...inRange.keys()].sort(byCodeUnit)) {
    const sessions = inRange.get(securityId)!;
    const security = byId.get(securityId);
    const resolved = security
      ? backfillSymbolSpans(security, sessions)
      : { spans: [], fallback: false };
    if (resolved.fallback) currentSymbolFallbackCount += 1;
    if (!resolved.spans.length) {
      gaps.push({ securityId, symbol: "", reason: "NO_HISTORICAL_SYMBOL", at: nowIso });
      continue;
    }
    planned.push({
      securityId,
      fetches: resolved.spans.map((span) => ({
        securityId,
        symbol: span.symbol,
        fetchFrom: span.from,
        fetchTo: span.to,
      })),
    });
  }
  const noDailyBar = securities
    .map((s) => s.securityId)
    .filter((securityId) => !inRange.has(securityId))
    .sort(byCodeUnit);

  const fetches = planned.flatMap((s) => s.fetches);
  const range = `${rangeFetchFrom}_${rangeFetchTo}`;
  let refusal: TenMinUniversePlan["refusal"];
  if (missingSessions.length)
    refusal = {
      code: TENMIN_DAILY_COVERAGE_HOLE,
      message: `${TENMIN_DAILY_COVERAGE_HOLE}:${range}:missing=${missingSessions.join(",")}`,
    };
  else if (!fetches.length)
    refusal = {
      code: TENMIN_UNIVERSE_EMPTY,
      message: `${TENMIN_UNIVERSE_EMPTY}:${range}:securities=0:gaps=${gaps.length}`,
    };
  else if (planned.length < TENMIN_MIN_UNIVERSE_RATIO * medianSecuritiesPerSession)
    refusal = {
      code: TENMIN_UNIVERSE_TOO_SMALL,
      message: `${TENMIN_UNIVERSE_TOO_SMALL}:${range}:planned=${planned.length}:median=${medianSecuritiesPerSession}:ratio=${TENMIN_MIN_UNIVERSE_RATIO}`,
    };
  return {
    securities: planned,
    fetches,
    gaps,
    tradingSessions,
    missingSessions,
    medianSecuritiesPerSession,
    noDailyBarCount: noDailyBar.length,
    noDailyBarSample: noDailyBar.slice(0, TENMIN_NO_DAILY_BAR_SAMPLE_SIZE),
    currentSymbolFallbackCount,
    securityLink: TENMIN_SECURITY_LINK,
    linkSource,
    ...(refusal ? { refusal } : {}),
  };
}

/** Load the stored-daily-bar index for just the months [from, to] touches. */
export async function loadDailyBarSessionsForRange(
  load: (month: string) => Promise<DailyBarSessionIndex>,
  from: string,
  to: string,
): Promise<DailyBarSessionIndex> {
  const merged: DailyBarSessionIndex = new Map();
  for (const month of monthsBetween(from, to)) {
    for (const [securityId, dates] of await load(month)) {
      const target = merged.get(securityId);
      if (!target) merged.set(securityId, dates);
      else for (const date of dates) target.add(date);
    }
  }
  return merged;
}

export interface TenMinHistoryRangeReport {
  calendarFrom: string;
  calendarTo: string;
  fetchFrom: string;
  fetchTo: string;
  status: "SEALED" | "ALREADY_SEALED" | "PARTIAL" | "REOPENED" | "OUTAGE_STOP" | "ERROR";
  /** Set when status is ERROR (e.g. TENMIN_UNIVERSE_EMPTY); the run stopped at this range. */
  error?: string;
  securitiesPlanned: number;
  fetchesPlanned: number;
  securitiesWritten: number;
  securitiesResumed: number;
  gaps: TenMinRangeGapEntry[];
  symbolChangeWarnings: string[];
  fallbackFiles: number;
  massiveRequests: number;
  zstdVersion: string;
  /** MISSING while the universe comes only from stored daily bars / today's master. */
  delistedCoverage: TenMinDelistedCoverage;
  /** Calendar days of this range that left the window before it sealed (AGED_OUT gap). */
  agedOut?: { from: string; to: string };
  /** Present when the range was planned this run (not skipped as already sealed). */
  securityLink?: typeof TENMIN_SECURITY_LINK;
  coverage?: { tradingSessions: number; missingSessions: string[]; medianSecuritiesPerSession: number };
  /** Known gap, not an error: master securities with no stored daily bar in the range. */
  noDailyBar?: { reason: typeof TENMIN_NO_DAILY_BAR; count: number; sampleSecurityIds: string[] };
  currentSymbolFallbackCount?: number;
}

export interface TenMinHistoryRunReport {
  schemaVersion: typeof TENMIN_HISTORY_RUN_SCHEMA;
  runId: string;
  provider: string;
  configuredWindowStart: string;
  windowStart: string;
  lastCompletedSession: string;
  skippedBefore: Array<{ calendarFrom: string; calendarTo: string }>;
  /** Window days before TENMIN_HISTORY_FIRST_RANGE_START, skipped on purpose (not an error). */
  skippedBeforeFirstRange?: TenMinSkippedBeforeFirstRange;
  reopen: boolean;
  /** securityId -> ticker links come from today's master. */
  securityLink: typeof TENMIN_SECURITY_LINK;
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
  /** Stored daily bars index for one YYYY-MM month. Defaults to storage.loadDailyBarSessions. */
  loadDailyBarSessions?: (month: string) => Promise<DailyBarSessionIndex>;
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
  const loadDailyBarSessions =
    options.loadDailyBarSessions ?? ((month: string) => storage.loadDailyBarSessions(month));
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
    const base = {
      calendarFrom: range.calendarFrom,
      calendarTo: range.calendarTo,
      fetchFrom: range.fetchFrom,
      fetchTo: range.fetchTo,
      ...(range.agedOut ? { agedOut: range.agedOut } : {}),
      // The universe comes only from stored daily bars and today's master (backfill linked
      // ACTIVE tickers only), so names delisted since are missing.
      delistedCoverage: TENMIN_DELISTED_COVERAGE_MISSING,
    };
    const agedOutGaps: TenMinRangeGapEntry[] = range.agedOut
      ? [
          {
            securityId: "",
            symbol: "",
            reason: TENMIN_AGED_OUT,
            at: stamp(),
            fetchFrom: range.agedOut.from,
            fetchTo: range.agedOut.to,
          },
        ]
      : [];
    let universe: TenMinUniversePlan | undefined;
    try {
      // A non-empty sealed range is skipped without reading ~200 MB of daily bars. (A manifest
      // sealed with 0 securities is not a seal; the writer replans it.)
      const sealed = reopen
        ? undefined
        : await readTenMinRangeManifest(store, range.calendarFrom, range.calendarTo, { allowEmpty: true });
      const skipPlanning = !!sealed && !isEmptyTenMinRangeManifest(sealed);
      if (!skipPlanning) {
        const dailyBars = await loadDailyBarSessionsForRange(loadDailyBarSessions, range.fetchFrom, range.fetchTo);
        universe = universeForTenMinRange(securities, dailyBars, range.fetchFrom, range.fetchTo, {
          nowIso: stamp(),
        });
        dailyBars.clear();
      }
      const planFields = universe
        ? {
            securityLink: universe.securityLink,
            coverage: {
              tradingSessions: universe.tradingSessions.length,
              missingSessions: universe.missingSessions,
              medianSecuritiesPerSession: universe.medianSecuritiesPerSession,
            },
            noDailyBar: {
              reason: TENMIN_NO_DAILY_BAR,
              count: universe.noDailyBarCount,
              sampleSecurityIds: universe.noDailyBarSample,
            },
            currentSymbolFallbackCount: universe.currentSymbolFallbackCount,
          }
        : {};
      const plannedCounts = universe
        ? {
            securitiesPlanned: universe.securities.length + universe.gaps.length,
            fetchesPlanned: universe.fetches.length,
          }
        : { securitiesPlanned: sealed?.securityCount ?? 0, fetchesPlanned: 0 };
      // Fail closed before any fetch: a coverage hole, an empty plan, or a too-small universe
      // means there is no complete universe for this range, so it is neither fetched nor sealed.
      if (universe?.refusal) {
        rangeReports.push({
          ...base,
          status: "ERROR",
          error: universe.refusal.message,
          ...plannedCounts,
          securitiesWritten: 0,
          securitiesResumed: 0,
          gaps: universe.gaps,
          symbolChangeWarnings: [],
          fallbackFiles: 0,
          massiveRequests: 0,
          zstdVersion,
          ...planFields,
        });
        stoppedOnError = true;
        error = universe.refusal.message;
        break;
      }
      const result = await writeTenMinRangeReplyDust({
        store,
        root,
        provider: providerName,
        from: range.calendarFrom,
        to: range.calendarTo,
        fetches: universe?.fetches ?? [],
        initialGaps: [...agedOutGaps, ...(universe?.gaps ?? [])],
        ...(reopen ? { reopen: true } : {}),
        ...(universe
          ? { securityLink: { status: universe.securityLink, source: universe.linkSource } }
          : {}),
        delistedCoverage: TENMIN_DELISTED_COVERAGE_MISSING,
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
      const status: TenMinHistoryRangeReport["status"] = result.outageStop
        ? "OUTAGE_STOP"
        : result.yieldedForScan
          ? "PARTIAL"
          : result.alreadySealed
            ? "ALREADY_SEALED"
            : reopen
              ? "REOPENED"
              : "SEALED";
      rangeReports.push({
        ...base,
        ...(result.manifest ? { delistedCoverage: tenMinRangeDelistedCoverage(result.manifest) } : {}),
        status,
        ...plannedCounts,
        securitiesWritten: result.securitiesWritten.length,
        securitiesResumed: result.securitiesResumed.length,
        gaps: result.gaps,
        symbolChangeWarnings: symbolWarnings,
        fallbackFiles: result.fallbackFiles,
        massiveRequests: result.massiveRequests,
        zstdVersion: result.zstdVersion,
        ...planFields,
      });
      if (result.outageStop) {
        outageStop = result.outageStop;
        break;
      }
      if (result.yieldedForScan) {
        yieldedForScan = result.yieldedForScan;
        break;
      }
    } catch (err) {
      stoppedOnError = true;
      error = err instanceof Error ? err.message : String(err);
      const made = tenMinMassiveRequestsOf(err);
      massiveRequests += made;
      rangeReports.push({
        ...base,
        status: "ERROR",
        error,
        securitiesPlanned: universe ? universe.securities.length + universe.gaps.length : 0,
        fetchesPlanned: universe?.fetches.length ?? 0,
        securitiesWritten: 0,
        securitiesResumed: 0,
        gaps: universe?.gaps ?? [],
        symbolChangeWarnings: [],
        fallbackFiles: 0,
        massiveRequests: made,
        zstdVersion,
      });
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
    ...(plan.skippedBeforeFirstRange ? { skippedBeforeFirstRange: plan.skippedBeforeFirstRange } : {}),
    reopen,
    securityLink: TENMIN_SECURITY_LINK,
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

/**
 * The one-line host summary: per-range status and plan sizes so an empty or failed plan is
 * visible in the Actions log, not only in the stored run report.
 */
export function tenMinHistorySummary(report: TenMinHistoryRunReport): Record<string, unknown> {
  return {
    mode: "tenmin-history",
    runId: report.runId,
    ranges: report.ranges.map((range) => ({
      range: `${range.calendarFrom}_${range.calendarTo}`,
      status: range.status,
      delistedCoverage: range.delistedCoverage,
      securitiesPlanned: range.securitiesPlanned,
      fetchesPlanned: range.fetchesPlanned,
      ...(range.agedOut ? { agedOut: range.agedOut } : {}),
      ...(range.error ? { error: range.error } : {}),
    })),
    ...(report.skippedBeforeFirstRange ? { skippedBeforeFirstRange: report.skippedBeforeFirstRange } : {}),
    massiveRequests: report.massiveRequests,
    yieldedForScan: report.yieldedForScan,
    outageStop: report.outageStop,
    stoppedOnError: report.stoppedOnError,
    ...(report.error ? { error: report.error } : {}),
    warnings: report.warnings,
  };
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
