import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  CanonicalDailyBar,
  CorporateAction,
  MarketProvider,
  PredictionStatus,
  ProviderSecurityRecord,
  SecurityMasterRecord,
} from "./contracts";
import { MARKET_SCHEMA_VERSION, SCANNER_VERSION } from "./contracts";
import { fingerprint, securityId, stableJson } from "./identity";
import {
  makePredictionStatus,
  predictionStatusContentId,
  resolveSessionPredictionStatus,
} from "./prediction-status";
import { MarketsScanner } from "./scanner";
import { MarketStorage } from "./storage";
import { ObjectMarketStorage } from "./object-storage";
import { MemoryObjectClient } from "./object-store";

const SESSION = "2026-10-05";
const OLD_RUN = "scan_412ee524980b106d93cd0d29";

function providerRecord(
  providerSecurityId: string,
  symbol: string,
  assetType: "STOCK" | "ETF" = "STOCK",
): ProviderSecurityRecord {
  return {
    provider: "fixture-provider",
    providerSecurityId,
    symbol,
    assetType,
    country: "US",
    exchange: "NYSE",
    active: true,
    tradable: true,
  };
}

function bar(
  securityIdValue: string,
  date: string,
  close: number,
  stamps: { observedAt: string; ingestedAt: string; retrievalId: string },
  revision = 1,
): CanonicalDailyBar {
  return {
    securityId: securityIdValue,
    sessionDate: date,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1000,
    observedAt: stamps.observedAt,
    ingestedAt: stamps.ingestedAt,
    dataQuality: "GOOD",
    corporateActionIds: [],
    flags: [],
    schemaVersion: "foundation-d-v0",
    revision,
    provenance: {
      provider: "fixture-provider",
      dataset: "daily-ohlcv",
      retrievalId: stamps.retrievalId,
      ingestionVersion: "test",
      normalizerVersion: "test",
    },
  };
}

class CountingProvider implements MarketProvider {
  readonly providerName = "fixture-provider";
  listCalls = 0;
  barsCalls = 0;
  actionsCalls = 0;
  constructor(
    private readonly universe: ProviderSecurityRecord[],
    private readonly bars: CanonicalDailyBar[],
    private readonly actions: CorporateAction[] = [],
    private readonly listError?: string,
  ) {}
  async listApprovedSecurities(): Promise<ProviderSecurityRecord[]> {
    this.listCalls += 1;
    if (this.listError) throw new Error(this.listError);
    return this.universe;
  }
  async getDailyBars(sessionDate: string, securityIds: string[]): Promise<CanonicalDailyBar[]> {
    this.barsCalls += 1;
    return this.bars.filter(
      (item) => item.sessionDate === sessionDate && securityIds.includes(item.securityId),
    );
  }
  async getCorporateActions(): Promise<CorporateAction[]> {
    this.actionsCalls += 1;
    return this.actions;
  }
  totalCalls(): number {
    return this.listCalls + this.barsCalls + this.actionsCalls;
  }
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "peaceai-s1-"));
}

function oldStyleUnavailable(runId: string, sessionDate: string): PredictionStatus {
  return {
    predictionStatusId: `prediction-status_${runId}`,
    sessionDate,
    status: "UNAVAILABLE",
    reason: "SOURCE_COLLECTION_FAILED",
    scannerVersion: SCANNER_VERSION,
    configFingerprint: fingerprint({ version: "scanner-config-v0.1" }),
    recordedAt: `${sessionDate}T23:59:59.999Z`,
    sourceRunId: runId,
    supersedesPredictionIds: [],
  };
}

