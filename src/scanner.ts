import { createHash } from "node:crypto";
import type {
  CanonicalDailyBar,
  CorporateAction,
  MarketProvider,
  RunStatus,
  ScannerRunReport,
  SessionKind,
  SessionRecord,
  ProviderSecurityRecord,
  PredictionStatus,
  SecurityMasterRecord,
} from "./contracts";
import { MARKET_SCHEMA_VERSION, SCANNER_VERSION } from "./contracts";
import { rankSecurities } from "./ranking";
import { fingerprint } from "./identity";
import { sessionCollectionDue } from "./et-time";
import { makePredictionStatus, sessionAlreadyFrozen } from "./prediction-status";
import { refreshEligibility, refreshUniverse } from "./universe";
import type { MarketStore } from "./storage";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";
import type { DustReader } from "./reader";
import type { ReplyDustStore } from "./intraday-reply-dust";
import type { ReplyDustBackend } from "./reply-dust";
import type { ZstdVersionProbe } from "./reply-dust-pin";
import {
  disabledScanGroupedReplyDustReport,
  maybeStoreScanGroupedReplyDust,
  type ScanGroupedReplyDustReport,
} from "./scan-grouped-reply-dust";

export interface SessionCalendar {
  getSession(sessionDate: string): SessionRecord;
}
export type ScannerRunMode = "FORWARD" | "EVIDENCE_ONLY";

const HOLIDAYS = new Set(["01-01", "07-04", "12-25"]);
export const US_EQUITY_CALENDAR: SessionCalendar = {
  getSession(sessionDate) {
    const date = new Date(`${sessionDate}T00:00:00Z`);
    const weekday = date.getUTCDay();
    const kind: SessionKind =
      weekday === 0 || weekday === 6 || HOLIDAYS.has(sessionDate.slice(5)) ? "CLOSED" : "NORMAL";
    return { sessionDate, kind, market: "US_EQUITIES", source: "scanner-v0-calendar" };
  },
};


const SPY_BENCHMARK_TICKER = "SPY";
const SPY_HISTORY_SESSIONS_REQUIRED = 21;

export function resolveSpyBenchmarkId(
  securities: readonly SecurityMasterRecord[],
): string | undefined {
  const matches = securities.filter(
    (security) => security.currentSymbol === SPY_BENCHMARK_TICKER && security.assetType === "ETF",
  );
  return (matches.find((security) => security.status === "ACTIVE") ?? matches[0])?.securityId;
}

export interface MarketsScannerGroupedReplyDustOptions {
  enabled: boolean;
  store?: ReplyDustStore;
  backend?: ReplyDustBackend;
  zstdVersionProbe?: ZstdVersionProbe;
}

export class MarketsScanner {
  constructor(
    private readonly provider: MarketProvider,
    private readonly storage: MarketStore,
    private readonly calendar: SessionCalendar = US_EQUITY_MARKET_CALENDAR,
    private readonly groupedReplyDust: MarketsScannerGroupedReplyDustOptions | undefined = undefined,
    /** Injectable clock for the collection-due gate (defaults to Date). */
    private readonly now: () => Date = () => new Date(),
  ) {}

  private rateLimitedAtRunStart = 0;

