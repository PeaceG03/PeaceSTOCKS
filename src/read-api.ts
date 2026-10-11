import type { ScannerRunReport } from "./contracts";
import { resolveSessionPredictionStatus } from "./prediction-status";
import type { MarketStore } from "./storage";

export interface ScannerHealth {
  status: ScannerRunReport["status"];
  sessionDate: string;
  sourceCommit: string;
  completedAt: string;
  predictionStatus: string;
}

const SUCCESS = new Set<ScannerRunReport["status"]>([
  "COMPLETE",
  "COMPLETE_WITH_WARNINGS",
  "CORRECTED_RECONCILED",
]);

export function providerHealth(report: ScannerRunReport): string {
  if (report.status === "PROVIDER_NOT_READY") return "NOT_READY";
  if (report.unresolvedFailures.some((failure) => failure.includes("MASSIVE_CREDENTIAL_REJECTED")))
    return "CREDENTIAL_REJECTED";
  if (
    report.unresolvedFailures.some(
      (failure) =>
        failure.startsWith("EVIDENCE_PROVIDER_ERROR") || failure.startsWith("UNIVERSE_PROVIDER_ERROR"),
    )
  )
    return "PROVIDER_ERROR";
  return "OK";
}

function latest(reports: readonly ScannerRunReport[]): ScannerRunReport | undefined {
  return [...reports].sort(
    (left, right) =>
      left.session.sessionDate.localeCompare(right.session.sessionDate) ||
      left.completedAt.localeCompare(right.completedAt),
  ).at(-1);
}

export async function latestScan(storage: MarketStore): Promise<ScannerRunReport | undefined> {
  return latest(await storage.loadRunReports());
}

export async function latestSuccess(storage: MarketStore): Promise<ScannerRunReport | undefined> {
  return latest((await storage.loadRunReports()).filter((report) => SUCCESS.has(report.status)));
}

export async function lastFailure(storage: MarketStore): Promise<ScannerRunReport | undefined> {
  return latest(
    (await storage.loadRunReports()).filter(
      (report) => report.status === "FAILED" || report.status === "PROVIDER_NOT_READY",
    ),
  );
}

export async function scannerHealth(storage: MarketStore): Promise<ScannerHealth | undefined> {
  const report = await latestScan(storage);
  if (!report) return undefined;
  const statuses = await storage.loadPredictionStatuses(report.session.sessionDate);
  const resolved = resolveSessionPredictionStatus(statuses);
  return {
    status: report.status,
    sessionDate: report.session.sessionDate,
    sourceCommit: report.sourceCommit,
    completedAt: report.completedAt,
    predictionStatus: resolved?.status ?? report.predictionStatus ?? "UNKNOWN",
  };
}

/**
 * Read-only scanner status routes. The scanner never ranks: the former rank routes
 * (/scanner/top15, /scanner/top50, /scanner/ticker/:t) and the beliefs they read are retired and
 * answer 404 NOT_FOUND like any unknown path. Existing permanent/beliefs/ objects are left in place.
 */
export async function readScannerRoute(
  storage: MarketStore,
  path: string,
): Promise<{ status: number; body: unknown }> {
  switch (path) {
    case "/scanner/latest":
      return { status: 200, body: (await latestScan(storage)) ?? null };
    case "/scanner/health":
      return { status: 200, body: (await scannerHealth(storage)) ?? null };
    case "/scanner/provider-health": {
      const report = await latestScan(storage);
      return { status: 200, body: report ? providerHealth(report) : null };
    }
    case "/scanner/latest-success":
      return { status: 200, body: (await latestSuccess(storage)) ?? null };
    case "/scanner/last-failure":
      return { status: 200, body: (await lastFailure(storage)) ?? null };
    default:
      return { status: 404, body: { error: "NOT_FOUND" } };
  }
}
