// Nightly scan health record (scanner-quality batch). Each forward scan of a trading session writes
// one small JSON next to the other health reports (permanent/health/scan/<D>.json, plus latest.json),
// with the same size + checksum read-back the health check uses. It answers, without opening run
// reports: did the scan finish before the next session's open, what was decided about the freeze,
// how many names were covered, and how many the eligibility floor and the split guard left out.
// Pure module (no node:fs): the site imports the keys and the record type.
import type { ScannerRunReport } from "./contracts";

export const SCAN_HEALTH_SCHEMA = "scan-health-v1" as const;
export const SCAN_HEALTH_PREFIX = "permanent/health/scan/" as const;
export const SCAN_HEALTH_LATEST_KEY = "permanent/health/scan/latest.json" as const;
/** One marker per session already alerted as a missed freeze (so the alert is raised once). */
export const MISSED_FREEZE_ALERT_PREFIX = "permanent/health/scan/missed-freeze-alerts/" as const;

export function scanHealthKey(sessionDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(sessionDate)) throw new Error("SCAN_HEALTH_BAD_SESSION_DATE");
  return `${SCAN_HEALTH_PREFIX}${sessionDate}.json`;
}

export type FreezeDecision = "FROZEN" | "UNAVAILABLE" | "NO_DECISION";

export interface ScanHealthRecord {
  schemaVersion: typeof SCAN_HEALTH_SCHEMA;
  sessionDate: string;
  runId: string;
  runStatus: string;
  completedAt: string;
  /** The open the freeze had to beat (next trading session, 09:30 New York). */
  nextSessionDate?: string;
  nextSessionOpen?: string;
  /** The scan run finished strictly before that open. Null when no next open is known. */
  finishedBeforeOpen: boolean | null;
  freezeStatus: FreezeDecision;
  freezeReason?: string;
  /** Picks frozen, and frozen strictly before the open. */
  frozenOnTime: boolean;
  namesExpected: number;
  /** Names with a stored bar for the session (the scan's coverage). */
  namesCovered: number;
  eligibilityFloorExcluded: { total: number; byReason: Record<string, number> };
  splitGuardExcluded: { total: number; byReason: Record<string, number> };
}

function before(a: string | undefined, b: string | undefined): boolean | null {
  if (!a || !b) return null;
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return x < y;
}

function counts(byReason: Record<string, number> | undefined): { total: number; byReason: Record<string, number> } {
  const clean: Record<string, number> = {};
  let total = 0;
  for (const [reason, n] of Object.entries(byReason ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!Number.isInteger(n) || n <= 0) continue;
    clean[reason] = n;
    total += n;
  }
  return { total, byReason: clean };
}

/** Pure: the health record for one finished scan run. `nextOpen` is used when the report has none. */
export function buildScanHealth(
  report: ScannerRunReport,
  nextOpen?: { nextSessionDate: string; nextSessionOpen: string },
  /** The scanner clock at finish (ISO UTC); defaults to the report's completedAt. */
  finishedAt: string = report.completedAt,
): ScanHealthRecord {
  const nextSessionOpen = report.nextSessionOpen ?? nextOpen?.nextSessionOpen;
  const nextSessionDate = report.nextSessionDate ?? nextOpen?.nextSessionDate;
  const freezeStatus: FreezeDecision = report.predictionStatus ?? "NO_DECISION";
  const frozenBeforeOpen = before(report.predictedAt, nextSessionOpen);
  return {
    schemaVersion: SCAN_HEALTH_SCHEMA,
    sessionDate: report.session.sessionDate,
    runId: report.runId,
    runStatus: report.status,
    completedAt: finishedAt,
    ...(nextSessionDate ? { nextSessionDate } : {}),
    ...(nextSessionOpen ? { nextSessionOpen } : {}),
    finishedBeforeOpen: before(finishedAt, nextSessionOpen),
    freezeStatus,
    ...(report.predictionReason ? { freezeReason: report.predictionReason } : {}),
    frozenOnTime: freezeStatus === "FROZEN" && frozenBeforeOpen === true,
    namesExpected: report.expectedSecurities,
    namesCovered: report.processedSecurities,
    eligibilityFloorExcluded: counts(report.eligibilityFloorExcludedByReason),
    splitGuardExcluded: counts(report.splitGuardExcludedByReason),
  };
}

/** Pure: reasons -> counts. */
export function countByReason(rows: ReadonlyArray<{ reason: string }> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows ?? []) out[row.reason] = (out[row.reason] ?? 0) + 1;
  return out;
}
