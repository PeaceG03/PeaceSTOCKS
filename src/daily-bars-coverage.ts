// Daily-bars coverage check: every NYSE trading session from the first stored session to the last
// one that should be stored must have its daily-bars pack (written for every stored session) and
// its month JSONL. LIST only (two prefixes): no GET, no Massive, no writes.
//
// Why: backfill was dispatched as hand-picked ranges (default 2026-08-21..2026-10-02, max_sessions
// 35/60) and nothing checked that the ranges joined up, so 2025-09-22..09-30 (a range cut by
// max_sessions=60 and never resumed) and 2025-10-29..2026-08-20 (never requested) stayed missing
// with no signal. This check makes any such hole fail the scan job loudly.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DAILY_BARS_SIDECAR_PREFIX } from "./daily-bars-sidecar";
import { R2ObjectClient } from "./object-store";
import type { SessionCalendar } from "./scanner";
import { lastCompletedSessionDate } from "./tenmin-history";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

export const DAILY_BARS_MONTH_PREFIX = "permanent/daily-bars/";
export const DAILY_BARS_COVERAGE_GAP = "DAILY_BARS_COVERAGE_GAP" as const;
export const DAILY_BARS_COVERAGE_STALE = "DAILY_BARS_COVERAGE_STALE" as const;

/** Pure: NYSE trading sessions (normal and half days) in [from, to], by the scanner calendar. */
export function tradingSessionsInRange(from: string, to: string, calendar: SessionCalendar = US_EQUITY_MARKET_CALENDAR): string[] {
  const out: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) throw new Error("DAILY_BARS_COVERAGE_BAD_RANGE");
  for (; cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    if (calendar.getSession(date).kind !== "CLOSED") out.push(date);
  }
  return out;
}

/** Pure: previous trading session before `date`. */
export function previousTradingSession(date: string, calendar: SessionCalendar = US_EQUITY_MARKET_CALENDAR): string {
  const cursor = new Date(`${date}T00:00:00Z`);
  for (let i = 0; i < 14; i += 1) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const d = cursor.toISOString().slice(0, 10);
    if (calendar.getSession(d).kind !== "CLOSED") return d;
  }
  throw new Error("DAILY_BARS_COVERAGE_NO_PREVIOUS_SESSION");
}

export interface DailyBarsCoverageReport {
  ok: boolean;
  from: string | undefined;
  to: string | undefined;
  expectedSessions: number;
  storedSessions: number;
  /** Trading sessions with no pack (and so no proof the JSONL has them), oldest first. */
  missingSessions: string[];
  /** The same as contiguous runs of trading sessions. */
  missingRanges: { from: string; to: string; sessions: number }[];
  /** Missing sessions whose month JSONL does not exist at all. */
  missingMonthFiles: string[];
  /** Newest stored session is older than the last session that should be stored. */
  stale?: { latestStored: string; expectedAtLeast: string };
  /** Stored sessions that are not trading sessions (calendar mismatch). */
  notTradingSessions: string[];
  failures: string[];
}

/**
 * Pure: compare stored sessions (from the pack prefix and the month JSONL keys) with the calendar.
 * `from` defaults to the first stored session; `expectedLatest` is the newest session that must
 * be stored now (the check flags STALE when the newest stored one is older).
 */