test("resolveSessionPredictionStatus: any FROZEN wins; else newest recordedAt", () => {
  const older: PredictionStatus = {
    ...oldStyleUnavailable("scan_a", SESSION),
    recordedAt: "2026-10-05T02:06:00.000Z",
  };
  const newerUnavailable: PredictionStatus = makePredictionStatus("scan_b", {
    sessionDate: SESSION,
    status: "UNAVAILABLE",
    reason: "EVIDENCE_ONLY",
    scannerVersion: SCANNER_VERSION,
    configFingerprint: "cfg",
    recordedAt: "2026-10-05T07:56:00.000Z",
    sourceRunId: "scan_b",
    supersedesPredictionIds: [],
  });
  const frozen: PredictionStatus = makePredictionStatus("scan_c", {
    sessionDate: SESSION,
    status: "FROZEN",
    reason: "PREDICTIONS_FROZEN",
    scannerVersion: SCANNER_VERSION,
    configFingerprint: "cfg",
    recordedAt: "2026-10-05T03:00:00.000Z", // older than newerUnavailable
    sourceRunId: "scan_c",
    supersedesPredictionIds: [],
  });
  assert.equal(resolveSessionPredictionStatus([older, newerUnavailable, frozen])?.status, "FROZEN");
  assert.equal(resolveSessionPredictionStatus([older, newerUnavailable])?.predictionStatusId, newerUnavailable.predictionStatusId);
  // Tie on recordedAt → predictionStatusId ascending
  const a = { ...frozen, predictionStatusId: "prediction-status_scan_z_aaaaaaaaaaaaaaaa", recordedAt: "2026-10-05T03:00:00.000Z" };
  const b = { ...frozen, predictionStatusId: "prediction-status_scan_a_bbbbbbbbbbbbbbbb", recordedAt: "2026-10-05T03:00:00.000Z" };
  assert.equal(resolveSessionPredictionStatus([a, b])?.predictionStatusId, b.predictionStatusId);
});

