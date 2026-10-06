export const MARKET_SCHEMA_VERSION = "foundation-d-v0" as const;
export const SCANNER_VERSION = "scanner-v0.1" as const;

export type AssetType = "STOCK" | "ETF";
export type SecurityStatus = "ACTIVE" | "INACTIVE" | "DELISTED" | "CLOSED";
export type HistoryEligibility = "LEVEL_0" | "LEVEL_1" | "LEVEL_2" | "LEVEL_3";
export type DataQuality =
  | "GOOD"
  | "MISSING"
  | "STALE"
  | "SUSPECT"
  | "INSUFFICIENT_HISTORY"
  | "CORPORATE_ACTION_AFFECTED"
  | "HALTED"
  | "PROVIDER_ERROR"
  | "PARTIAL_RUN";
export type SessionKind = "NORMAL" | "HOLIDAY" | "HALF_DAY" | "CLOSED" | "HALT_EXCEPTION";
export type RunStatus =
  "COMPLETE" | "COMPLETE_WITH_WARNINGS" | "PARTIAL" | "FAILED" | "CORRECTED_RECONCILED" | "PROVIDER_NOT_READY";
export type StorageClass = "PERMANENT_EVIDENCE" | "DERIVED_CACHE" | "TRANSIENT_WORKSPACE";
export const INTRADAY_SCHEMA_VERSION = "foundation-d.1-10m-v1" as const;
export const DUST_SCHEMA_VERSION = "dust-v1" as const;

export type IntradayIntervalState =
  | "VALID_TRADED"
  | "NO_TRADE"
  | "HALTED"
  | "NOT_LISTED"
  | "INACTIVE"
  | "PROVIDER_MISSING"
  | "SOURCE_FAILURE"
  | "PARTIAL";

export interface IntradaySessionSpec {
  sessionDate: string;
  kind: SessionKind;
  intervalMinutes: 10;
  expectedIntervals: number;
  openMinutesEastern: number;
  closeMinutesEastern: number;
  source: string;
}

export interface CanonicalTenMinuteBar {
  securityId: string;
  sessionDate: string;
  intervalIndex: number;
  state: IntradayIntervalState;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  vwap?: number;
  transactionCount?: number;
  sourceTimestamp?: string;
  observedAt: string;
  ingestedAt: string;
  dataQuality: DataQuality;
  corporateActionIds: string[];
  flags: string[];
  schemaVersion: typeof INTRADAY_SCHEMA_VERSION;
  revision: number;
  provenance: SourceProvenance;
}

export interface MassiveAggregateBar {
  symbol: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  transactionCount?: number;
}

export interface DustArchiveManifest {
  archiveId: string;
  schemaVersion: typeof DUST_SCHEMA_VERSION;
  logicalSchemaVersion: typeof INTRADAY_SCHEMA_VERSION;
  provider: string;
  sessionDate: string;
  securityCount: number;
  barCount: number;
  blockCount: number;
  compressedBytes: number;
  checksum: string;
  validation: "SEALED_CANONICAL" | "VALIDATED";
  quality: DataQuality | "COMPLETE";
  correctionRevisionState: string;
  sealedAt: string;
  blocks: Array<{
    securityId: string;
    relativePath: string;
    barCount: number;
    byteSize: number;
    sha256: string;
  }>;
}

export interface ProviderIdentity {
  provider: string;
  providerSecurityId: string;
  dataset?: string;
}

export interface SymbolHistory {
  symbol: string;
  effectiveFrom: string;
  effectiveTo?: string;
  source: string;
}

export interface SecurityMasterRecord {
  securityId: string;
  currentSymbol: string;
  historicalSymbols: SymbolHistory[];
  assetType: AssetType;
  country: "US";
  exchange: string;
  firstSeenAt: string;
  listingDate?: string;
  inactiveAt?: string;
  delistedAt?: string;
  status: SecurityStatus;
  tradable: boolean;
  fractional?: boolean;
  providerIdentities: ProviderIdentity[];
  eligibility: HistoryEligibility;
  barCount: number;
  lastUniverseSeenAt: string;
}