export function dailyBarsCoverage(input: {
  packKeys: readonly string[];
  monthKeys: readonly string[];
  from?: string;
  expectedLatest?: string;
  calendar?: SessionCalendar;
}): DailyBarsCoverageReport {
  const calendar = input.calendar ?? US_EQUITY_MARKET_CALENDAR;
  const stored = new Set<string>();
  const prefix = `${DAILY_BARS_SIDECAR_PREFIX}/`;
  for (const key of input.packKeys) {
    const match = key.startsWith(prefix) ? /^(\d{4}-\d{2}-\d{2})\/manifest\.json$/u.exec(key.slice(prefix.length)) : null;
    if (match) stored.add(match[1]!);
  }
  const months = new Set<string>();
  for (const key of input.monthKeys) {
    const match = /^permanent\/daily-bars\/(\d{4}-\d{2})\.jsonl$/u.exec(key);
    if (match) months.add(match[1]!);
  }
  const storedSorted = [...stored].sort();
  const from = input.from ?? storedSorted[0];
  const latest = storedSorted.at(-1);
  const to = [latest, input.expectedLatest].filter((d): d is string => !!d).sort().at(-1);
  const failures: string[] = [];
  if (!from || !to) {
    return { ok: false, from, to, expectedSessions: 0, storedSessions: 0, missingSessions: [], missingRanges: [], missingMonthFiles: [], notTradingSessions: [], failures: ["DAILY_BARS_COVERAGE_EMPTY"] };
  }
  const expected = tradingSessionsInRange(from, to, calendar);
  // A session without its month file is missing too, even if a pack exists.
  const missing = expected.filter((d) => !stored.has(d) || !months.has(d.slice(0, 7)));
  const ranges: DailyBarsCoverageReport["missingRanges"] = [];
  const index = new Map(expected.map((d, i) => [d, i]));
  for (const d of missing) {
    const last = ranges.at(-1);
    if (last && index.get(last.to)! + 1 === index.get(d)) {
      last.to = d;
      last.sessions += 1;
    } else ranges.push({ from: d, to: d, sessions: 1 });
  }
  const missingMonthFiles = [...new Set(missing.map((d) => d.slice(0, 7)))].filter((m) => !months.has(m)).sort();
  const notTradingSessions = storedSorted.filter((d) => calendar.getSession(d).kind === "CLOSED");
  if (missing.length)
    failures.push(`${DAILY_BARS_COVERAGE_GAP}:${missing.length}:${ranges.map((r) => (r.from === r.to ? r.from : `${r.from}..${r.to}`)).join(",")}`);
  let stale: DailyBarsCoverageReport["stale"];
  if (input.expectedLatest && latest && latest < input.expectedLatest) {
    stale = { latestStored: latest, expectedAtLeast: input.expectedLatest };
    failures.push(`${DAILY_BARS_COVERAGE_STALE}:latest=${latest}:expected=${input.expectedLatest}`);
  }
  if (notTradingSessions.length) failures.push(`DAILY_BARS_COVERAGE_NOT_TRADING_SESSION:${notTradingSessions.join(",")}`);
  return {
    ok: failures.length === 0,
    from,
    to,
    expectedSessions: expected.length,
    storedSessions: expected.length - missing.length,
    missingSessions: missing,
    missingRanges: ranges,
    missingMonthFiles,
    ...(stale ? { stale } : {}),
    notTradingSessions,
    failures,
  };
}

/**
 * Pure: the newest session that must be stored at `now`. The scan stores the last completed ET
 * session after midnight ET; allow one session of slack (the 09:30Z retry, a provider delay), so
 * only a store two sessions behind is stale.
 */
export function dailyBarsExpectedLatest(now: Date, calendar: SessionCalendar = US_EQUITY_MARKET_CALENDAR): string {
  return previousTradingSession(lastCompletedSessionDate(now, calendar), calendar);
}

export async function checkDailyBarsCoverage(
  client: { list(prefix: string): Promise<string[]> },
  options: { from?: string; now?: Date; calendar?: SessionCalendar } = {},
): Promise<DailyBarsCoverageReport> {
  const [packKeys, monthKeys] = await Promise.all([client.list(`${DAILY_BARS_SIDECAR_PREFIX}/`), client.list(DAILY_BARS_MONTH_PREFIX)]);
  return dailyBarsCoverage({
    packKeys,
    monthKeys,
    ...(options.from ? { from: options.from } : {}),
    expectedLatest: dailyBarsExpectedLatest(options.now ?? new Date(), options.calendar),
    ...(options.calendar ? { calendar: options.calendar } : {}),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const env = process.env;
  checkDailyBarsCoverage(R2ObjectClient.fromEnv(env), env.DAILY_BARS_COVERAGE_FROM ? { from: env.DAILY_BARS_COVERAGE_FROM } : {})
    .then((report) => {
      const { missingSessions, ...summary } = report;
      process.stdout.write(`${JSON.stringify({ mode: "daily-bars-coverage", ...summary, missingSessionsCount: missingSessions.length })}\n`);
      if (!report.ok) {
        // Loud: annotation + failed step (GitHub's failed-run notification). Codes and dates only.
        process.stdout.write(`::error title=Daily bars missing sessions::${report.failures.join(" | ").slice(0, 900)}\n`);
        process.exitCode = 2;
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`DAILY_BARS_COVERAGE_FAILED:${error instanceof Error ? error.message : String(error)}\n`);
      process.stdout.write(`::error title=Daily bars coverage check failed::${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
