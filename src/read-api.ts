import type { PredictionSet, ScannerBelief, ScannerRunReport, SecurityMasterRecord } from "./contracts";
import type { MarketStore } from "./storage";

export interface ReadableResult {
  ticker: string;
  securityId: string;
  assetType: string;
  overallRank: number | null;
  familyScores: Record<string, number>;
  sessionDate: string;
  runId: string;
  predictionStatus: string;
  providerHealth: string;
  skips: string[];
}

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

function project(
  ids: readonly string[],
  beliefs: readonly ScannerBelief[],
  securities: readonly SecurityMasterRecord[],
  report: ScannerRunReport,
): ReadableResult[] {
  const beliefById = new Map(beliefs.map((belief) => [belief.securityId, belief]));
  const securityById = new Map(securities.map((security) => [security.securityId, security]));
  return ids.map((securityId) => {
    const security = securityById.get(securityId);
    const belief = beliefById.get(securityId);
    return {
      ticker: security?.currentSymbol ?? "UNKNOWN",
      securityId,
      assetType: security?.assetType ?? "UNKNOWN",
      overallRank: belief?.overallRank ?? null,
      familyScores: belief?.familyScores ?? {},
      sessionDate: report.session.sessionDate,
      runId: report.runId,
      predictionStatus: report.predictionStatus ?? "UNKNOWN",
      providerHealth: providerHealth(report),
      skips: report.skips ?? [],
    };
  });
}

async function setIds(
  storage: MarketStore,
  sessionDate: string,
  setType: PredictionSet["setType"],
): Promise<string[]> {
  const sets = await storage.loadPredictions(sessionDate);
  return sets.find((set) => set.setType === setType)?.securityIds ?? [];
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
  return {
    status: report.status,
    sessionDate: report.session.sessionDate,
    sourceCommit: report.sourceCommit,
    completedAt: report.completedAt,
    predictionStatus: report.predictionStatus ?? "UNKNOWN",
  };
}

export async function readableSet(
  storage: MarketStore,
  setType: PredictionSet["setType"],
): Promise<ReadableResult[]> {
  const report = await latestSuccess(storage);
  if (!report) return [];
  const [ids, beliefs, securities] = await Promise.all([
    setIds(storage, report.session.sessionDate, setType),
    storage.loadBeliefs(report.session.sessionDate),
    storage.loadSecurities(),
  ]);
  return project(ids, beliefs, securities, report);
}

export async function readScannerRoute(
  storage: MarketStore,
  path: string,
): Promise<{ status: number; body: unknown }> {
  switch (path) {
    case "/scanner/latest":
      return { status: 200, body: (await latestScan(storage)) ?? null };
    case "/scanner/top15":
      return { status: 200, body: await readableSet(storage, "TOP_15_OVERALL") };
    case "/scanner/top50":
      return { status: 200, body: await readableSet(storage, "TOP_50_OVERALL") };
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
