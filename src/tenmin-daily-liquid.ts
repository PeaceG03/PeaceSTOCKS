// Daily liquid 10-minute step (N1). After each close, store the just-closed session's 10-minute
// bars for the top N names by trailing dollar volume, ranked ONLY from sessions before that session.
//
// Storage is the history chain's own format and folder: one Reply Dust object set per
// (security, ticker, D_D) under permanent/tenmin-reply-dust/<two-month range>/ with the same
// rd-* metadata plus rd-origin=daily-close. A small per-session index (frozen selection + stored
// list) lives in <range>/daily/<D>.json; the chain's listing ignores names containing "/".
//
// Reuse rule with the history chain: when the chain later works the two-month range it still
// fetches each ticker's full planned span (one request, same cost) and its sealed manifest lists
// only that fetch, so the daily objects are superseded (kept, never deleted or overwritten). A
// chain plan whose span is exactly (security, ticker, D, D) reuses the daily object (identical
// identity, verified like any resumed fetch). Readers: readTenMinSecurityDay prefers the sealed
// range manifest and falls back to the daily index only while the range is unsealed, so a session
// is always served from exactly one source.
//
// Key priority: daily scan > this step > history backfill. This step runs in scanner.yml's
// peacestocks-r2-writer group (a running history run sees it queued and yields between fetches),
// never inside a guard window, yields to a waiting scheduled scan, stops at a request budget, and
// is off unless TENMIN_DAILY_ENABLED is exactly "true".
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRedispatchGate } from "./tenmin-gate";
import type { CanonicalDailyBar, CanonicalTenMinuteBar, SecurityMasterRecord, TenMinuteRangeReply } from "./contracts";
import { FileReplyDustStore, type ReplyDustStore, sha256Hex } from "./intraday-reply-dust";
import { MassiveMarketProvider, massiveTenMinuteBarsFromReply } from "./massive-provider";
import { R2ObjectClient } from "./object-store";
import { openMarketStore } from "./object-storage";
import { type ReplyDustBackend, decodeReplyDust, nodeReplyDustBackend } from "./reply-dust";
import { type ZstdVersionProbe, assertPinnedZstdForWriting } from "./reply-dust-pin";
import { type ScanRunPick, checkScannerRuns, createScanYieldCheck, inScanGuardWindow, isScanCheckFailure } from "./scan-yield";
import type { SessionCalendar } from "./scanner";
import { TENMIN_DAILY_CLOSE_ORIGIN } from "./tenmin-range-entries";
import { errorMessage, reportPart } from "./health-checkins";
import { dayStuck } from "./day-stuck";
import { type HistoryHoldDay, historyBlockingDay } from "./history-blocked";
import { barCount, expectedTenMinBars, presentTenMinBars, shortStockCounts, tenMinSessionDone } from "./tenmin-day-done";
import { lastCompletedSessionDate, pairRangeForDate, tradingSessionsBetween } from "./tenmin-history";
import {
  TENMIN_RANGE_OUTAGE_STREAK,
  type TenMinRangeTickerFetch,
  isTenMinRangeAbortError,
  isTenMinRangeOutageError,
  readRangeSecurityDay,
  tenMinRangeFileKey,
  tenMinRangeGapReason,
  tenMinRangeManifestKey,
  tenMinRangePrefix,
  verifyStoredTenMinRangeFetch,
  writeTenMinRangeFetch,
} from "./tenmin-range-reply-dust";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

export { TENMIN_DAILY_CLOSE_ORIGIN };
export const TENMIN_DAILY_INDEX_SCHEMA = "tenmin-daily-liquid-index-v1" as const;
export const TENMIN_DAILY_RUN_SCHEMA = "tenmin-daily-liquid-run-v1" as const;
/** Repo variable TENMIN_DAILY_LIQUID_N: default and hard cap. */
export const TENMIN_DAILY_LIQUID_N_DEFAULT = 500;
export const TENMIN_DAILY_LIQUID_N_MAX = 1000;
/** Trailing sessions (strictly before D) whose dollar volume ranks the names for D. */
export const TENMIN_DAILY_LOOKBACK_SESSIONS = 20;
/** Catch-up window: the newest this-many completed sessions are checked every run, oldest first. */
export const TENMIN_DAILY_CATCHUP_SESSIONS = 10;
/** Requests per run (repo variable TENMIN_DAILY_MAX_REQUESTS): default and hard cap. */
export const TENMIN_DAILY_MAX_REQUESTS_DEFAULT = 720;
export const TENMIN_DAILY_MAX_REQUESTS_CAP = 2000;
/** Wall-clock budget per run (155 min): 06:20Z + 155 min ends before the 09:15Z guard window. */
export const TENMIN_DAILY_DEFAULT_BUDGET_MS = 9_300_000;
/** Shared Massive pace (MassiveMarketProvider default 12.5 s/request) for key-minute estimates. */
export const TENMIN_DAILY_SECONDS_PER_REQUEST = 12.5;
export const TENMIN_DAILY_RANK_METHOD =
  "sum(close*volume) over the trailing sessions strictly before D, latest revision per (securityId, session); ACTIVE master names with a currentSymbol; ties by securityId" as const;
/** Index saves during a session (plus one at the end), so an interruption loses little. */
const INDEX_SAVE_EVERY = 25;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function requireDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("INVALID_SESSION_DATE");
}