export interface ProviderSecurityRecord {
  provider: string;
  providerSecurityId: string;
  symbol: string;
  assetType: AssetType;
  country: string;
  exchange: string;
  active: boolean;
  tradable: boolean;
  fractional?: boolean;
  listingDate?: string;
  providerUpdatedAt?: string;
  /** Provider's delisting date for an inactive record (YYYY-MM-DD), when it gives one. */
  delistedDate?: string;
  /** Other tickers the provider listed under the same identity that lost the merge. */
  formerSymbols?: ProviderFormerSymbol[];
}

export interface ProviderFormerSymbol {
  symbol: string;
  listingDate?: string;
  delistedDate?: string;
}

export interface UniverseMembershipEvidence {
  securityId: string;
  effectiveDate: string;
  included: boolean;
  eligibility: HistoryEligibility;
  reason: "NEW" | "CONTINUED" | "INACTIVE" | "REACTIVATED" | "SCOPE_REJECTED";
  provider: string;
  observedAt: string;
}

export interface UniverseRefreshResult {
  added: number;
  updated: number;
  inactivated: number;
  rejected: number;
  securities: SecurityMasterRecord[];
  membershipEvents: UniverseMembershipEvidence[];
}

export interface SourceProvenance {
  provider: string;
  dataset: string;
  retrievalId: string;
  providerTimestamp?: string;
  ingestionVersion: string;
  normalizerVersion: string;
}

export interface CanonicalDailyBar {
  securityId: string;
  sessionDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  sourceTimestamp?: string;
  observedAt: string;
  ingestedAt: string;
  dataQuality: DataQuality;
  corporateActionIds: string[];
  flags: string[];
  schemaVersion: typeof MARKET_SCHEMA_VERSION;
  revision: number;
  provenance: SourceProvenance;
}

export type CorporateActionType =
  | "SPLIT"
  | "REVERSE_SPLIT"
  | "DIVIDEND"
  | "TICKER_CHANGE"
  | "MERGER"
  | "SPINOFF"
  | "CLOSURE"
  | "DELISTING"
  | "SUCCESSOR";

export interface CorporateAction {
  actionId: string;
  securityId: string;
  actionType: CorporateActionType;
  effectiveDate: string;
  announcedAt?: string;
  details: Record<string, string | number | boolean>;
  observedAt: string;
  provenance: SourceProvenance;
}

export interface CorrectionRecord {
  correctionId: string;
  evidenceKey: string;
  supersedesRevision: number;
  replacementRevision: number;
  reason: string;
  correctedAt: string;
  provenance: SourceProvenance;
}

export interface SessionRecord {
  sessionDate: string;
  kind: SessionKind;
  market: "US_EQUITIES";
  closeTime?: string;
  source: string;
}

export interface FeatureRecipe {
  featureId: string;
  version: string;
  requiredInputs: string[];
  method: string;
  lookback: number;
  minimumHistory: number;
  precision: string;
  missingDataBehavior: string;
}

export interface DerivedFeatures {
  securityId: string;
  asOfDate: string;
  values: Record<string, number | null>;
  recipeVersions: Record<string, string>;
}

export interface ScannerConfig {
  version: string;
  weights: {
    momentum: number;
    trend: number;
    relativeStrength: number;
    risk: number;
    liquidity: number;
  };
  selectionThreshold: number;
}

export interface ScannerBelief {
  decisionId: string;
  securityId: string;
  sessionDate: string;
  eligibility: HistoryEligibility;
  overallRank?: number;
  familyScores: Record<string, number>;
  meaningfulDecision:
    | "RANKED"
    | "INSUFFICIENT_HISTORY"
    | "LIQUIDITY_TOO_LOW"
    | "DATA_QUALITY_SUSPECT"
    | "BELOW_SELECTION_THRESHOLD"
    | "NO_QUALIFYING_OPPORTUNITY"
    | "RISK_REJECT"
    | "NOT_ELIGIBLE";
  scannerVersion: string;
  featureRecipeVersions: Record<string, string>;
  configFingerprint: string;
  evidenceAsOfFingerprint: string;
}

