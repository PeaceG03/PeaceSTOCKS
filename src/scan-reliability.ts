/**
 * Scan reliability from stored evidence (read-only): did each trading session get its picks FROZEN
 * before the next session's 09:30 ET open? Input: the stored prediction-status records
 * (permanent/prediction-status/<session>.jsonl) and the trading calendar. Output: one row per
 * trading session in the range, the current streak of consecutive on-time freezes ending at the
 * latest session, and every miss with its reason. A session's outcome is its earliest FROZEN record
 * whose freeze time (predictedAt) is before the next session's 09:30 ET open, computed from the
 * trading calendar (the record's own stored nextSessionOpen is never trusted; a differing stored
 * value is flagged storedOpenMismatch). Otherwise it is a miss:
 *  - NO_RECORD: no status was stored for the session at all;
 *  - FROZEN_AFTER_OPEN: frozen, but at or after the open (or with no freeze time);
 *  - <reason>: the latest non-FROZEN record's reason (EVIDENCE_ONLY = collected later, catch-up).
 */
import type { PredictionStatus } from "./contracts";
import { tradingSessionsInRange } from "./daily-bars-coverage";
import { etWallClockToUtc } from "./et-time";
import type { SessionCalendar } from "./scanner";
import { nextSessionOpen } from "./session-open";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

export interface SessionFreeze {
  sessionDate: string;
  onTime: boolean;
  outcome: "FROZEN_BEFORE_OPEN" | "FROZEN_AFTER_OPEN" | "NO_RECORD" | PredictionStatus["reason"];
  /** Minutes between the freeze and the next open (positive = before the open). */
  minutesBeforeOpen?: number;
  records: number;
  /** A FROZEN record stored a nextSessionOpen different from the calendar's (reported, ignored). */
  storedOpenMismatch?: boolean;
}

export interface ScanReliabilityReport {
  from: string;
  to: string;
  sessions: number;
  onTime: number;
  /** Consecutive on-time sessions ending at `to` (0 if `to` itself missed). */
  currentStreak: number;
  longestStreak: number;
  misses: Array<{ sessionDate: string; outcome: SessionFreeze["outcome"] }>;
  rows: SessionFreeze[];
}

export function sessionFreeze(sessionDate: string, records: readonly PredictionStatus[], calendar: SessionCalendar = US_EQUITY_MARKET_CALENDAR): SessionFreeze {
  const own = records.filter((r) => r.sessionDate === sessionDate);
  if (!own.length) return { sessionDate, onTime: false, outcome: "NO_RECORD", records: 0 };
  // Fail closed: with no calendar open the session cannot count as on time.
  const open = nextSessionOpen(sessionDate, calendar)?.nextSessionOpen.getTime() ?? Number.NaN;
  const frozen = own
    .filter((r) => r.status === "FROZEN")
    .map((r) => ({ r, at: Date.parse(r.predictedAt ?? "") }))
    .sort((a, b) => (a.at || Infinity) - (b.at || Infinity));
  const mismatch = frozen.some((f) => f.r.nextSessionOpen !== undefined && Date.parse(f.r.nextSessionOpen) !== open);
  const flag = mismatch ? { storedOpenMismatch: true } : {};
  const onTime = frozen.find((f) => Number.isFinite(f.at) && Number.isFinite(open) && f.at < open);
  if (onTime) return { sessionDate, onTime: true, outcome: "FROZEN_BEFORE_OPEN", minutesBeforeOpen: (open - onTime.at) / 60_000, records: own.length, ...flag };
  if (frozen.length) return { sessionDate, onTime: false, outcome: "FROZEN_AFTER_OPEN", records: own.length, ...flag };
  const latest = [...own].sort((a, b) => (a.attemptedAt ?? a.recordedAt).localeCompare(b.attemptedAt ?? b.recordedAt)).at(-1)!;
  return { sessionDate, onTime: false, outcome: latest.reason, records: own.length };
}

export function scanReliability(
  records: readonly PredictionStatus[],
  from: string,
  to: string,
  calendar: SessionCalendar = US_EQUITY_MARKET_CALENDAR,
): ScanReliabilityReport {
  const rows = tradingSessionsInRange(from, to, calendar).map((d) => sessionFreeze(d, records, calendar));
  let longest = 0;
  let run = 0;
  for (const row of rows) {
    run = row.onTime ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  for (let k = rows.length - 1; k >= 0 && rows[k]!.onTime; k -= 1) current += 1;
  return {
    from,
    to,
    sessions: rows.length,
    onTime: rows.filter((r) => r.onTime).length,
    currentStreak: current,
    longestStreak: longest,
    misses: rows.filter((r) => !r.onTime).map((r) => ({ sessionDate: r.sessionDate, outcome: r.outcome })),
    rows,
  };
}

/** One scanner.yml run as read from `gh run view --json databaseId,event,createdAt,conclusion,jobs` (no logs). */
export interface ScannerRunSummary {
  id: number;
  event: string;
  createdAt: string;
  conclusion: string | null;
  jobs: Array<{ name: string; conclusion: string | null; startedAt?: string; completedAt?: string }>;
}

export interface SessionActions {
  sessionDate: string;
  /** Window: the session's 16:00 ET close to the next session's 09:30 ET open. */
  windowStart: string;
  windowEnd: string;
  runs: number;
  /** `scan` job (any job named scan) attempts that actually ran, and how they ended. */
  scanRan: number;
  scanSucceeded: number;
  scanFailed: number;
  /** Backstop jobs (name contains "backstop") that actually ran and succeeded. */
  backstopSucceeded: number;
}

const isScanJob = (name: string) => name === "scan";
const ran = (c: string | null) => c === "success" || c === "failure" || c === "cancelled" || c === "timed_out";

/** Joins Actions runs to sessions by their freeze window. Counts only; no job logs are read. */
export function actionsBySession(runs: readonly ScannerRunSummary[], sessions: readonly string[], calendar: SessionCalendar = US_EQUITY_MARKET_CALENDAR): SessionActions[] {
  return sessions.map((sessionDate) => {
    const start = etWallClockToUtc(sessionDate, 16, 0).getTime();
    const end = nextSessionOpen(sessionDate, calendar)?.nextSessionOpen.getTime() ?? start + 86_400_000;
    const inWindow = runs.filter((r) => {
      const at = Date.parse(r.createdAt);
      return at >= start && at < end;
    });
    const scans = inWindow.flatMap((r) => r.jobs.filter((j) => isScanJob(j.name) && ran(j.conclusion)));
    return {
      sessionDate,
      windowStart: new Date(start).toISOString(),
      windowEnd: new Date(end).toISOString(),
      runs: inWindow.length,
      scanRan: scans.length,
      scanSucceeded: scans.filter((j) => j.conclusion === "success").length,
      scanFailed: scans.filter((j) => j.conclusion !== "success").length,
      backstopSucceeded: inWindow.flatMap((r) => r.jobs.filter((j) => j.name.includes("backstop") && j.conclusion === "success")).length,
    };
  });
}