function addDays(date: string, days: number): string {
  const cursor = new Date(`${date}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
}

function isTradingSession(date: string, calendar: SessionCalendar): boolean {
  const kind = calendar.getSession(date).kind;
  return kind === "NORMAL" || kind === "HALF_DAY";
}

/** Strict integer parse for repo variables: empty -> default; anything else must be 1..max. */
function parseBoundedInt(name: string, value: string | undefined, fallback: number, max: number): number {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  if (!/^\d+$/u.test(trimmed)) throw new Error(`${name}_INVALID:${JSON.stringify(trimmed.slice(0, 20))}`);
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max)
    throw new Error(`${name}_INVALID:${JSON.stringify(trimmed.slice(0, 20))}:1..${max}`);
  return parsed;
}

/** TENMIN_DAILY_LIQUID_N: empty = 500; otherwise an integer 1..1000 (invalid fails before any request). */
/** PEACESTOCKS_REQUIRE_OBJECT_STORE: unset/""/"0" -> off, "1" -> on; anything else throws (a typo must not turn the requirement off). */
export function liquidRequiresObjectStore(value: string | undefined): boolean {
  const s = value?.trim() ?? "";
  if (s === "" || s === "0") return false;
  if (s === "1") return true;
  throw new Error(`PEACESTOCKS_REQUIRE_OBJECT_STORE_INVALID:${JSON.stringify(s.slice(0, 20))}`);
}

export function parseTenMinDailyLiquidN(value: string | undefined): number {
  return parseBoundedInt("TENMIN_DAILY_LIQUID_N", value, TENMIN_DAILY_LIQUID_N_DEFAULT, TENMIN_DAILY_LIQUID_N_MAX);
}

/** TENMIN_DAILY_MAX_REQUESTS: empty = 720; otherwise an integer 1..2000. */
export function parseTenMinDailyMaxRequests(value: string | undefined): number {
  return parseBoundedInt(
    "TENMIN_DAILY_MAX_REQUESTS",
    value,
    TENMIN_DAILY_MAX_REQUESTS_DEFAULT,
    TENMIN_DAILY_MAX_REQUESTS_CAP,
  );
}

/** Kill switch: nothing runs unless the repo variable is exactly "true". */
export function tenMinDailyEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.TENMIN_DAILY_ENABLED === "true";
}

/** Pure: the `count` trading sessions strictly before D, oldest first. */
export function tradingSessionsBefore(
  sessionDate: string,
  count: number,
  calendar: SessionCalendar = US_EQUITY_MARKET_CALENDAR,
): string[] {
  requireDate(sessionDate);
  const output: string[] = [];
  let cursor = sessionDate;
  for (let i = 0; i < 400 && output.length < count; i += 1) {
    cursor = addDays(cursor, -1);
    if (isTradingSession(cursor, calendar)) output.push(cursor);
  }
  return output.reverse();
}

/** Pure: the newest `count` completed trading sessions up to lastCompleted (inclusive), oldest first. */
export function tenMinDailyCatchupSessions(
  lastCompleted: string,
  count: number = TENMIN_DAILY_CATCHUP_SESSIONS,
  calendar: SessionCalendar = US_EQUITY_MARKET_CALENDAR,
): string[] {
  requireDate(lastCompleted);
  const before = tradingSessionsBefore(addDays(lastCompleted, 1), count, calendar);
  return before;
}

export type LiquidityBar = Pick<CanonicalDailyBar, "securityId" | "sessionDate" | "close" | "volume" | "revision">;

export interface TenMinDailySelected {
  rank: number;
  securityId: string;
  symbol: string;
  dollarVolume: number;
  sessions: number;
}

/**
 * Pure: top N names for session D by trailing dollar volume. Only bars whose sessionDate is in
 * trailingSessions (all strictly before D) count; any other bar, including D itself and later, is
 * ignored, so nothing from D or after can change the selection.
 */
export function selectTenMinDailyLiquidNames(input: {
  sessionDate: string;
  trailingSessions: readonly string[];
  bars: Iterable<LiquidityBar>;
  securities: readonly SecurityMasterRecord[];
  n: number;
}): TenMinDailySelected[] {
  requireDate(input.sessionDate);
  for (const session of input.trailingSessions)
    if (!(session < input.sessionDate)) throw new Error(`TENMIN_DAILY_LOOKAHEAD:${session}>=${input.sessionDate}`);
  const window = new Set(input.trailingSessions);
  const latest = new Map<string, LiquidityBar>();
  for (const bar of input.bars) {
    if (!window.has(bar.sessionDate)) continue;
    const key = `${bar.securityId}\0${bar.sessionDate}`;
    const prior = latest.get(key);
    if (!prior || bar.revision > prior.revision) latest.set(key, bar);
  }
  const eligible = new Map<string, string>();
  for (const security of input.securities)
    if (security.status === "ACTIVE" && security.currentSymbol?.trim())
      eligible.set(security.securityId, security.currentSymbol.trim());
  const totals = new Map<string, { dollarVolume: number; sessions: number }>();
  for (const bar of latest.values()) {
    if (!eligible.has(bar.securityId)) continue;
    const value = bar.close * bar.volume;
    if (!Number.isFinite(value) || value <= 0) continue;
    const total = totals.get(bar.securityId) ?? { dollarVolume: 0, sessions: 0 };
    total.dollarVolume += value;
    total.sessions += 1;
    totals.set(bar.securityId, total);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1].dollarVolume - a[1].dollarVolume || byCodeUnit(a[0], b[0]))
    .slice(0, Math.max(0, input.n))
    .map(([securityId, total], index) => ({
      rank: index + 1,
      securityId,
      symbol: eligible.get(securityId)!,
      dollarVolume: total.dollarVolume,
      sessions: total.sessions,
    }));
}

/**
 * Read only the liquidity fields of permanent/daily-bars/<month>.jsonl rows for the given sessions.
 * Months are read once per run (cache) and rows outside `sessions` are dropped while parsing.
 */
export function dailyBarsLoader(store: Pick<ReplyDustStore, "get">): (sessions: readonly string[]) => Promise<LiquidityBar[]> {
  const cache = new Map<string, LiquidityBar[]>();
  return async (sessions) => {
    const wanted = new Set(sessions);
    const months = [...new Set(sessions.map((s) => s.slice(0, 7)))].sort(byCodeUnit);
    const output: LiquidityBar[] = [];
    for (const month of months) {
      let rows = cache.get(month);
      if (!rows) {
        rows = [];
        const body = await store.get(`permanent/daily-bars/${month}.jsonl`);
        if (body) {
          const text = new TextDecoder().decode(body);
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            let raw: Partial<CanonicalDailyBar>;
            try {
              raw = JSON.parse(line) as Partial<CanonicalDailyBar>;
            } catch {
              continue;
            }
            if (
              typeof raw.securityId === "string" &&
              typeof raw.sessionDate === "string" &&
              typeof raw.close === "number" &&
              typeof raw.volume === "number"
            )
              rows.push({
                securityId: raw.securityId,
                sessionDate: raw.sessionDate,
                close: raw.close,
                volume: raw.volume,
                revision: typeof raw.revision === "number" ? raw.revision : 0,
              });
          }
        }
        cache.set(month, rows);
      }
      for (const row of rows) if (wanted.has(row.sessionDate)) output.push(row);
    }
    return output;
  };
}

export interface TenMinDailyStoredEntry {
  securityId: string;
  fetch: TenMinRangeTickerFetch;
  /** true when the object already existed and was verified instead of fetched. */
  adopted?: boolean;
  /** Ten-minute bars the stored reply holds for the session (absent on indexes written before the done-day rule). */
  bars?: number;
}

export interface TenMinDailyGapEntry {
  securityId: string;
  symbol: string;
  reason: string;
  at: string;
}

export interface TenMinDailyIndex {
  schemaVersion: typeof TENMIN_DAILY_INDEX_SCHEMA;
  sessionDate: string;
  rangeFrom: string;
  rangeTo: string;
  provider: string;
  rule: { n: number; lookbackSessions: number; method: string; trailingSessions: string[] };
  selectedAt: string;
  selected: TenMinDailySelected[];
  stored: TenMinDailyStoredEntry[];
  gaps: TenMinDailyGapEntry[];
  /** Set once the day is done (done-day rule: every stock has all its bars AND its daily bars are saved). */
  done?: { at: string; expectedBars: number };
  /** Full catch-up passes that ended with the day still not done (the health check flags a stuck day). */
  notDoneRuns?: number;
  /** Stocks still short of the expected bars / without a saved daily bar after the last pass. */
  shortNames?: number;
  missingDailyBars?: number;
  /** Day status count: ten-minute bars stored vs. needed over every selected stock, e.g. "19461/19500". */
  dayBars?: string;
  /** Each short stock's bars stored vs. needed, e.g. { securityId, bars: "38/39" }. */
  shortStocks?: { securityId: string; bars: string }[];
  /** Daily bars saved vs. needed for the selected stocks, e.g. "497/500". */
  dailyBars?: string;
  /**
   * STUCK_SHORT (Peace, Nov 23): set when 6 full catch-up passes left the day not done, with the counts
   * at that pass. The day stays not done and keeps being retried (after the other days); it no
   * longer holds the history chain, and it is never treated as a full day.
   */
  stuckShort?: TenMinDailyStuckShort;
  /**
   * Set on every index this code writes (the done-day rule, Nov 23). An index without it was written
   * before the rule (main through Nov 23): it has no done field and no per-stock bars, so its counts
   * are unknown, not short. Such a pre-rule index is never stamped STUCK_SHORT and, once out of the
   * window, never holds a seal (the range's own seal checks apply, as before the rule).
   */
  doneRule?: typeof TENMIN_DAILY_DONE_RULE;
  updatedAt: string;
  checksum: string;
}

export const TENMIN_DAILY_DONE_RULE = "done-day-v1" as const;
/** Run-log marker: a tracked, not-done day under a sealed range was skipped (no fetch, no write). */
export const TENMIN_DAILY_SKIPPED_RANGE_SEALED = "TENMIN_DAILY_SKIPPED_RANGE_SEALED" as const;
/** The daily step's first session (Sep 29, 2026) is in this two-month range; no daily index is older. */
export const TENMIN_DAILY_FIRST_RANGE_FROM = "2026-09-01" as const;

/**
 * NO_SELECTION marker (Auditor, early review c): a day the daily step tried but could select no stock
 * for (no ranked names) writes no index, so the seal guard would wait on it as "not tried" for its
 * whole window life. The step writes this small marker instead; the guard accepts the day (the daily
 * step has nothing of its own in it). A later run that does select names writes the index, which wins.
 */
export function tenMinDailyNoSelectionKey(sessionDate: string): string {
  return tenMinDailyIndexKey(sessionDate).replace(/\.json$/u, ".no-selection.json");
}

/** Pure: true for an index written before the done-day rule (no doneRule marker). */
export function isPreRuleIndex(index: Pick<TenMinDailyIndex, "doneRule">): boolean {
  return index.doneRule !== TENMIN_DAILY_DONE_RULE;
}

/**
 * Every daily index key from the first daily range up to and including the range that holds
 * `toSession`, sorted by session date (lists each range's daily/ folder; nothing else).
 */
export async function listTenMinDailyIndexDays(store: Pick<ReplyDustStore, "list">, toSession: string): Promise<string[]> {
  requireDate(toSession);
  const days: string[] = [];
  let month = TENMIN_DAILY_FIRST_RANGE_FROM.slice(0, 7);
  const seen = new Set<string>();
  while (month <= toSession.slice(0, 7)) {
    const { calendarFrom, calendarTo } = pairRangeForDate(`${month}-15`);
    const prefix = `${tenMinRangePrefix(calendarFrom, calendarTo)}/daily/`;
    if (!seen.has(prefix)) {
      seen.add(prefix);
      for (const key of await store.list(prefix)) {
        const day = /^(\d{4}-\d{2}-\d{2})\.json$/u.exec(key.slice(prefix.length))?.[1];
        if (day && day <= toSession) days.push(day);
      }
    }
    const [y, m] = month.split("-").map(Number) as [number, number];
    month = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  }
  return [...new Set(days)].sort();
}

export const TENMIN_DAILY_STUCK_SHORT = "STUCK_SHORT" as const;

export interface TenMinDailyStuckShort {
  status: typeof TENMIN_DAILY_STUCK_SHORT;
  /** FAILED_PASSES: 6 full passes failed. LEFT_WINDOW: the day left the 10-session window not done (no longer retried). */
  reason?: "FAILED_PASSES" | "LEFT_WINDOW";
  at: string;
  /** Full catch-up passes that had failed when the day became STUCK_SHORT. */
  passes: number;
  /** Counts recorded at that pass, e.g. "19461/19500" and "500/500". */
  dayBars: string;
  dailyBars: string;
  shortNames: number;
  missingDailyBars: number;
}

export function tenMinDailyIndexKey(sessionDate: string): string {
  requireDate(sessionDate);
  const { calendarFrom, calendarTo } = pairRangeForDate(sessionDate);
  return `${tenMinRangePrefix(calendarFrom, calendarTo)}/daily/${sessionDate}.json`;
}

function indexChecksum(body: Omit<TenMinDailyIndex, "checksum">): string {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(body)));
}

function finalizeIndex(input: Omit<TenMinDailyIndex, "checksum"> & { checksum?: string }): TenMinDailyIndex {
  const { checksum: _previous, ...body } = input;
  const stored = [...body.stored].sort((a, b) => byCodeUnit(a.securityId, b.securityId));
  const gaps = [...body.gaps].sort((a, b) => byCodeUnit(a.securityId, b.securityId) || byCodeUnit(a.reason, b.reason));
  const ordered: Omit<TenMinDailyIndex, "checksum"> = { ...body, stored, gaps };
  return { ...ordered, checksum: indexChecksum(ordered) };
}

export async function readTenMinDailyIndex(
  store: Pick<ReplyDustStore, "get">,
  sessionDate: string,
): Promise<TenMinDailyIndex | undefined> {
  const bytes = await store.get(tenMinDailyIndexKey(sessionDate));
  if (!bytes) return undefined;
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as TenMinDailyIndex;
  if (parsed.schemaVersion !== TENMIN_DAILY_INDEX_SCHEMA || parsed.sessionDate !== sessionDate)
    throw new Error(`TENMIN_DAILY_INDEX_INVALID:${sessionDate}`);
  const { checksum, ...body } = parsed;
  if (indexChecksum(body) !== checksum) throw new Error(`TENMIN_DAILY_INDEX_CHECKSUM_MISMATCH:${sessionDate}`);
  return parsed;
}

async function writeTenMinDailyIndex(store: ReplyDustStore, index: TenMinDailyIndex): Promise<void> {
  const key = tenMinDailyIndexKey(index.sessionDate);
  const bytes = new TextEncoder().encode(`${JSON.stringify(index, null, 2)}\n`);
  await store.put(key, bytes, { "rd-daily-index-checksum": index.checksum });
  const head = await store.head(key);
  if (!head || head.size !== bytes.length || head.metadata["rd-daily-index-checksum"] !== index.checksum)
    throw new Error(`TENMIN_DAILY_INDEX_READBACK_MISMATCH:${index.sessionDate}`);
}

/** True when the chain has sealed the two-month range that holds D (it then owns D's bars). */
export async function tenMinRangeSealedFor(store: Pick<ReplyDustStore, "head">, sessionDate: string): Promise<boolean> {
  const { calendarFrom, calendarTo } = pairRangeForDate(sessionDate);
  return (await store.head(tenMinRangeManifestKey(calendarFrom, calendarTo))) !== undefined;
}

/**
 * Verify an object set already stored at (security, symbol, D, D) without fetching. Returns the
 * verified fetch, undefined when nothing is stored, or "INVALID" when something is stored but does
 * not verify (it is then reported, never overwritten).
 */
async function verifyExistingDaily(
  store: ReplyDustStore,
  provider: string,
  securityId: string,
  symbol: string,
  sessionDate: string,
  backend: ReplyDustBackend,
  hint?: TenMinRangeTickerFetch,
): Promise<TenMinRangeTickerFetch | undefined | "INVALID"> {
  const { calendarFrom, calendarTo } = pairRangeForDate(sessionDate);
  const head = await store.head(tenMinRangeFileKey(calendarFrom, calendarTo, securityId, symbol, sessionDate, sessionDate, 1));
  if (!head) return undefined;
  const count = Number(head.metadata["rd-page-count"]);
  const pages = new Set<number>();
  if (Number.isSafeInteger(count) && count >= 1) for (let p = 1; p <= count; p += 1) pages.add(p);
  else pages.add(1);
  const verified = await verifyStoredTenMinRangeFetch(
    store,
    calendarFrom,
    calendarTo,
    { securityId, symbol, fetchFrom: sessionDate, fetchTo: sessionDate },
    { provider, storedPages: pages, backend, ...(hint ? { hint } : {}) },
  );
  return verified ?? "INVALID";
}

/**
 * Pure: a day's counts from its index, bars stored vs. needed. Indexes written before the counts
 * existed get them from their stored entries (a stock with no stored entry has 0 bars).
 */
export function tenMinDailyIndexCounts(
  index: Pick<TenMinDailyIndex, "selected" | "stored" | "done" | "missingDailyBars" | "dayBars" | "shortStocks" | "dailyBars">,
  expectedBars: number,
): { dayBars: string; shortStocks: { securityId: string; bars: string }[]; dailyBars: string } {
  const n = index.selected.length;
  if (index.done)
    return { dayBars: index.dayBars ?? barCount(n * expectedBars, n * expectedBars), shortStocks: [], dailyBars: index.dailyBars ?? barCount(n, n) };
  const saved = new Map(index.stored.map((entry) => [entry.securityId, Math.min(entry.bars ?? 0, expectedBars)]));
  const shortStocks =
    index.shortStocks ??
    index.selected
      .filter((name) => (saved.get(name.securityId) ?? 0) < expectedBars)
      .map((name) => ({ securityId: name.securityId, bars: barCount(saved.get(name.securityId) ?? 0, expectedBars) }));
  const stored = index.selected.reduce((sum, name) => sum + (saved.get(name.securityId) ?? 0), 0);
  return {
    dayBars: index.dayBars ?? barCount(stored, n * expectedBars),
    shortStocks,
    dailyBars: index.dailyBars ?? barCount(n - (index.missingDailyBars ?? 0), n),
  };
}

/**
 * COMPLETE only when the day is done by the done-day rule. WAITING_DAILY_BARS: every stock has all its
 * ten-minute bars but some daily bars are not saved yet (catch-up keeps re-running the day).
 */
export type TenMinDailySessionStatus =
  | "COMPLETE"
  | "PARTIAL"
  | "WAITING_DAILY_BARS"
  | typeof TENMIN_DAILY_STUCK_SHORT
  | "SKIPPED_RANGE_SEALED"
  | "NO_SELECTION";

export interface TenMinDailySessionReport {
  sessionDate: string;
  range: string;
  status: TenMinDailySessionStatus;
  selected: number;
  stored: number;
  fetchedThisRun: number;
  adoptedThisRun: number;
  gaps: number;
  requests: number;
  /** Bars each stock needs for this session (39, or 21 on a half day). */
  expectedBars?: number;
  /** Stocks still short of expectedBars / without a saved daily bar at the end of this run. */
  shortNames?: number;
  missingDailyBars?: number;
  /** Stored names whose short reply was fetched again this run. */
  refetchedThisRun?: number;
  /** Ten-minute bars stored vs. needed over every selected stock, e.g. "19461/19500". */
  bars?: string;
  /** Daily bars saved vs. needed, e.g. "500/500". */
  dailyBars?: string;
  /** Short stocks by count, e.g. { "38/39": 2, "0/39": 1 } (no stock names in the run log). */
  shortStockBars?: Record<string, number>;
}

export interface TenMinDailyRunReport {
  schemaVersion: typeof TENMIN_DAILY_RUN_SCHEMA;
  runId: string;
  provider: string;
  n: number;
  maxRequests: number;
  lastCompletedSession: string;
  sessions: TenMinDailySessionReport[];
  massiveRequests: number;
  /** massiveRequests x 12.5 s / 60 (the shared pace). */
  estimatedKeyMinutes: number;
  yielded?: string;
  budgetStop?: boolean;
  outageStop?: string;
  warnings: string[];
}

export async function runTenMinDailyLiquid(options: {
  store: ReplyDustStore;
  securities: readonly SecurityMasterRecord[];
  provider?: string;
  n: number;
  maxRequests: number;
  now?: Date;
  lastCompletedSession?: string;
  catchupSessions?: number;
  calendar?: SessionCalendar;
  loadBars?: (sessions: readonly string[]) => Promise<LiquidityBar[]>;
  shouldYield?: () => Promise<string | undefined>;
  nowIso?: () => string;
  backend?: ReplyDustBackend;
  zstdVersionProbe?: ZstdVersionProbe;
  fetchPages: (
    security: { securityId: string; symbol: string },
    from: string,
    to: string,
  ) => Promise<TenMinuteRangeReply[]>;
}): Promise<TenMinDailyRunReport> {
  if (!Number.isSafeInteger(options.n) || options.n < 1 || options.n > TENMIN_DAILY_LIQUID_N_MAX)
    throw new Error(`TENMIN_DAILY_LIQUID_N_INVALID:${options.n}`);
  assertPinnedZstdForWriting(options.zstdVersionProbe);
  const store = options.store;
  const provider = options.provider ?? "massive-stocks";
  const calendar = options.calendar ?? US_EQUITY_MARKET_CALENDAR;
  const stamp = options.nowIso ?? (() => new Date().toISOString());
  const backend = options.backend ?? nodeReplyDustBackend;
  const loadBars = options.loadBars ?? dailyBarsLoader(store);
  const lastCompleted = options.lastCompletedSession ?? lastCompletedSessionDate(options.now ?? new Date(), calendar);
  const sessions = tenMinDailyCatchupSessions(lastCompleted, options.catchupSessions ?? TENMIN_DAILY_CATCHUP_SESSIONS, calendar);
  const report: TenMinDailyRunReport = {
    schemaVersion: TENMIN_DAILY_RUN_SCHEMA,
    runId: `tenmin-daily-${stamp().replaceAll(/[^0-9]/gu, "").slice(0, 17)}`,
    provider,
    n: options.n,
    maxRequests: options.maxRequests,
    lastCompletedSession: lastCompleted,
    sessions: [],
    massiveRequests: 0,
    estimatedKeyMinutes: 0,
    warnings: [],
  };
  let outageStreak = 0;
  let stop = false;
  // A day that left the window not done is no longer retried: record it STUCK_SHORT with its counts
  // (it can then never hold a seal or the chain forever, and is never treated as full). Every tracked
  // day older than the window is covered (Auditor B1), not only the sessions just before it. A
  // pre-rule index (written before the done-day rule: no done field, no per-stock bars) is never
  // stamped: its counts are unknown, not short.
  const windowStart = sessions[0] ?? lastCompleted;
  for (const sessionDate of (await listTenMinDailyIndexDays(store, windowStart)).filter((d) => d < windowStart)) {
    const old = await readTenMinDailyIndex(store, sessionDate);
    if (!old || old.done || old.stuckShort || isPreRuleIndex(old)) continue;
    const counts = tenMinDailyIndexCounts(old, expectedTenMinBars(sessionDate, calendar));
    await writeTenMinDailyIndex(
      store,
      finalizeIndex({
        ...old,
        stuckShort: {
          status: TENMIN_DAILY_STUCK_SHORT,
          reason: "LEFT_WINDOW",
          at: stamp(),
          passes: old.notDoneRuns ?? 0,
          dayBars: counts.dayBars,
          dailyBars: counts.dailyBars,
          shortNames: old.shortNames ?? counts.shortStocks.length,
          missingDailyBars: old.missingDailyBars ?? 0,
        },
        updatedAt: stamp(),
      }),
    );
    report.warnings.push(`TENMIN_DAILY_STUCK_SHORT_LEFT_WINDOW:${sessionDate}:${counts.dayBars}`);
  }
  // STUCK_SHORT days are still retried, but after every other day, so they never starve a newer one.
  const stuckFirst = await Promise.all(sessions.map(async (d) => !!(await readTenMinDailyIndex(store, d))?.stuckShort));
  const ordered = [...sessions.filter((_, i) => !stuckFirst[i]), ...sessions.filter((_, i) => stuckFirst[i])];

  for (const sessionDate of ordered) {
    if (stop) break;
    const { calendarFrom, calendarTo } = pairRangeForDate(sessionDate);
    const range = `${calendarFrom}_${calendarTo}`;
    const sessionReport: TenMinDailySessionReport = {
      sessionDate,
      range,
      status: "PARTIAL",
      selected: 0,
      stored: 0,
      fetchedThisRun: 0,
      adoptedThisRun: 0,
      gaps: 0,
      requests: 0,
    };
    let index = await readTenMinDailyIndex(store, sessionDate);
    // A sealed range owns its sessions: nothing is fetched or written under it (Auditor B3; a re-fetch
    // would overwrite an object the seal reused). A tracked day keeps its index, status and counts
    // unchanged; it is still not done by its own bars (seal guard), and is reported as skipped.
    if (await tenMinRangeSealedFor(store, sessionDate)) {
      sessionReport.status = "SKIPPED_RANGE_SEALED";
      if (index) {
        sessionReport.selected = index.selected.length;
        sessionReport.stored = index.stored.length;
        if (!isPreRuleIndex(index) || index.done) {
          const counts = tenMinDailyIndexCounts(index, expectedTenMinBars(sessionDate, calendar));
          sessionReport.bars = counts.dayBars;
          sessionReport.dailyBars = counts.dailyBars;
        }
        if (!index.done)
          report.warnings.push(
            `${TENMIN_DAILY_SKIPPED_RANGE_SEALED}:${sessionDate}:${index.stuckShort ? TENMIN_DAILY_STUCK_SHORT : "not-done"}:${sessionReport.bars ?? "pre-rule"}`,
          );
      }
      report.sessions.push(sessionReport);
      continue;
    }
    const expectedBars = expectedTenMinBars(sessionDate, calendar);
    sessionReport.expectedBars = expectedBars;
    if (index?.done) {
      sessionReport.status = "COMPLETE";
      sessionReport.selected = index.selected.length;
      sessionReport.stored = index.stored.length;
      sessionReport.shortNames = 0;
      sessionReport.missingDailyBars = 0;
      // A done day has every bar (indexes written before the counts carry no dayBars).
      sessionReport.bars = index.dayBars ?? barCount(index.selected.length * expectedBars, index.selected.length * expectedBars);
      sessionReport.dailyBars = index.dailyBars ?? barCount(index.selected.length, index.selected.length);
      sessionReport.shortStockBars = {};
      report.sessions.push(sessionReport);
      continue;
    }
    let dirty = false;
    if (!index) {
      const trailingSessions = tradingSessionsBefore(sessionDate, TENMIN_DAILY_LOOKBACK_SESSIONS, calendar);
      const selected = selectTenMinDailyLiquidNames({
        sessionDate,
        trailingSessions,
        bars: await loadBars(trailingSessions),
        securities: options.securities,
        n: options.n,
      });
      if (!selected.length) {
        sessionReport.status = "NO_SELECTION";
        report.warnings.push(`TENMIN_DAILY_NO_SELECTION:${sessionDate}`);
        await store.put(
          tenMinDailyNoSelectionKey(sessionDate),
          new TextEncoder().encode(`${JSON.stringify({ schemaVersion: "tenmin-daily-no-selection-v1", sessionDate, at: stamp() })}\n`),
        );
        report.sessions.push(sessionReport);
        continue;
      }
      index = finalizeIndex({
        schemaVersion: TENMIN_DAILY_INDEX_SCHEMA,
        sessionDate,
        rangeFrom: calendarFrom,
        rangeTo: calendarTo,
        provider,
        rule: { n: options.n, lookbackSessions: TENMIN_DAILY_LOOKBACK_SESSIONS, method: TENMIN_DAILY_RANK_METHOD, trailingSessions },
        selectedAt: stamp(),
        selected,
        stored: [],
        gaps: [],
        doneRule: TENMIN_DAILY_DONE_RULE,
        updatedAt: stamp(),
      });
      // Freeze the selection before the first request so a resumed run fetches the same names.
      await writeTenMinDailyIndex(store, index);
    } else if (index.rule.n !== options.n) {
      report.warnings.push(`TENMIN_DAILY_N_CHANGED:${sessionDate}:${index.rule.n}->${options.n}:selection-kept`);
    }
    const stored = new Map(index.stored.map((entry) => [entry.securityId, entry]));
    // Gaps from earlier runs are retried; they come back if they fail again.
    const gaps = new Map<string, TenMinDailyGapEntry>();
    let sinceSave = 0;
    const save = async (): Promise<void> => {
      if (!dirty) return;
      index = finalizeIndex({ ...index!, stored: [...stored.values()], gaps: [...gaps.values()], updatedAt: stamp() });
      await writeTenMinDailyIndex(store, index);
      dirty = false;
      sinceSave = 0;
    };
    if (index.gaps.length) dirty = true;
    let sessionStopped = false;
    let refetched = 0;
    // Bars held by a stored object (counted once, then kept in the index). Undefined = unreadable.
    const storedBars = async (securityId: string, fetch: TenMinRangeTickerFetch): Promise<number | undefined> => {
      try {
        return presentTenMinBars(await decodeDailyObjectBars(store, provider, securityId, sessionDate, fetch, backend));
      } catch {
        return undefined;
      }
    };

    try {
      for (const name of index.selected) {
        let prior = stored.get(name.securityId);
        if (prior && prior.bars === undefined) {
          const counted = await storedBars(name.securityId, prior.fetch);
          if (counted === undefined) {
            gaps.set(name.securityId, { securityId: name.securityId, symbol: name.symbol, reason: "TENMIN_DAILY_OBJECT_UNVERIFIED", at: stamp() });
            dirty = true;
            continue;
          }
          prior = { ...prior, bars: counted };
          stored.set(name.securityId, prior);
          dirty = true;
        }
        // Done-day rule: a stored name is finished only with all its bars; a short one is re-run.
        if (prior && (prior.bars ?? 0) >= expectedBars) continue;
        const yieldReason = options.shouldYield ? await options.shouldYield() : undefined;
        if (yieldReason) {
          report.yielded = yieldReason;
          stop = true;
          sessionStopped = true;
          break;
        }
        if (!prior) {
          const existing = await verifyExistingDaily(store, provider, name.securityId, name.symbol, sessionDate, backend);
          if (existing === "INVALID") {
            gaps.set(name.securityId, { securityId: name.securityId, symbol: name.symbol, reason: "TENMIN_DAILY_OBJECT_UNVERIFIED", at: stamp() });
            dirty = true;
            continue;
          }
          if (existing) {
            const counted = await storedBars(name.securityId, existing);
            prior = { securityId: name.securityId, fetch: existing, adopted: true, bars: counted ?? 0 };
            stored.set(name.securityId, prior);
            sessionReport.adoptedThisRun += 1;
            dirty = true;
            if (++sinceSave >= INDEX_SAVE_EVERY) await save();
            if ((prior.bars ?? 0) >= expectedBars) continue;
          }
        }
        if (report.massiveRequests >= options.maxRequests) {
          report.budgetStop = true;
          stop = true;
          sessionStopped = true;
          break;
        }
        report.massiveRequests += 1;
        sessionReport.requests += 1;
        try {
          const pages = await options.fetchPages({ securityId: name.securityId, symbol: name.symbol }, sessionDate, sessionDate);
          report.massiveRequests += Math.max(0, pages.length - 1);
          sessionReport.requests += Math.max(0, pages.length - 1);
          const bars = presentTenMinBars(barsFromPages(provider, sessionDate, name.securityId, pages));
          // A re-run only replaces a short stored reply with one that holds more bars.
          if (prior && bars <= (prior.bars ?? 0)) {
            outageStreak = 0;
            continue;
          }
          const { fetch } = await writeTenMinRangeFetch(store, pages, {
            provider,
            calendarFrom,
            calendarTo,
            fetchFrom: sessionDate,
            fetchTo: sessionDate,
            backend,
            origin: TENMIN_DAILY_CLOSE_ORIGIN,
          });
          stored.set(name.securityId, { securityId: name.securityId, fetch, bars });
          gaps.delete(name.securityId);
          if (prior) refetched += 1;
          else sessionReport.fetchedThisRun += 1;
          outageStreak = 0;
          dirty = true;
          if (++sinceSave >= INDEX_SAVE_EVERY) await save();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            isTenMinRangeAbortError(message) ||
            message.startsWith("R2_") ||
            message.startsWith("STORE_") ||
            message.startsWith("REPLY_DUST_") ||
            message.startsWith("OBJECT_STORE")
          )
            throw error;
          if (isTenMinRangeOutageError(message)) {
            outageStreak += 1;
            if (outageStreak >= TENMIN_RANGE_OUTAGE_STREAK) {
              report.outageStop = `MASSIVE_OUTAGE:${message}`;
              stop = true;
              sessionStopped = true;
              break;
            }
            continue;
          }
          outageStreak = 0;
          gaps.set(name.securityId, { securityId: name.securityId, symbol: name.symbol, reason: tenMinRangeGapReason(message), at: stamp() });
          dirty = true;
        }
      }
    } finally {
      // Keep what was stored even when the run aborts.
      await save();
    }
    // Done-day rule: all ten-minute bars for every stock AND its daily bars saved.
    const dailySaved = new Set(
      (await loadBars([sessionDate])).filter((bar) => bar.sessionDate === sessionDate).map((bar) => bar.securityId),
    );
    const verdict = tenMinSessionDone({
      sessionDate,
      selected: index.selected.map((name) => name.securityId),
      savedBars: new Map([...stored.values()].map((entry) => [entry.securityId, entry.bars ?? 0])),
      dailyBarsSaved: dailySaved,
      calendar,
    });
    const notDoneRuns = (index.notDoneRuns ?? 0) + (!verdict.done && !sessionStopped ? 1 : 0);
    const {
      done: _done,
      notDoneRuns: _runs,
      shortNames: _short,
      missingDailyBars: _missing,
      dayBars: _dayBars,
      shortStocks: _shortStocks,
      dailyBars: _dailyBars,
      stuckShort: priorStuck,
      ...indexBody
    } = index;
    const dayBars = barCount(verdict.barsStored, verdict.barsNeeded);
    const dailyBars = barCount(index.selected.length - verdict.missingDailyBars.length, index.selected.length);
    // STUCK_SHORT once 6 full passes failed; the counts are recorded at the pass that marked it.
    const stuckShort: TenMinDailyStuckShort | undefined = verdict.done
      ? undefined
      : (priorStuck ??
        (dayStuck(notDoneRuns)
          ? {
              status: TENMIN_DAILY_STUCK_SHORT,
              reason: "FAILED_PASSES" as const,
              at: stamp(),
              passes: notDoneRuns,
              dayBars,
              dailyBars,
              shortNames: verdict.shortNames.length,
              missingDailyBars: verdict.missingDailyBars.length,
            }
          : undefined));
    index = finalizeIndex({
      ...indexBody,
      stored: [...stored.values()],
      gaps: [...gaps.values()],
      ...(verdict.done ? { done: { at: stamp(), expectedBars: verdict.expectedBars } } : {}),
      ...(notDoneRuns ? { notDoneRuns } : {}),
      shortNames: verdict.shortNames.length,
      missingDailyBars: verdict.missingDailyBars.length,
      dayBars,
      shortStocks: verdict.shortStocks.map((stock) => ({ securityId: stock.securityId, bars: barCount(stock.bars, verdict.expectedBars) })),
      dailyBars,
      ...(stuckShort ? { stuckShort } : {}),
      doneRule: TENMIN_DAILY_DONE_RULE,
      updatedAt: stamp(),
    });
    await writeTenMinDailyIndex(store, index);
    sessionReport.selected = index.selected.length;
    sessionReport.stored = stored.size;
    sessionReport.gaps = gaps.size;
    sessionReport.shortNames = verdict.shortNames.length;
    sessionReport.missingDailyBars = verdict.missingDailyBars.length;
    if (refetched) sessionReport.refetchedThisRun = refetched;
    sessionReport.bars = dayBars;
    sessionReport.dailyBars = dailyBars;
    sessionReport.shortStockBars = shortStockCounts(verdict.shortStocks, verdict.expectedBars);
    sessionReport.status = verdict.done
      ? "COMPLETE"
      : stuckShort
        ? TENMIN_DAILY_STUCK_SHORT
        : !verdict.shortNames.length
          ? "WAITING_DAILY_BARS"
          : "PARTIAL";
    report.sessions.push(sessionReport);
  }
  report.estimatedKeyMinutes = Math.round(((report.massiveRequests * TENMIN_DAILY_SECONDS_PER_REQUEST) / 60) * 10) / 10;
  return report;
}

/**
 * The session (inside the 10-session catch-up window) that holds the history chain, or undefined.
 * Reads only the daily indexes and range manifests (no Massive request). A sealed range counts as done
 * only for days the daily step never tracked; a tracked day is done only by its own bars.
 */
export async function tenMinDailyHistoryHold(
  store: Pick<ReplyDustStore, "get" | "head">,
  options: { now?: Date; lastCompletedSession?: string; catchupSessions?: number; calendar?: SessionCalendar } = {},
): Promise<string | undefined> {
  const calendar = options.calendar ?? US_EQUITY_MARKET_CALENDAR;
  const lastCompleted = options.lastCompletedSession ?? lastCompletedSessionDate(options.now ?? new Date(), calendar);
  const sessions = tenMinDailyCatchupSessions(lastCompleted, options.catchupSessions ?? TENMIN_DAILY_CATCHUP_SESSIONS, calendar);
  const days: HistoryHoldDay[] = [];
  for (const sessionDate of sessions) {
    const index = await readTenMinDailyIndex(store, sessionDate);
    // A sealed range counts as done only for a day the daily step never tracked (seal guard). A tracked
    // day under it is not done, but the daily step no longer works it (B3), so it cannot hold the chain.
    if (await tenMinRangeSealedFor(store, sessionDate)) {
      days.push({ sessionDate, done: !index || !!index.done, failed: false });
      continue;
    }
    const done = !!index?.done;
    days.push({ sessionDate, done, failed: !done && (index?.notDoneRuns ?? 0) >= 1, stuckShort: !done && !!index?.stuckShort });
  }
  return historyBlockingDay(days, sessions);
}

/** Seal-guard refusal prefix: a day in the range is still retrying in the daily step. */
export const TENMIN_SEAL_REFUSED_DAY_RETRYING = "TENMIN_SEAL_REFUSED_DAY_RETRYING" as const;

/**
 * Seal guard (Peace, Nov 23): a history range may seal (and so count as done) only if every day in
 * it is full or STUCK_SHORT. Inside the daily step's catch-up window a day it tracks (it has an index)
 * must be done or STUCK_SHORT, and a day it has not tried yet must wait for it. Older than the window
 * (Auditor B1): a pre-rule index (written before the rule) and a day with no index are history-only
 * (the range's own seal checks); a day that left the window not done is STUCK_SHORT (LEFT_WINDOW, no
 * longer retried), stamped by the daily step's sweep, so it never holds the seal forever even while
 * the daily step is paused. Returns the refusal for the first day that must wait, or undefined.
 */
export async function tenMinRangeSealRefusal(
  store: Pick<ReplyDustStore, "get">,
  calendarFrom: string,
  calendarTo: string,
  options: { now?: Date; lastCompletedSession?: string; catchupSessions?: number; calendar?: SessionCalendar } = {},
): Promise<string | undefined> {
  const calendar = options.calendar ?? US_EQUITY_MARKET_CALENDAR;
  const lastCompleted = options.lastCompletedSession ?? lastCompletedSessionDate(options.now ?? new Date(), calendar);
  const window = new Set(tenMinDailyCatchupSessions(lastCompleted, options.catchupSessions ?? TENMIN_DAILY_CATCHUP_SESSIONS, calendar));
  for (const sessionDate of tradingSessionsBetween(calendarFrom, calendarTo, calendar)) {
    if (sessionDate > lastCompleted) break;
    const index = await readTenMinDailyIndex(store, sessionDate);
    if (index) {
      if (index.done || index.stuckShort) continue;
      if (!window.has(sessionDate)) continue;
      // A pre-rule index in the window is re-checked (and recounted) by the next daily step run.
      if (isPreRuleIndex(index)) return `${TENMIN_SEAL_REFUSED_DAY_RETRYING}:${sessionDate}:pre-rule`;
      const counts = tenMinDailyIndexCounts(index, expectedTenMinBars(sessionDate, calendar));
      return `${TENMIN_SEAL_REFUSED_DAY_RETRYING}:${sessionDate}:${counts.dayBars}`;
    }
    if (window.has(sessionDate)) {
      // The daily step tried the day and had no stock to select: nothing of its own to wait for.
      if (await store.get(tenMinDailyNoSelectionKey(sessionDate))) continue;
      return `${TENMIN_SEAL_REFUSED_DAY_RETRYING}:${sessionDate}:not-tried`;
    }
  }
  return undefined;
}

/**
 * History-run override (host): when the daily step is on and R2 is configured, the chain checks the
 * done-day hold before any Massive request and the seal guard before sealing a range. Off otherwise
 * (no daily step, nothing to wait for).
 */
export function tenMinHistoryDailyStepHold(
  env: NodeJS.ProcessEnv,
  openStore: (env: NodeJS.ProcessEnv) => Pick<ReplyDustStore, "get" | "head"> = (e) => R2ObjectClient.fromEnv(e),
): {
  dailyStepHold?: () => Promise<string | undefined>;
  sealGuard?: (calendarFrom: string, calendarTo: string) => Promise<string | undefined>;
} {
  if (!tenMinDailyEnabled(env) || !env.PEACESTOCKS_R2_BUCKET?.trim()) return {};
  return {
    dailyStepHold: () => tenMinDailyHistoryHold(openStore(env)),
    sealGuard: (calendarFrom, calendarTo) => tenMinRangeSealRefusal(openStore(env), calendarFrom, calendarTo),
  };
}

export interface TenMinSecurityDayRead {
  /** range: sealed two-month manifest (authoritative); daily: the daily index; none: neither has it. */
  source: "range" | "daily" | "none";
  bars: CanonicalTenMinuteBar[];
}

/**
 * One security's 10-minute bars for one session from exactly one source: the sealed range
 * manifest when the chain has sealed D's two-month range, otherwise the daily liquid object.
 */
export async function readTenMinSecurityDay(
  store: ReplyDustStore,
  securityId: string,
  sessionDate: string,
  options: { provider?: string; backend?: ReplyDustBackend } = {},
): Promise<TenMinSecurityDayRead> {
  requireDate(sessionDate);
  const backend = options.backend ?? nodeReplyDustBackend;
  const { calendarFrom, calendarTo } = pairRangeForDate(sessionDate);
  if (await tenMinRangeSealedFor(store, sessionDate))
    return {
      source: "range",
      bars: await readRangeSecurityDay(store, calendarFrom, calendarTo, securityId, sessionDate, backend),
    };
  const index = await readTenMinDailyIndex(store, sessionDate);
  const entry = index?.stored.find((item) => item.securityId === securityId);
  if (!index || !entry) return { source: "none", bars: [] };
  const provider = options.provider ?? index.provider;
  return { source: "daily", bars: await decodeDailyObjectBars(store, provider, securityId, sessionDate, entry.fetch, backend) };
}

/** Pure: canonical ten-minute bars for one session from freshly fetched reply pages. */
function barsFromPages(provider: string, sessionDate: string, securityId: string, pages: readonly TenMinuteRangeReply[]): CanonicalTenMinuteBar[] {
  const results: Array<Record<string, unknown>> = [];
  let requestId: unknown;
  for (const page of pages) {
    const parsed = JSON.parse(new TextDecoder().decode(page.body)) as Record<string, unknown>;
    if (requestId === undefined) requestId = parsed.request_id;
    if (Array.isArray(parsed.results))
      for (const raw of parsed.results) if (raw && typeof raw === "object") results.push(raw as Record<string, unknown>);
  }
  const first = pages[0];
  return massiveTenMinuteBarsFromReply({
    provider,
    sessionDate,
    securityId,
    symbol: first?.symbol ?? "",
    reply: { results, ...(requestId === undefined ? {} : { request_id: requestId }) },
    observedAt: first?.fetchedAt ?? "",
  });
}

/** Verify and decode one stored daily object into canonical bars (throws when it does not verify). */
async function decodeDailyObjectBars(
  store: ReplyDustStore,
  provider: string,
  securityId: string,
  sessionDate: string,
  fetch: TenMinRangeTickerFetch,
  backend: ReplyDustBackend,
): Promise<CanonicalTenMinuteBar[]> {
  const { calendarFrom, calendarTo } = pairRangeForDate(sessionDate);
  const verified = await verifyExistingDaily(store, provider, securityId, fetch.symbol, sessionDate, backend, fetch);
  if (!verified || verified === "INVALID") throw new Error(`TENMIN_DAILY_OBJECT_UNVERIFIED:${securityId}:${sessionDate}`);
  const results: Array<Record<string, unknown>> = [];
  let requestId: unknown;
  for (const file of [...verified.files].sort((a, b) => a.page - b.page)) {
    const bytes = await store.get(
      tenMinRangeFileKey(calendarFrom, calendarTo, securityId, verified.symbol, sessionDate, sessionDate, file.page),
    );
    if (!bytes) throw new Error(`REPLY_DUST_FILE_MISSING:${securityId}:${verified.symbol}:p${file.page}`);
    const reply = decodeReplyDust(bytes, backend);
    if (sha256Hex(reply) !== file.replySha256)
      throw new Error(`REPLY_DUST_REPLY_CHECKSUM_MISMATCH:${securityId}:${verified.symbol}:p${file.page}`);
    const parsed = JSON.parse(new TextDecoder().decode(reply)) as Record<string, unknown>;
    if (requestId === undefined) requestId = parsed.request_id;
    if (Array.isArray(parsed.results))
      for (const raw of parsed.results) if (raw && typeof raw === "object") results.push(raw as Record<string, unknown>);
  }
  return massiveTenMinuteBarsFromReply({
    provider,
    sessionDate,
    securityId,
    symbol: verified.symbol,
    reply: { results, ...(requestId === undefined ? {} : { request_id: requestId }) },
    observedAt: verified.observedAt,
  });
}

const ACTIVE_RUN_STATES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

/**
 * Why the daily step must stop now, or undefined. Guard windows always stop it. On Actions it also
 * yields to a waiting scheduled scan (scanner.yml run with event "schedule" and run-name
 * "Scanner"); history runs do not preempt it (they yield to it instead). A failed check yields.
 */
export async function tenMinDailyYieldReason(options: {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  deadlineMs?: number;
} = {}): Promise<string | undefined> {
  const now = (options.now ?? (() => new Date()))();
  if (options.deadlineMs !== undefined && now.getTime() >= options.deadlineMs) return `TIME_BUDGET:${now.toISOString()}`;
  if (inScanGuardWindow(now)) return `SCAN_GUARD_WINDOW:${now.toISOString()}`;
  const result = await checkScannerRuns({ ...options, now: () => now, pick: pickWaitingScheduledScan });
  if (!result) return undefined;
  return result.ok ? result.waiting : `SCAN_CHECK_FAILED:${result.failure}`;
}

/** The daily step yields only to a waiting scheduled scan (history runs yield to it instead). */
export const pickWaitingScheduledScan: ScanRunPick = (runs, self) => {
  const scan = runs.find(
    (run) => run.id !== self && run.event === "schedule" && run.display_title === "Scanner" && ACTIVE_RUN_STATES.has(run.status),
  );
  return scan ? `SCAN_RUN_WAITING:${scan.id}:${scan.status}` : undefined;
};

/** Skip reason while TENMIN_AUTO_REDISPATCH is not exactly "true" (unset counts as paused). */
export const TENMIN_DAILY_SKIP_REDISPATCH_PAUSED = "SKIP_REDISPATCH_PAUSED" as const;

/** Pure: why the daily step must not run now because the history redispatch is paused, else undefined. */
export function tenMinDailyRedispatchHold(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.TENMIN_AUTO_REDISPATCH;
  return value === "true" ? undefined : `${TENMIN_DAILY_SKIP_REDISPATCH_PAUSED}:TENMIN_AUTO_REDISPATCH=${value === undefined ? "unset" : JSON.stringify(value)}`;
}

/** Host entry: kill switch, config parse (before any request), R2 store, shared Massive pace. */
export async function runTenMinDailyFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  if (!tenMinDailyEnabled(env)) return { mode: "tenmin-daily", status: "DISABLED", reason: "TENMIN_DAILY_ENABLED is not exactly true" };
  const n = parseTenMinDailyLiquidN(env.TENMIN_DAILY_LIQUID_N);
  const maxRequests = parseTenMinDailyMaxRequests(env.TENMIN_DAILY_MAX_REQUESTS);
  const budgetMs = parseBoundedInt("TENMIN_DAILY_BUDGET_MS", env.TENMIN_DAILY_BUDGET_MS, TENMIN_DAILY_DEFAULT_BUDGET_MS, 10_200_000);
  // Hold while the history chain's redispatch is paused (e.g. a separate Oct 2024 fetch owns the
  // shared key; its watcher sets TENMIN_AUTO_REDISPATCH back to true only after sealing and read-back).
  const hold = tenMinDailyRedispatchHold({ ...env, TENMIN_AUTO_REDISPATCH: await resolveRedispatchGate(env) });
  if (hold) return { mode: "tenmin-daily", status: "SKIPPED", reason: hold, massiveRequests: 0 };
  const now = new Date();
  if (inScanGuardWindow(now)) return { mode: "tenmin-daily", status: "WAIT_GUARD_WINDOW", at: now.toISOString() };
  const deadlineMs = now.getTime() + budgetMs;
  const root = env.PEACEAI_MARKETS_ROOT ?? env.MARKETS_STORAGE_ROOT ?? "C:\\ProgramData\\PeaceAI\\Markets";
  let store: ReplyDustStore;
  if (env.PEACESTOCKS_R2_BUCKET?.trim()) store = R2ObjectClient.fromEnv(env);
  else if (liquidRequiresObjectStore(env.PEACESTOCKS_REQUIRE_OBJECT_STORE)) throw new Error("OBJECT_STORE_REQUIRED");
  else store = new FileReplyDustStore(root);
  const storage = openMarketStore(root, env);
  await storage.initialize();
  const securities = await storage.loadSecurities();
  const massive = new MassiveMarketProvider({ keepRawReplies: false });
  const dailyScanCheck = createScanYieldCheck({ env, pick: pickWaitingScheduledScan });
  const report = await runTenMinDailyLiquid({
    store,
    securities,
    provider: massive.providerName,
    n,
    maxRequests,
    now,
    // Throttled + retried active-run check (at most one GitHub API call a minute); it fails closed.
    shouldYield: async () => {
      if (Date.now() >= deadlineMs) return `TIME_BUDGET:${new Date().toISOString()}`;
      return dailyScanCheck();
    },
    fetchPages: (security, from, to) => massive.getTenMinuteRangeReplies(security, from, to),
  });
  // After the run: the day (if any) that now holds the history chain, and when this report was written.
  // The fallback reads this report (artifact tenmin-daily-report) to restart a held chain only once
  // the held day itself is full or STUCK_SHORT.
  const historyHold = await tenMinDailyHistoryHold(store).catch(() => undefined);
  return {
    mode: "tenmin-daily",
    status: "RAN",
    ...report,
    rateLimitedResponses: massive.rateLimitedResponses,
    historyHold: historyHold ?? null,
    finishedAt: new Date().toISOString(),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runTenMinDailyFromEnv()
    .then(async (summary) => {
      const line = `${JSON.stringify(summary)}\n`;
      process.stdout.write(line);
      if (process.env.TENMIN_DAILY_REPORT_FILE) await writeFile(process.env.TENMIN_DAILY_REPORT_FILE, line, "utf8");
      // Fail closed and loud on a persistent active-run check failure (same rule as the history run).
      const yielded = typeof summary.yielded === "string" ? summary.yielded : undefined;
      if (isScanCheckFailure(yielded)) {
        process.stdout.write(`::error title=Daily 10-minute step stopped: active-run check failed::${yielded}\n`);
        process.exitCode = 2;
      }
      await reportPart(process.env, "tenmin-daily", isScanCheckFailure(yielded) ? "ERROR" : "OK", isScanCheckFailure(yielded) ? yielded : String(summary.status ?? ""));
    })
    .catch(async (error: unknown) => {
      process.stderr.write(`TENMIN_DAILY_FAILED:${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
      await reportPart(process.env, "tenmin-daily", "ERROR", errorMessage(error));
    });
}