  async run(sessionDate: string, mode: ScannerRunMode = "FORWARD"): Promise<ScannerRunReport> {
    this.rateLimitedAtRunStart = this.provider.rateLimitedResponses ?? 0;
    await this.storage.initialize();
    const session = this.calendar.getSession(sessionDate);
    const runId = `scan_${fingerprint({ sessionDate, provider: this.provider.providerName, version: SCANNER_VERSION, ...(mode === "EVIDENCE_ONLY" ? { mode } : {}) }).slice(0, 24)}`;
    // Session D is due only when the current America/New_York date is strictly after D.
    if (!sessionCollectionDue(sessionDate, this.now())) {
      return this.finish({
        runId,
        session,
        status: "NOT_DUE",
        expectedSecurities: 0,
        processedSecurities: 0,
        validSecurities: 0,
        incompleteSecurities: 0,
        unresolvedFailures: [],
        scannerVersion: SCANNER_VERSION,
        ...(this.groupedReplyDust
          ? { groupedReplyDust: disabledScanGroupedReplyDustReport("NOT_DUE") }
          : {}),
      });
    }
    if (session.kind === "CLOSED" || session.kind === "HOLIDAY")
      return this.finish({
        runId,
        session,
        status: "COMPLETE",
        expectedSecurities: 0,
        processedSecurities: 0,
        validSecurities: 0,
        incompleteSecurities: 0,
        unresolvedFailures: [],
        scannerVersion: SCANNER_VERSION,
        ...(this.groupedReplyDust
          ? {
              groupedReplyDust: disabledScanGroupedReplyDustReport(
                session.kind === "HOLIDAY" ? "HOLIDAY" : "CLOSED",
              ),
            }
          : {}),
      });
    // Before any Massive request for D: skip if predictions already frozen for the session.
    if (await sessionAlreadyFrozen(this.storage, sessionDate)) {
      return this.finish({
        runId,
        session,
        status: "ALREADY_FROZEN",
        expectedSecurities: 0,
        processedSecurities: 0,
        validSecurities: 0,
        incompleteSecurities: 0,
        unresolvedFailures: [],
        scannerVersion: SCANNER_VERSION,
        predictionStatus: "FROZEN",
        predictionReason: "PREDICTIONS_FROZEN",
        ...(this.groupedReplyDust
          ? {
              groupedReplyDust: disabledScanGroupedReplyDustReport("ALREADY_FROZEN"),
            }
          : {}),
      });
    }
    const failures: string[] = [];
    let refresh;
    try {
      refresh = await refreshUniverse(this.provider, this.storage, sessionDate);
      for (const warning of refresh.warnings ?? []) process.stderr.write(`${warning}\n`);
      const bindUniverse = (
        this.provider as MarketProvider & {
          bindUniverse?: (records: ProviderSecurityRecord[]) => void;
        }
      ).bindUniverse;
      if (bindUniverse)
        bindUniverse.call(
          this.provider,
          refresh.securities.map((security) => ({
            provider: this.provider.providerName,
            providerSecurityId:
              security.providerIdentities.find(
                (identity) => identity.provider === this.provider.providerName,
              )?.providerSecurityId ?? security.securityId,
            symbol: security.currentSymbol,
            assetType: security.assetType,
            country: security.country,
            exchange: security.exchange,
            active: security.status === "ACTIVE",
            tradable: security.tradable,
            ...(security.fractional === undefined ? {} : { fractional: security.fractional }),
          })),
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const providerNotReady = message.startsWith("PROVIDER_NOT_READY");
      failures.push(
        providerNotReady
          ? `PROVIDER_NOT_READY:${message}`
          : `UNIVERSE_PROVIDER_ERROR:${message}`,
      );
      try {
        await this.storage.writePredictionStatus(
          makePredictionStatus(runId, {
            sessionDate,
            status: "UNAVAILABLE",
            reason: "SOURCE_COLLECTION_FAILED",
            scannerVersion: SCANNER_VERSION,
            configFingerprint: fingerprint({ version: "scanner-config-v0.1" }),
            recordedAt: `${sessionDate}T23:59:59.999Z`,
            attemptedAt: this.now().toISOString(),
            sourceRunId: runId,
            supersedesPredictionIds: [],
          }),
        );
      } catch (statusError) {
        failures.push(`IMMUTABLE_PREDICTION_STATUS_CONFLICT:${String(statusError)}`);
      }
      return this.finish({
        runId,
        session,
        status: providerNotReady ? "PROVIDER_NOT_READY" : "FAILED",
        expectedSecurities: 0,
        processedSecurities: 0,
        validSecurities: 0,
        incompleteSecurities: 0,
        unresolvedFailures: failures,
        scannerVersion: SCANNER_VERSION,
        predictionStatus: "UNAVAILABLE",
        predictionReason: "SOURCE_COLLECTION_FAILED",
      });
    }
    const ids = refresh.securities
      .filter((security) => security.status === "ACTIVE")
      .map((security) => security.securityId);
    let bars: CanonicalDailyBar[] = [];
    let actions: CorporateAction[] = [];
    // Start both as before (Promise.all). If corporate-actions rejects first, still await the
    // bars promise so keepRawReplies can finish and the dust step can store those bytes without
    // changing append/report behavior when either side fails.
    const barsPromise = this.provider.getDailyBars(sessionDate, ids);
    const actionsPromise = this.provider.getCorporateActions(sessionDate, ids);
    try {
      [bars, actions] = await Promise.all([barsPromise, actionsPromise]);
      await this.storage.appendBars(bars);
      await this.storage.appendActions(actions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(
        message.startsWith("PROVIDER_NOT_READY")
          ? `PROVIDER_NOT_READY:${message}`
          : `EVIDENCE_PROVIDER_ERROR:${message}`,
      );
      await barsPromise.then(
        () => undefined,
        () => undefined,
      );
    }
    // Store grouped-daily Reply Dust from any reply the provider still holds (even when
    // corporate-actions failed after getDailyBars kept raw bytes).
    let groupedReplyDust: ScanGroupedReplyDustReport | undefined;
    if (this.groupedReplyDust) {
      groupedReplyDust = await maybeStoreScanGroupedReplyDust({
        enabled: this.groupedReplyDust.enabled,
        ...(this.groupedReplyDust.store ? { store: this.groupedReplyDust.store } : {}),
        provider: this.provider,
        sessionDate,
        ...(this.groupedReplyDust.backend ? { backend: this.groupedReplyDust.backend } : {}),
        ...(this.groupedReplyDust.zstdVersionProbe
          ? { zstdVersionProbe: this.groupedReplyDust.zstdVersionProbe }
          : {}),
      });
    }
    const expected = ids.length;
    const received = new Set(
      bars.filter((bar) => bar.sessionDate === sessionDate).map((bar) => bar.securityId),
    );
    const partitionQuality =
      failures.length === 0 ? "GOOD" : received.size > 0 ? "PARTIAL_RUN" : "PROVIDER_ERROR";
    try {
      await finalizeDailyPartition(
        this.storage,
        sessionDate,
        this.provider.providerName,
        partitionQuality,
      );
    } catch (error) {
      failures.push(`PARTITION_FINALIZATION_ERROR:${String(error)}`);
    }
    const incomplete = ids.filter((id) => !received.has(id)).length;
    if (incomplete) failures.push(`MISSING_SECURITY_EVIDENCE:${incomplete}`);
    const securities = await refreshEligibility(this.storage);
    const allBars = await this.storage.loadBars();
    const spyId = resolveSpyBenchmarkId(securities);
    const benchmark = spyId ? allBars.filter((bar) => bar.securityId === spyId) : [];
    const spySessions = new Set(benchmark.map((bar) => bar.sessionDate));
    const skips: string[] = [];
    if (!spyId) skips.push("RELATIVE_STRENGTH_SKIP:SPY_NOT_IN_SECURITY_MASTER");
    else if (spySessions.size < SPY_HISTORY_SESSIONS_REQUIRED)
      skips.push("RELATIVE_STRENGTH_SKIP:SPY_HISTORY_SHORT");
    const result = rankSecurities(securities, allBars, benchmark, sessionDate);
    const providerNotReady = failures.some((failure) => failure.startsWith("PROVIDER_NOT_READY"));
    const sourceCollectionFailed =
      providerNotReady ||
      failures.some((failure) => failure.startsWith("EVIDENCE_PROVIDER_ERROR:"));
    const predictionUnavailableReason: PredictionStatus["reason"] | undefined =
      sourceCollectionFailed
        ? "SOURCE_COLLECTION_FAILED"
        : mode === "EVIDENCE_ONLY"
          ? "EVIDENCE_ONLY"
          : undefined;
    const predictionIds = result.predictions.map((prediction) => prediction.predictionId);
    const emptyPredictionSets = result.predictions.every(
      (prediction) => prediction.securityIds.length === 0,
    );
    if (predictionUnavailableReason) {
      // Use the matching reason code — do not stamp SOURCE_COLLECTION_FAILED when collection ok.
      failures.push(
        predictionUnavailableReason === "SOURCE_COLLECTION_FAILED"
          ? "PREDICTION_UNAVAILABLE_SOURCE_COLLECTION_FAILED"
          : `PREDICTION_UNAVAILABLE_${predictionUnavailableReason}`,
      );
      try {
        await this.storage.writePredictionStatus(
          makePredictionStatus(runId, {
            sessionDate,
            status: "UNAVAILABLE",
            reason: predictionUnavailableReason,
            scannerVersion: SCANNER_VERSION,
            configFingerprint: fingerprint({ version: "scanner-config-v0.1" }),
            recordedAt: `${sessionDate}T23:59:59.999Z`,
            attemptedAt: this.now().toISOString(),
            sourceRunId: runId,
            supersedesPredictionIds: predictionIds,
          }),
        );
      } catch (statusError) {
        failures.push(`IMMUTABLE_PREDICTION_STATUS_CONFLICT:${String(statusError)}`);
      }
    } else {
      try {
        await this.storage.writeBeliefs(result.beliefs);
        await this.storage.writePredictions(result.predictions);
        await this.storage.writeDecisions(result.beliefs);
        await this.storage.writePredictionStatus(
          makePredictionStatus(runId, {
            sessionDate,
            status: "FROZEN",
            reason: emptyPredictionSets ? "NO_QUALIFYING_CANDIDATES" : "PREDICTIONS_FROZEN",
            scannerVersion: SCANNER_VERSION,
            configFingerprint: fingerprint({ version: "scanner-config-v0.1" }),
            recordedAt: `${sessionDate}T23:59:59.999Z`,
            attemptedAt: this.now().toISOString(),
            sourceRunId: runId,
            supersedesPredictionIds: [],
          }),
        );
      } catch (error) {
        failures.push(`IMMUTABLE_DECISION_CONFLICT:${String(error)}`);
      }
    }
    const status: RunStatus = providerNotReady
      ? "PROVIDER_NOT_READY"
      : failures.length === 0
        ? "COMPLETE"
        : received.size > 0
          ? "COMPLETE_WITH_WARNINGS"
          : "FAILED";
    return this.finish({
      runId,
      session,
      status,
      expectedSecurities: expected,
      processedSecurities: received.size,
      validSecurities: bars.filter((bar) => bar.dataQuality === "GOOD").length,
      incompleteSecurities: incomplete,
      unresolvedFailures: failures,
      ...(skips.length ? { skips } : {}),
      scannerVersion: SCANNER_VERSION,
      ...(predictionUnavailableReason
        ? {
            predictionStatus: "UNAVAILABLE" as const,
            predictionReason: predictionUnavailableReason,
          }
        : {
            predictionStatus: "FROZEN" as const,
            predictionReason: emptyPredictionSets
              ? ("NO_QUALIFYING_CANDIDATES" as const)
              : ("PREDICTIONS_FROZEN" as const),
          }),
      ...(groupedReplyDust ? { groupedReplyDust } : {}),
    });
  }

  private readProviderReadiness(sessionDate: string): ScannerRunReport["providerReadiness"] {
    const provider = this.provider as MarketProvider & {
      providerReadinessFor?: (sessionDate: string) => ScannerRunReport["providerReadiness"];
    };
    return provider.providerReadinessFor?.(sessionDate);
  }

  private async finish(
    input: Omit<ScannerRunReport, "completedAt" | "storage" | "sourceCommit" | "rateLimitedResponses">,
  ): Promise<ScannerRunReport> {
    const readiness =
      input.providerReadiness ?? this.readProviderReadiness(input.session.sessionDate);
    const report: ScannerRunReport = {
      ...input,
      sourceCommit: process.env.PEACESTOCKS_SOURCE_COMMIT?.trim() || "UNKNOWN",
      rateLimitedResponses: (this.provider.rateLimitedResponses ?? 0) - this.rateLimitedAtRunStart,
      completedAt: new Date().toISOString(),
      storage: await this.storage.measureStorage(),
      ...(readiness ? { providerReadiness: readiness } : {}),
    };
    await this.storage.writeRunReport(report);
    return report;
  }
}

export async function finalizeDailyPartition(
  storage: MarketStore,
  sessionDate: string,
  provider: string,
  quality: "GOOD" | "PARTIAL_RUN" | "PROVIDER_ERROR",
): Promise<void> {
  const relative = `daily-bars/${sessionDate.slice(0, 7)}.jsonl`;
  const bytes = await storage.readPermanent(relative);
  const lines = bytes.length ? bytes.toString("utf8").trim().split("\n").filter(Boolean) : [];
  const sessionDates = lines
    .map((line) => line.match(/"sessionDate":"(\d{4}-\d{2}-\d{2})"/)?.[1])
    .filter((value): value is string => Boolean(value))
    .sort();
  const manifest = {
    partitionId: `daily-bars-${sessionDate.slice(0, 7)}`,
    category: "canonical-daily-bars",
    sessionStart: sessionDates[0] ?? sessionDate,
    sessionEnd: sessionDates.at(-1) ?? sessionDate,
    rowCount: lines.length,
    schemaVersion: MARKET_SCHEMA_VERSION,
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    provider,
    finalizedAt: new Date().toISOString(),
    quality,
  };
  await storage.writePartitionManifest(manifest);
}

/**
 * Scanner V0 compatibility boundary: reconstruct daily evidence from the
 * canonical 10-minute Reader without storing a second permanent daily source.
 */
export async function reconstructDailyBarsFromReader(
  reader: Pick<DustReader, "reconstructDaily">,
  sessionDate: string,
  securityIds: readonly string[],
): Promise<CanonicalDailyBar[]> {
  const reconstructed = await Promise.all(
    securityIds.map((securityId) => reader.reconstructDaily(sessionDate, securityId)),
  );
  return reconstructed.filter((bar): bar is CanonicalDailyBar => bar !== undefined);
}