export type PredictionAvailability = "FROZEN" | "UNAVAILABLE";

export interface PredictionStatus {
  predictionStatusId: string;
  sessionDate: string;
  status: PredictionAvailability;
  reason:
    | "SOURCE_COLLECTION_FAILED"
    | "EVIDENCE_ONLY"
    | "NO_QUALIFYING_CANDIDATES"
    | "PREDICTIONS_FROZEN";
  scannerVersion: string;
  configFingerprint: string;
  recordedAt: string;
  sourceRunId?: string;
  supersedesPredictionIds: string[];
}

export interface PredictionSet {
  predictionId: string;
  sessionDate: string;
  setType:
    | "TOP_15_OVERALL"
    | "TOP_50_OVERALL"
    | "STRONGEST_MOMENTUM"
    | "FASTEST_IMPROVING"
    | "DEFENSIVE_LOW_RISK";
  securityIds: string[];
  scannerVersion: string;
  configFingerprint: string;
  frozenAt: string;
}

export interface PartitionManifest {
  partitionId: string;
  category: string;
  sessionStart: string;
  sessionEnd: string;
  rowCount: number;
  schemaVersion: string;
  byteSize: number;
  sha256: string;
  provider: string;
  finalizedAt: string;
  quality: DataQuality | "COMPLETE";
  supersedes?: string;
}

export interface StorageReport {
  permanentBytesToday: number;
  cacheBytes: number;
  transientBytesCreated: number;
  transientBytesDeleted: number;
  rollingMbPerDay: number;
  projectedGbPerYear: number;
  targetUtilizationPercent: number;
  categoryBytes: Record<string, number>;
}

export interface ScannerRunReport {
  runId: string;
  session: SessionRecord;
  status: RunStatus;
  expectedSecurities: number;
  processedSecurities: number;
  validSecurities: number;
  incompleteSecurities: number;
  unresolvedFailures: string[];
  skips?: string[];
  storage: StorageReport;
  scannerVersion: string;
  sourceCommit: string;
  completedAt: string;
  predictionStatus?: PredictionAvailability;
  predictionReason?: PredictionStatus["reason"];
  /** HTTP 429 responses the provider received during this run, including ones a retry recovered. */
  rateLimitedResponses?: number;
}

export interface ListSecuritiesOptions {
  shouldStop?: () => Promise<string | undefined>;
}

/** Massive's reply to one bar request, exactly as received, kept so it can be stored losslessly. */
export interface ProviderRawReply {
  dataset: "stocks-grouped-daily" | "stocks-aggregates-10m";
  sessionDate: string;
  /** Set for per-security requests (10-minute bars); absent for the whole-market grouped reply. */
  securityId?: string;
  symbol?: string;
  /** Request path and query with the API key removed. */
  request: string;
  fetchedAt: string;
  body: Uint8Array;
}

export interface MarketProvider {
  readonly providerName: string;
  /** Running count of HTTP 429 responses received, when the provider tracks it. */
  readonly rateLimitedResponses?: number;
  /**
   * shouldStop is asked at every page boundary after the first page; a reason aborts the whole
   * listing (no partial result is returned) so the caller can yield to a scan.
   */
  listApprovedSecurities(options?: ListSecuritiesOptions): Promise<ProviderSecurityRecord[]>;
  getDailyBars(sessionDate: string, securityIds: string[]): Promise<CanonicalDailyBar[]>;
  getIntradayBars?(sessionDate: string, securityIds: string[]): Promise<CanonicalTenMinuteBar[]>;
  getCorporateActions(sessionDate: string, securityIds: string[]): Promise<CorporateAction[]>;
  /** Hands over (and forgets) every bar reply received since the last call, oldest first. */
  takeRawReplies?(): ProviderRawReply[];
}
