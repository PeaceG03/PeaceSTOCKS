// A stored pack or immutable record that already matches is a no-op; a real difference stays an error.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalDailyBar, PredictionSet, PredictionStatus } from "./contracts";
import {
  dailyBarsSidecarFileKey,
  dailyBarsSidecarManifestKey,
  maybeWriteScanDailyBarsSidecar,
  writeDailyBarsSidecar,
} from "./daily-bars-sidecar";
import { MemoryObjectClient, type ObjectMetadata } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { MarketStorage } from "./storage";

const DAY = "2026-01-20";
const AT = "2026-01-20T23:00:00.000Z";
const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";

class CountingClient extends MemoryObjectClient {
  puts: string[] = [];
  override async put(key: string, body: Uint8Array, metadata: ObjectMetadata = {}): Promise<void> {
    this.puts.push(key);
    return super.put(key, body, metadata);
  }
}

function bar(securityId: string, close: number, stamp = AT, retrievalId = "r1"): CanonicalDailyBar {
  return {
    securityId, sessionDate: DAY, open: 1, high: 2, low: 0.5, close, volume: 10,
    observedAt: stamp, ingestedAt: stamp, dataQuality: "GOOD", corporateActionIds: [], flags: [],
    schemaVersion: "x", revision: 1,
    provenance: { provider: "massive-stocks", dataset: "stocks-grouped-daily", retrievalId, ingestionVersion: "v", normalizerVersion: "n" },
  } as unknown as CanonicalDailyBar;
}
const rows = () => [bar("sec_a", 1.5), bar("sec_b", 3)];

test("pack: same rows again is exists-same, nothing written", async () => {
  const store = new CountingClient();
  assert.equal((await writeDailyBarsSidecar({ store, sessionDate: DAY, rows: rows(), dust: null })).status, "stored");
  store.puts = [];
  const report = await maybeWriteScanDailyBarsSidecar({ enabled: true, store, sessionDate: DAY, bars: rows(), securities: [], zstdVersionProbe: pinnedZstd });
  assert.equal(report.status, "exists-same");
  assert.equal(report.failure, undefined);
  assert.deepEqual(store.puts, []);
});

test("pack: same market content, different ingestion stamps => no-op with a warning, not a failure", async () => {
  const store = new CountingClient();
  await writeDailyBarsSidecar({ store, sessionDate: DAY, rows: rows(), dust: null });
  const before = await store.get(dailyBarsSidecarFileKey(DAY));
  store.puts = [];
  const later = [bar("sec_a", 1.5, "2026-01-21T05:00:00.000Z", "r2"), bar("sec_b", 3, "2026-01-21T05:00:00.000Z", "r2")];
  const report = await maybeWriteScanDailyBarsSidecar({ enabled: true, store, sessionDate: DAY, bars: later, securities: [], zstdVersionProbe: pinnedZstd });
  assert.equal(report.status, "exists-equivalent");
  assert.equal(report.failure, undefined);
  assert.deepEqual(report.warnings, [`DAILY_BARS_PACK_EXISTS_EQUIVALENT:${DAY}`]);
  assert.deepEqual(store.puts, []);
  assert.deepEqual(await store.get(dailyBarsSidecarFileKey(DAY)), before);
});

test("pack: byte-identical file left without a manifest is sealed, not an error", async () => {
  const store = new CountingClient();
  await writeDailyBarsSidecar({ store, sessionDate: DAY, rows: rows(), dust: null });
  const manifest = await store.get(dailyBarsSidecarManifestKey(DAY));
  await store.delete(dailyBarsSidecarManifestKey(DAY)); // interrupted between file and manifest
  store.puts = [];
  const result = await writeDailyBarsSidecar({ store, sessionDate: DAY, rows: rows(), dust: null });
  assert.equal(result.status, "stored");
  assert.deepEqual(store.puts, [dailyBarsSidecarManifestKey(DAY)]); // file never rewritten
  assert.deepEqual(await store.get(dailyBarsSidecarManifestKey(DAY)), manifest);
});

