import type { PredictionSet, PredictionStatus, ScannerRunReport, SecurityMasterRecord } from "./contracts";
import { HEALTH_PARTS, latestHealthCheckin, type HealthCheckin } from "./health-checkins";
import { resolveSessionPredictionStatus } from "./prediction-status";
import { readReason } from "./site-read-error";

/** Same key as health-check.ts HEALTH_CHECK_LATEST_KEY (not imported: that module pulls in node:fs). */
export const SITE_HEALTH_LATEST_KEY = "permanent/health/check/latest.json";

/**
 * What the private PeaceSTOCKS site shows, gathered with reads only (get + list). Bounded: at most
 * `maxReports` run reports are fetched per page view (the newest by listing date when the listing
 * carries one), so a page view stays well under the Worker subrequest limit however many runs exist.
 */
export interface SiteReader {
  get(key: string): Promise<Uint8Array | undefined>;
  list(prefix: string): Promise<string[]>;
  /** Optional sized listing; `lastModified` (ISO) picks the newest run reports without reading them all. */
  listSizes?(prefix: string): Promise<Array<{ key: string; size: number; lastModified?: string }>>;
}

export interface SiteHealth {
  at?: string;
  headline: string;
  attention: boolean;
  errors?: number;
  missing?: number;
  lines: string[];
}

export interface SiteCheckin {
  part: string;
  name: string;
  state: string;
  at: string;
  message?: string;
  remaining?: number;
}

export interface SiteReport {
  sessionDate: string;
  status: string;
  completedAt: string;
  expected: number;
  valid: number;
  incomplete: number;
  failures: string[];
  failureCount: number;
  predictionStatus?: string;
}

export interface SitePicks {
  setType: string;
  symbols: string[];
  /** The list could not be computed honestly for this session (it is then empty). */
  unavailableReason?: string;
}

export interface SitePredictions {
  /** "off" when the newest session has no prediction sets (predictions are not being made). */
  state: "off" | "on";
  sessionDate?: string;
  status?: string;
  reason?: string;
  picks: SitePicks[];
}

export interface SiteData {
  generatedAt: string;
  health?: SiteHealth;
  checkins: SiteCheckin[];
  /** Last session the scanner considers handled (scheduler cursor). */
  caughtUpThrough?: string;
  backlog: { remaining?: number; state?: string; message?: string };
  reports: SiteReport[];
  predictions: SitePredictions;
  /** Reads that failed (key prefix only); the page still renders what it could read. */
  readErrors: string[];
  /** Why each failed read failed: HTTP status + S3 <Code>, or an error name. Never values or body text. */
  readErrorReasons?: Record<string, string>;
}

export const SITE_MAX_REPORTS = 20;
const FAILURES_SHOWN = 3;
const TEXT_MAX = 200;