test("S1.1: NOT_READY then successful FROZEN — both status records, one frozen set, reader says FROZEN", async () => {
  const dir = await root();
  try {
    const storage = new ObjectMarketStorage(new MemoryObjectClient());
    await storage.initialize();
    const id = securityId("fixture-provider", "issuer-1", "STOCK");
    const notReady = new CountingProvider([providerRecord("issuer-1", "AAA")], [], [], "PROVIDER_NOT_READY:MASSIVE");
    const first = await new MarketsScanner(notReady, storage).run(SESSION);
    assert.equal(first.status, "PROVIDER_NOT_READY");
    const afterNotReady = await storage.loadPredictionStatuses(SESSION);
    assert.equal(afterNotReady.length, 1);
    assert.equal(afterNotReady[0]!.status, "UNAVAILABLE");

    const stamps = {
      observedAt: `${SESSION}T21:00:00.000Z`,
      ingestedAt: `${SESSION}T22:00:00.000Z`,
      retrievalId: "retrieval-success",
    };
    const ok = new CountingProvider(
      [providerRecord("issuer-1", "AAA")],
      [bar(id, SESSION, 100, stamps)],
    );
    // FORWARD freeze after NOT_READY (EVIDENCE_ONLY still records UNAVAILABLE/EVIDENCE_ONLY by design).
    const second = await new MarketsScanner(ok, storage).run(SESSION, "FORWARD");
    assert.ok(
      second.status === "COMPLETE" || second.status === "COMPLETE_WITH_WARNINGS",
      second.status,
    );
    assert.equal(second.predictionStatus, "FROZEN");
    const statuses = await storage.loadPredictionStatuses(SESSION);
    assert.equal(statuses.length, 2);
    assert.ok(statuses.some((s) => s.status === "UNAVAILABLE"));
    assert.ok(statuses.some((s) => s.status === "FROZEN"));
    assert.equal(resolveSessionPredictionStatus(statuses)?.status, "FROZEN");
    const preds = await storage.loadPredictions(SESSION);
    assert.ok(preds.length >= 1);
    // Single frozen write path — one TOP_50 set among them
    assert.equal(preds.filter((p) => p.setType === "TOP_50_OVERALL").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S1.2: FROZEN then retry → ALREADY_FROZEN, zero provider calls, no new decision writes", async () => {
  const dir = await root();
  try {
    const storage = new ObjectMarketStorage(new MemoryObjectClient());
    await storage.initialize();
    const id = securityId("fixture-provider", "issuer-1", "STOCK");
    const stamps = {
      observedAt: `${SESSION}T21:00:00.000Z`,
      ingestedAt: `${SESSION}T22:00:00.000Z`,
      retrievalId: "retrieval-1",
    };
    const provider = new CountingProvider(
      [providerRecord("issuer-1", "AAA")],
      [bar(id, SESSION, 100, stamps)],
    );
    const first = await new MarketsScanner(provider, storage).run(SESSION);
    assert.equal(first.predictionStatus, "FROZEN");
    const callsAfterFirst = provider.totalCalls();
    assert.ok(callsAfterFirst > 0);
    const beliefs1 = await storage.loadBeliefs(SESSION);
    const preds1 = await storage.loadPredictions(SESSION);
    const statuses1 = await storage.loadPredictionStatuses(SESSION);

    const retry = await new MarketsScanner(provider, storage).run(SESSION, "EVIDENCE_ONLY");
    assert.equal(retry.status, "ALREADY_FROZEN");
    assert.equal(provider.totalCalls(), callsAfterFirst); // zero new provider calls
    assert.deepEqual(await storage.loadBeliefs(SESSION), beliefs1);
    assert.deepEqual(await storage.loadPredictions(SESSION), preds1);
    assert.deepEqual(await storage.loadPredictionStatuses(SESSION), statuses1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S1.3: identical UNAVAILABLE content → one record; different content → two, nothing overwritten", async () => {
  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  await storage.initialize();
  const body = {
    sessionDate: SESSION,
    status: "UNAVAILABLE" as const,
    reason: "SOURCE_COLLECTION_FAILED" as const,
    scannerVersion: SCANNER_VERSION,
    configFingerprint: fingerprint({ version: "scanner-config-v0.1" }),
    recordedAt: `${SESSION}T23:59:59.999Z`,
    sourceRunId: OLD_RUN,
    supersedesPredictionIds: [] as string[],
  };
  const first = makePredictionStatus(OLD_RUN, body);
  await storage.writePredictionStatus(first);
  await storage.writePredictionStatus(makePredictionStatus(OLD_RUN, body)); // identical → no-op
  assert.equal((await storage.loadPredictionStatuses(SESSION)).length, 1);

  const different = makePredictionStatus(OLD_RUN, {
    ...body,
    reason: "EVIDENCE_ONLY",
    recordedAt: `${SESSION}T23:59:59.999Z`,
  });
  assert.notEqual(different.predictionStatusId, first.predictionStatusId);
  await storage.writePredictionStatus(different);
  const all = await storage.loadPredictionStatuses(SESSION);
  assert.equal(all.length, 2);
  assert.ok(all.some((s) => s.predictionStatusId === first.predictionStatusId && s.reason === "SOURCE_COLLECTION_FAILED"));
  assert.ok(all.some((s) => s.predictionStatusId === different.predictionStatusId && s.reason === "EVIDENCE_ONLY"));
});

test("S1.4: production sequence — old-style 412ee status + leftover bars/actions/partition/master; EVIDENCE_ONLY succeeds", async () => {
  const dir = await root();
  try {
    // File store so we can assert first-write-wins on daily-bars jsonl bytes.
    const storage = new MarketStorage(dir);
    await storage.initialize();
    const id = securityId("fixture-provider", "issuer-1", "STOCK");

    // Leftovers from crashed 08:25Z attempt — stamps DIFFER from the re-run provider.
    const leftoverBar = bar(id, SESSION, 100, {
      observedAt: "2026-10-05T08:25:00.000Z",
      ingestedAt: "2026-10-05T08:25:01.000Z",
      retrievalId: "crashed-attempt-retrieval",
    });
    await storage.appendBars([leftoverBar]);
    const leftoverAction: CorporateAction = {
      actionId: `action-${id}-${SESSION}`,
      securityId: id,
      actionType: "SPLIT",
      effectiveDate: SESSION,
      details: { ratio: 2 },
      observedAt: "2026-10-05T08:25:00.000Z",
      provenance: {
        provider: "fixture-provider",
        dataset: "corporate-actions",
        retrievalId: "crashed-actions",
        ingestionVersion: "test",
        normalizerVersion: "test",
      },
    };
    await storage.appendActions([leftoverAction]);
    await storage.writePartitionManifest({
      partitionId: "daily-bars-2026-10",
      category: "canonical-daily-bars",
      sessionStart: SESSION,
      sessionEnd: SESSION,
      rowCount: 1,
      schemaVersion: MARKET_SCHEMA_VERSION,
      byteSize: 1,
      sha256: "0".repeat(64),
      provider: "fixture-provider",
      finalizedAt: "2026-10-05T08:25:00.000Z",
      quality: "PARTIAL_RUN",
    });
    const leftoverMaster: SecurityMasterRecord = {
      securityId: id,
      currentSymbol: "AAA",
      historicalSymbols: [],
      assetType: "STOCK",
      country: "US",
      exchange: "NYSE",
      firstSeenAt: SESSION,
      status: "ACTIVE",
      tradable: true,
      providerIdentities: [
        { provider: "fixture-provider", providerSecurityId: "issuer-1" },
      ],
      eligibility: "LEVEL_0",
      barCount: 1,
      lastUniverseSeenAt: SESSION,
    };
    await storage.saveSecurities([leftoverMaster]);

    // Old-style prediction-status_scan_412ee… (SOURCE_COLLECTION_FAILED) from 02:06Z.
    const legacy = oldStyleUnavailable(OLD_RUN, SESSION);
    assert.equal(legacy.predictionStatusId, `prediction-status_${OLD_RUN}`);
    await storage.writePredictionStatus(legacy);

    const barsBefore = await storage.loadBars(SESSION);
    assert.equal(barsBefore.length, 1);
    assert.equal(barsBefore[0]!.observedAt, "2026-10-05T08:25:00.000Z");
    assert.equal(barsBefore[0]!.provenance.retrievalId, "crashed-attempt-retrieval");

    // Re-run EVIDENCE_ONLY with DIFFERENT ingestion stamps — must not conflict.
    const rerunStamps = {
      observedAt: "2026-10-05T21:00:00.000Z",
      ingestedAt: "2026-10-05T22:00:00.000Z",
      retrievalId: "rerun-retrieval",
    };
    const provider = new CountingProvider(
      [providerRecord("issuer-1", "AAA")],
      [bar(id, SESSION, 100, rerunStamps)],
      [
        {
          ...leftoverAction,
          observedAt: "2026-10-05T21:00:00.000Z",
          provenance: { ...leftoverAction.provenance, retrievalId: "rerun-actions" },
        },
      ],
    );
    const report = await new MarketsScanner(provider, storage).run(SESSION, "EVIDENCE_ONLY");
    assert.ok(!report.unresolvedFailures.some((f) => f.includes("IMMUTABLE_RECORD_CONFLICT")), report.unresolvedFailures.join(","));
    assert.ok(!report.unresolvedFailures.includes("PREDICTION_UNAVAILABLE_SOURCE_COLLECTION_FAILED"));
    assert.ok(
      report.unresolvedFailures.includes("PREDICTION_UNAVAILABLE_EVIDENCE_ONLY"),
      report.unresolvedFailures.join(","),
    );
    assert.equal(report.predictionStatus, "UNAVAILABLE");
    assert.equal(report.predictionReason, "EVIDENCE_ONLY");
    // Run report written
    const reports = await storage.loadRunReports();
    assert.ok(reports.some((r) => r.runId === report.runId));

    // Bars first-write-wins: leftover stamps preserved, no duplicate key
    const barsAfter = await storage.loadBars(SESSION);
    assert.equal(barsAfter.length, 1);
    assert.equal(barsAfter[0]!.observedAt, "2026-10-05T08:25:00.000Z");
    assert.equal(barsAfter[0]!.provenance.retrievalId, "crashed-attempt-retrieval");

    // Legacy status untouched; new content-addressed status added
    const statuses = await storage.loadPredictionStatuses(SESSION);
    assert.ok(statuses.some((s) => s.predictionStatusId === `prediction-status_${OLD_RUN}`));
    assert.ok(statuses.length >= 2);
    const legacyStill = statuses.find((s) => s.predictionStatusId === `prediction-status_${OLD_RUN}`)!;
    assert.equal(legacyStill.reason, "SOURCE_COLLECTION_FAILED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S1.5: forced conflict on unavailable write is recorded, not thrown", async () => {
  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  await storage.initialize();
  // Pre-seed content-addressed id that the universe-failure path will try to write,
  // but with DIFFERENT body fields so writeImmutable throws.
  const runId = `scan_${fingerprint({ sessionDate: SESSION, provider: "fixture-provider", version: SCANNER_VERSION }).slice(0, 24)}`;
  const body = {
    sessionDate: SESSION,
    status: "UNAVAILABLE" as const,
    reason: "SOURCE_COLLECTION_FAILED" as const,
    scannerVersion: SCANNER_VERSION,
    configFingerprint: fingerprint({ version: "scanner-config-v0.1" }),
    recordedAt: `${SESSION}T23:59:59.999Z`,
    sourceRunId: runId,
    supersedesPredictionIds: [] as string[],
  };
  const id = predictionStatusContentId(runId, body);
  // Plant a conflicting record under the same id (impossible via makePredictionStatus; force it).
  const conflict: PredictionStatus = {
    ...body,
    predictionStatusId: id,
    reason: "EVIDENCE_ONLY", // different → IMMUTABLE_RECORD_CONFLICT on rewrite with SOURCE_COLLECTION_FAILED body
  };
  // Write via a one-off: first write the conflict record with makePredictionStatus for EVIDENCE_ONLY
  // then manually the issue is different ids. Instead wrap storage.writePredictionStatus.
  const realWrite = storage.writePredictionStatus.bind(storage);
  let forced = false;
  storage.writePredictionStatus = async (record: PredictionStatus) => {
    if (!forced && record.status === "UNAVAILABLE") {
      forced = true;
      // First plant a same-id different-body record
      const planted = { ...record, reason: "EVIDENCE_ONLY" as const };
      // Use underlying client path: write planted under record's id by going through real write
      // with planted — but planted has different content hash id. Force via ObjectMarketStorage
      // writeImmutable conflict by writing record twice with mutated fields under same id.
      await realWrite(record);
      // Mutate stored bytes? Simpler: throw from wrapper simulating conflict.
      throw new Error(`IMMUTABLE_RECORD_CONFLICT:${record.predictionStatusId}`);
    }
    return realWrite(record);
  };

  const provider = new CountingProvider(
    [providerRecord("issuer-1", "AAA")],
    [],
    [],
    "PROVIDER_NOT_READY:MASSIVE",
  );
  const report = await new MarketsScanner(provider, storage).run(SESSION);
  assert.equal(report.status, "PROVIDER_NOT_READY");
  assert.ok(
    report.unresolvedFailures.some((f) => f.startsWith("IMMUTABLE_PREDICTION_STATUS_CONFLICT:")),
    report.unresolvedFailures.join(","),
  );
  // Run report still written (finish always writes)
  assert.ok((await storage.loadRunReports()).some((r) => r.runId === report.runId));
});

test("content id is stable and omits predictionStatusId from the hash", () => {
  const body = {
    sessionDate: SESSION,
    status: "UNAVAILABLE" as const,
    reason: "SOURCE_COLLECTION_FAILED" as const,
    scannerVersion: "v",
    configFingerprint: "c",
    recordedAt: `${SESSION}T23:59:59.999Z`,
    sourceRunId: "scan_x",
    supersedesPredictionIds: [] as string[],
  };
  const a = predictionStatusContentId("scan_x", body);
  const b = predictionStatusContentId("scan_x", body);
  assert.equal(a, b);
  assert.match(a, /^prediction-status_scan_x_[0-9a-f]{16}$/);
  const made = makePredictionStatus("scan_x", body);
  assert.equal(made.predictionStatusId, a);
});