test("pack: a real difference is still DAILY_BARS_PACK_EXISTS_DIFFERENT, file kept", async () => {
  const store = new CountingClient();
  await writeDailyBarsSidecar({ store, sessionDate: DAY, rows: rows(), dust: null });
  const changed = [bar("sec_a", 1.5), bar("sec_b", 3.01)];
  const report = await maybeWriteScanDailyBarsSidecar({ enabled: true, store, sessionDate: DAY, bars: changed, securities: [], zstdVersionProbe: pinnedZstd });
  assert.equal(report.failure, `DAILY_BARS_PACK_EXISTS_DIFFERENT:${DAY}`);
  const extra = await maybeWriteScanDailyBarsSidecar({ enabled: true, store, sessionDate: DAY, bars: [...rows(), bar("sec_c", 9)], securities: [], zstdVersionProbe: pinnedZstd });
  assert.equal(extra.failure, `DAILY_BARS_PACK_EXISTS_DIFFERENT:${DAY}`);
  // A file without a manifest that differs is never overwritten either.
  await store.delete(dailyBarsSidecarManifestKey(DAY));
  store.puts = [];
  assert.equal((await writeDailyBarsSidecar({ store, sessionDate: DAY, rows: changed, dust: null })).status, "exists-different");
  assert.deepEqual(store.puts, []);
});

const status = (extra: Partial<PredictionStatus> = {}): PredictionStatus => ({
  predictionStatusId: "prediction-status_run_1", sessionDate: DAY, status: "UNAVAILABLE", reason: "EVIDENCE_ONLY",
  scannerVersion: "s", configFingerprint: "c", recordedAt: AT, supersedesPredictionIds: [], ...extra,
});
const prediction = (ids: string[]): PredictionSet => ({
  predictionId: "prediction_1", sessionDate: DAY, setType: "TOP_15_OVERALL", securityIds: ids,
  scannerVersion: "s", configFingerprint: "c", frozenAt: AT,
});

test("immutable records (object store): identical rewrite is a no-op, real difference throws", async () => {
  const client = new CountingClient();
  const storage = new ObjectMarketStorage(client);
  await storage.writePredictionStatus(status());
  await storage.writePredictions([prediction(["sec_a", "sec_b"])]);
  client.puts = [];
  // Same content; an optional field present as undefined is the same record once stored.
  await storage.writePredictionStatus(status({ attemptedAt: undefined, sourceRunId: undefined } as unknown as Partial<PredictionStatus>));
  await storage.writePredictions([prediction(["sec_a", "sec_b"])]);
  assert.deepEqual(client.puts, [], "nothing rewritten");
  await assert.rejects(storage.writePredictionStatus(status({ reason: "SOURCE_COLLECTION_FAILED" })), /^Error: IMMUTABLE_RECORD_CONFLICT:prediction-status_run_1$/u);
  await assert.rejects(storage.writePredictions([prediction(["sec_b", "sec_a"])]), /IMMUTABLE_RECORD_CONFLICT:prediction_1/u);
  assert.deepEqual(client.puts, []);
});

test("immutable records (file store): identical rewrite is a no-op, real difference throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ps-noop-"));
  try {
    const storage = new MarketStorage(dir);
    await storage.initialize();
    await storage.writePredictionStatus(status());
    const file = join(dir, "permanent", "prediction-status", `${DAY}.jsonl`);
    const before = await stat(file);
    await storage.writePredictionStatus(status({ attemptedAt: undefined } as unknown as Partial<PredictionStatus>));
    const after = await stat(file);
    assert.equal(after.ino, before.ino, "file not replaced");
    assert.equal(after.mtimeMs, before.mtimeMs);
    await assert.rejects(storage.writePredictionStatus(status({ reason: "SOURCE_COLLECTION_FAILED" })), /IMMUTABLE_RECORD_CONFLICT/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
