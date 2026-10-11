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
import type { CanonicalDailyBar, CanonicalTenMinuteBar, SecurityMasterRecord, TenMinuteRangeReply } from "./contracts";
import { FileReplyDustStore, type ReplyDustStore, sha256Hex } from "./intraday-reply-dust";
import { MassiveMarketProvider, massiveTenMinuteBarsFromReply } from "./massive-provider";
import { R2ObjectClient } from "./object-store";
import { openMarketStore } from "./object-storage";
import { type ReplyDustBackend, decodeReplyDust, nodeReplyDustBackend } from "./reply-dust";
import { type ZstdVersionProbe, assertPinnedZstdForWriting } from "./reply-dust-pin";
import { inScanGuardWindow } from "./scan-yield";
import type { SessionCalendar } from "./scanner";
import { TENMIN_DAILY_CLOSE_ORIGIN } from "./tenmin-range-entries";
import { lastCompletedSessionDate, pairRangeForDate } from "./tenmin-history";
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
  updatedAt: string;
  checksum: string;
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

export type TenMinDailySessionStatus = "COMPLETE" | "PARTIAL" | "SKIPPED_RANGE_SEALED" | "NO_SELECTION";

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

  for (const sessionDate of sessions) {
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
    if (await tenMinRangeSealedFor(store, sessionDate)) {
      sessionReport.status = "SKIPPED_RANGE_SEALED";
      report.sessions.push(sessionReport);
      continue;
    }
    let index = await readTenMinDailyIndex(store, sessionDate);
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

    try {
      for (const name of index.selected) {
        if (stored.has(name.securityId)) continue;
        const yieldReason = options.shouldYield ? await options.shouldYield() : undefined;
        if (yieldReason) {
          report.yielded = yieldReason;
          stop = true;
          break;
        }
        const existing = await verifyExistingDaily(store, provider, name.securityId, name.symbol, sessionDate, backend);
        if (existing === "INVALID") {
          gaps.set(name.securityId, { securityId: name.securityId, symbol: name.symbol, reason: "TENMIN_DAILY_OBJECT_UNVERIFIED", at: stamp() });
          dirty = true;
          continue;
        }
        if (existing) {
          stored.set(name.securityId, { securityId: name.securityId, fetch: existing, adopted: true });
          sessionReport.adoptedThisRun += 1;
          dirty = true;
          if (++sinceSave >= INDEX_SAVE_EVERY) await save();
          continue;
        }
        if (report.massiveRequests >= options.maxRequests) {
          report.budgetStop = true;
          stop = true;
          break;
        }
        report.massiveRequests += 1;
        sessionReport.requests += 1;
        try {
          const pages = await options.fetchPages({ securityId: name.securityId, symbol: name.symbol }, sessionDate, sessionDate);
          report.massiveRequests += Math.max(0, pages.length - 1);
          sessionReport.requests += Math.max(0, pages.length - 1);
          const { fetch } = await writeTenMinRangeFetch(store, pages, {
            provider,
            calendarFrom,
            calendarTo,
            fetchFrom: sessionDate,
            fetchTo: sessionDate,
            backend,
            origin: TENMIN_DAILY_CLOSE_ORIGIN,
          });
          stored.set(name.securityId, { securityId: name.securityId, fetch });
          sessionReport.fetchedThisRun += 1;
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
    sessionReport.selected = index.selected.length;
    sessionReport.stored = stored.size;
    sessionReport.gaps = gaps.size;
    sessionReport.status = stored.size + gaps.size >= index.selected.length ? "COMPLETE" : "PARTIAL";
    report.sessions.push(sessionReport);
  }
  report.estimatedKeyMinutes = Math.round(((report.massiveRequests * TENMIN_DAILY_SECONDS_PER_REQUEST) / 60) * 10) / 10;
  return report;
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
  const verified = await verifyExistingDaily(store, provider, securityId, entry.fetch.symbol, sessionDate, backend, entry.fetch);
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
  return {
    source: "daily",
    bars: massiveTenMinuteBarsFromReply({
      provider,
      sessionDate,
      securityId,
      symbol: verified.symbol,
      reply: { results, ...(requestId === undefined ? {} : { request_id: requestId }) },
      observedAt: verified.observedAt,
    }),
  };
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
    const body = (await response.json()) as {
      workflow_runs?: { id: number; status: string; event: string; display_title?: string | null }[];
    };
    const self = Number(env.GITHUB_RUN_ID);
    const scan = (body.workflow_runs ?? []).find(
      (run) =>
        run.id !== self && run.event === "schedule" && run.display_title === "Scanner" && ACTIVE_RUN_STATES.has(run.status),
    );
    return scan ? `SCAN_RUN_WAITING:${scan.id}:${scan.status}` : undefined;
  } catch (error) {
    return `SCAN_CHECK_FAILED:${String(error).slice(0, 120)}`;
  }
}

/** Host entry: kill switch, config parse (before any request), R2 store, shared Massive pace. */
export async function runTenMinDailyFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  if (!tenMinDailyEnabled(env)) return { mode: "tenmin-daily", status: "DISABLED", reason: "TENMIN_DAILY_ENABLED is not exactly true" };
  const n = parseTenMinDailyLiquidN(env.TENMIN_DAILY_LIQUID_N);
  const maxRequests = parseTenMinDailyMaxRequests(env.TENMIN_DAILY_MAX_REQUESTS);
  const budgetMs = parseBoundedInt("TENMIN_DAILY_BUDGET_MS", env.TENMIN_DAILY_BUDGET_MS, TENMIN_DAILY_DEFAULT_BUDGET_MS, 10_200_000);
  const now = new Date();
  if (inScanGuardWindow(now)) return { mode: "tenmin-daily", status: "WAIT_GUARD_WINDOW", at: now.toISOString() };
  const deadlineMs = now.getTime() + budgetMs;
  const root = env.PEACEAI_MARKETS_ROOT ?? env.MARKETS_STORAGE_ROOT ?? "C:\\ProgramData\\PeaceAI\\Markets";
  let store: ReplyDustStore;
  if (env.PEACESTOCKS_R2_BUCKET?.trim()) store = R2ObjectClient.fromEnv(env);
  else if (env.PEACESTOCKS_REQUIRE_OBJECT_STORE === "1") throw new Error("OBJECT_STORE_REQUIRED");
  else store = new FileReplyDustStore(root);
  const storage = openMarketStore(root, env);
  await storage.initialize();
  const securities = await storage.loadSecurities();
  const massive = new MassiveMarketProvider({ keepRawReplies: false });
  const report = await runTenMinDailyLiquid({
    store,
    securities,
    provider: massive.providerName,
    n,
    maxRequests,
    now,
    shouldYield: () => tenMinDailyYieldReason({ env, deadlineMs }),
    fetchPages: (security, from, to) => massive.getTenMinuteRangeReplies(security, from, to),
  });
  return { mode: "tenmin-daily", status: "RAN", ...report, rateLimitedResponses: massive.rateLimitedResponses };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runTenMinDailyFromEnv()
    .then(async (summary) => {
      const line = `${JSON.stringify(summary)}\n`;
      process.stdout.write(line);
      if (process.env.TENMIN_DAILY_REPORT_FILE) await writeFile(process.env.TENMIN_DAILY_REPORT_FILE, line, "utf8");
    })
    .catch((error: unknown) => {
      process.stderr.write(`TENMIN_DAILY_FAILED:${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
