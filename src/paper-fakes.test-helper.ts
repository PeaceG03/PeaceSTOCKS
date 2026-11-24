import type { PaperObjectClient } from "./paper-ledger";
import type { CanonicalDailyBar, CorporateAction, PredictionSet, PredictionStatus, SecurityMasterRecord } from "./contracts";
import { etWallClockToUtc } from "./et-time";
import type { PaperMarketReader } from "./paper-trading";

/** In-memory client that records every call; delete is not part of the ledger's surface. */
export class RecordingClient implements PaperObjectClient {
  readonly objects = new Map<string, Uint8Array>();
  readonly puts: string[] = [];
  readonly calls: string[] = [];
  failPutOn: ((key: string) => boolean) | undefined;
  async get(key: string) {
    this.calls.push(`get ${key}`);
    const found = this.objects.get(key);
    return found ? new Uint8Array(found) : undefined;
  }
  /** Conditional put, as R2 does it with If-None-Match: *: refuses an existing key (412 -> false). */
  async putIfAbsent(key: string, body: Uint8Array) {
    this.calls.push(`put ${key}`);
    if (this.failPutOn?.(key)) throw new Error("INJECTED_CRASH");
    if (this.objects.has(key)) return false;
    this.puts.push(key);
    this.objects.set(key, new Uint8Array(body));
    return true;
  }
  async list(prefix: string) {
    this.calls.push(`list ${prefix}`);
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}


/** In-memory scanner data for paper-trading tests: bars, freeze statuses, pick lists, splits. */
export class FakeMarket implements PaperMarketReader {
  bars: CanonicalDailyBar[] = [];
  statuses: PredictionStatus[] = [];
  sets: PredictionSet[] = [];
  splits: CorporateAction[] = [];
  securities: SecurityMasterRecord[] = [];
  readonly calls: string[] = [];
  async loadPredictionStatuses(sessionDate: string) {
    this.calls.push("statuses");
    return this.statuses.filter((s) => s.sessionDate === sessionDate);
  }
  async loadPredictions(sessionDate: string) {
    this.calls.push("predictions");
    return this.sets.filter((s) => s.sessionDate === sessionDate);
  }
  async loadBarsBetween(from: string, to: string) {
    this.calls.push("bars");
    return this.bars.filter((b) => b.sessionDate >= from && b.sessionDate <= to);
  }
  async loadSecurities() {
    this.calls.push("securities");
    return this.securities;
  }
  async loadSplitActions() {
    this.calls.push("splits");
    return this.splits;
  }

  security(securityId: string, options: { symbol?: string; assetType?: "STOCK" | "ETF"; eligibility?: SecurityMasterRecord["eligibility"] } = {}) {
    this.securities.push({
      securityId,
      currentSymbol: options.symbol ?? securityId.toUpperCase(),
      historicalSymbols: [],
      assetType: options.assetType ?? "STOCK",
      country: "US",
      exchange: "XNAS",
      firstSeenAt: "2020-01-01T00:00:00.000Z",
      status: "ACTIVE",
      tradable: true,
      providerIdentities: [],
      eligibility: options.eligibility ?? "LEVEL_2",
    } as unknown as SecurityMasterRecord);
  }

  bar(securityId: string, sessionDate: string, open: number, close = open, revision = 1) {
    this.bars.push({ securityId, sessionDate, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1000, revision } as unknown as CanonicalDailyBar);
  }

  /** A clean FROZEN status for D whose entries are at T's open, plus D's TOP_15_OVERALL list. */
  freeze(D: string, T: string, ids: string[], patch: Partial<PredictionStatus> = {}, setPatch: Partial<PredictionSet> = {}) {
    const predictedAt = `${T}T06:00:00.000Z`;
    this.statuses.push({
      predictionStatusId: `prediction-status_x_${D}_${this.statuses.length}`,
      sessionDate: D,
      status: "FROZEN",
      reason: "PREDICTIONS_FROZEN",
      scannerVersion: "scanner-v0.1",
      configFingerprint: "c",
      recordedAt: `${D}T23:59:59.999Z`,
      attemptedAt: predictedAt,
      predictedAt,
      nextSessionDate: T,
      nextSessionOpen: etWallClockToUtc(T, 9, 30).toISOString(),
      supersedesPredictionIds: [],
      ...patch,
    });
    this.sets.push({
      predictionId: `prediction_${D}_top15`,
      sessionDate: D,
      setType: "TOP_15_OVERALL",
      securityIds: ids,
      scannerVersion: "scanner-v0.1",
      configFingerprint: "c",
      frozenAt: predictedAt,
      ...setPatch,
    } as PredictionSet);
  }
}