function json<T>(bytes: Uint8Array | undefined): T | undefined {
  if (!bytes || bytes.byteLength === 0) return undefined;
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function jsonl<T>(bytes: Uint8Array | undefined): T[] {
  if (!bytes) return [];
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function clip(value: string): string {
  return value.length > TEXT_MAX ? `${value.slice(0, TEXT_MAX - 1)}…` : value;
}

interface ReadErrors {
  names: string[];
  reasons: Record<string, string>;
}

async function attempt<T>(label: string, errors: ReadErrors, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    errors.names.push(label);
    errors.reasons[label] ??= readReason(error);
    return undefined;
  }
}

async function newestReportKeys(reader: SiteReader, max: number): Promise<string[]> {
  if (reader.listSizes) {
    const entries = (await reader.listSizes("runs/")).filter((entry) => entry.key.endsWith(".json"));
    if (entries.every((entry) => entry.lastModified !== undefined))
      return entries
        .sort((a, b) => (b.lastModified! < a.lastModified! ? -1 : b.lastModified! > a.lastModified! ? 1 : 0))
        .slice(0, max)
        .map((entry) => entry.key);
  }
  // No listing dates: report ids are hashes, so take a bounded slice rather than reading every report.
  return (await reader.list("runs/")).filter((key) => key.endsWith(".json")).slice(-max);
}

function summarize(report: ScannerRunReport): SiteReport {
  const failures = report.unresolvedFailures ?? [];
  return {
    sessionDate: report.session.sessionDate,
    status: report.status,
    completedAt: report.completedAt,
    expected: report.expectedSecurities,
    valid: report.validSecurities,
    incomplete: report.incompleteSecurities,
    failures: failures.slice(0, FAILURES_SHOWN).map(clip),
    failureCount: failures.length,
    ...(report.predictionStatus ? { predictionStatus: report.predictionStatus } : {}),
  };
}

export async function loadSiteData(
  reader: SiteReader,
  options: { now?: () => Date; maxReports?: number } = {},
): Promise<SiteData> {
  const now = options.now ?? (() => new Date());
  const readErrors: ReadErrors = { names: [], reasons: {} };

  const rawHealth = await attempt("health", readErrors, async () =>
    json<{ at?: string; headline?: string; attention?: boolean; errors?: number; missing?: number; lines?: string[] }>(
      await reader.get(SITE_HEALTH_LATEST_KEY),
    ),
  );
  const health: SiteHealth | undefined = rawHealth
    ? {
        ...(rawHealth.at ? { at: rawHealth.at } : {}),
        headline: rawHealth.headline ?? "(no headline)",
        attention: rawHealth.attention === true,
        ...(typeof rawHealth.errors === "number" ? { errors: rawHealth.errors } : {}),
        ...(typeof rawHealth.missing === "number" ? { missing: rawHealth.missing } : {}),
        lines: (rawHealth.lines ?? []).slice(1).map(clip),
      }
    : undefined;

  const checkins: SiteCheckin[] = [];
  let scanCheckin: HealthCheckin | undefined;
  for (const part of HEALTH_PARTS) {
    const latest = await attempt(`checkins/${part.id}`, readErrors, () => latestHealthCheckin(reader, part.id));
    if (!latest) continue;
    if (part.id === "scan") scanCheckin = latest;
    checkins.push({
      part: part.id,
      name: part.name,
      state: latest.state,
      at: latest.at,
      ...(latest.message ? { message: clip(latest.message) } : {}),
      ...(latest.remaining !== undefined ? { remaining: latest.remaining } : {}),
    });
  }

  const scheduler = await attempt("scheduler", readErrors, async () =>
    json<{ lastObservedSessionDate?: string }>(await reader.get("scheduler-host-state.json")),
  );

  const reports: SiteReport[] = [];
  const max = options.maxReports ?? SITE_MAX_REPORTS;
  const keys = (await attempt("runs", readErrors, () => newestReportKeys(reader, max))) ?? [];
  for (const key of keys) {
    const report = await attempt("runs", readErrors, async () => json<ScannerRunReport>(await reader.get(key)));
    if (report?.session?.sessionDate) reports.push(summarize(report));
  }
  reports.sort((a, b) => b.sessionDate.localeCompare(a.sessionDate) || b.completedAt.localeCompare(a.completedAt));

  const latestSession = reports[0]?.sessionDate;
  const predictions: SitePredictions = { state: "off", picks: [] };
  if (latestSession) {
    predictions.sessionDate = latestSession;
    const statuses =
      (await attempt("prediction-status", readErrors, async () =>
        jsonl<PredictionStatus>(await reader.get(`permanent/prediction-status/${latestSession}.jsonl`)),
      )) ?? [];
    const resolved = resolveSessionPredictionStatus(statuses);
    if (resolved) {
      predictions.status = resolved.status;
      predictions.reason = resolved.reason;
    } else if (reports[0]?.predictionStatus) predictions.status = reports[0].predictionStatus;
    const sets =
      (await attempt("predictions", readErrors, async () =>
        jsonl<PredictionSet>(await reader.get(`permanent/predictions/${latestSession}.jsonl`)),
      )) ?? [];
    if (sets.length) {
      predictions.state = "on";
      const securities =
        (await attempt("securities", readErrors, async () =>
          json<SecurityMasterRecord[]>(await reader.get("permanent/security-master.json")),
        )) ?? [];
      const symbol = new Map(securities.map((record) => [record.securityId, record.currentSymbol]));
      predictions.picks = sets.map((set) => ({
        setType: set.setType,
        symbols: set.securityIds.map((id) => symbol.get(id) ?? id),
        ...(set.unavailableReason ? { unavailableReason: set.unavailableReason } : {}),
      }));
    }
  }

  return {
    generatedAt: now().toISOString(),
    ...(health ? { health } : {}),
    checkins,
    ...(scheduler?.lastObservedSessionDate ? { caughtUpThrough: scheduler.lastObservedSessionDate } : {}),
    backlog: {
      ...(scanCheckin?.remaining !== undefined ? { remaining: scanCheckin.remaining } : {}),
      ...(scanCheckin ? { state: scanCheckin.state } : {}),
      ...(scanCheckin?.message ? { message: clip(scanCheckin.message) } : {}),
    },
    reports,
    predictions,
    readErrors: [...new Set(readErrors.names)],
    ...(readErrors.names.length ? { readErrorReasons: { ...readErrors.reasons } } : {}),
  };
}
