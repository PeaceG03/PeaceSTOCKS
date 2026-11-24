import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalDailyBar, PredictionStatus, ScannerRunReport } from "./contracts";
import { buildScanHealth, SCAN_HEALTH_LATEST_KEY, scanHealthKey, type ScanHealthRecord } from "./scan-health";

const OPEN = "2026-10-05T13:30:00.000Z"; // Mon 09:30 New York (EDT)
function report(patch: { [K in keyof ScannerRunReport]?: ScannerRunReport[K] | undefined } = {}): ScannerRunReport {
  return {
    runId: "scan_x",
    session: { sessionDate: "2026-10-02", kind: "NORMAL", market: "US_EQUITIES", source: "t" },
    status: "COMPLETE",
    expectedSecurities: 10,
    processedSecurities: 9,
    validSecurities: 9,
    incompleteSecurities: 0,
    unresolvedFailures: [],
    scannerVersion: "v",
    sourceCommit: "c",
    completedAt: "2026-10-03T05:40:00.000Z",
    storage: {} as never,
    predictionStatus: "FROZEN",
    predictionReason: "PREDICTIONS_FROZEN",
    predictedAt: "2026-10-03T05:39:00.000Z",
    nextSessionDate: "2026-10-05",
    nextSessionOpen: OPEN,
    ...patch,
  } as ScannerRunReport;
}

test("health record: before-open flag is strict (finishing at the open is late), freeze on time needs FROZEN before the open", () => {
  const ok = buildScanHealth(report());
  assert.equal(ok.finishedBeforeOpen, true);
  assert.equal(ok.frozenOnTime, true);
  assert.equal(ok.freezeStatus, "FROZEN");
  assert.equal(ok.namesExpected, 10);
  assert.equal(ok.namesCovered, 9);
  assert.equal(buildScanHealth(report({ completedAt: "2026-10-05T13:29:59.999Z" })).finishedBeforeOpen, true);
  assert.equal(buildScanHealth(report({ completedAt: OPEN })).finishedBeforeOpen, false);
  assert.equal(buildScanHealth(report({ completedAt: "2026-10-05T15:00:00.000Z" })).finishedBeforeOpen, false);
  // A late freeze decision and an unavailable one are not "on time", whatever the finish time.
  assert.equal(buildScanHealth(report({ predictedAt: OPEN })).frozenOnTime, false);
  const late = buildScanHealth(report({ predictionStatus: "UNAVAILABLE", predictionReason: "FREEZE_AFTER_OPEN", completedAt: "2026-10-05T14:00:00.000Z" }));
  assert.deepEqual([late.freezeStatus, late.freezeReason, late.frozenOnTime, late.finishedBeforeOpen], ["UNAVAILABLE", "FREEZE_AFTER_OPEN", false, false]);
  const none = buildScanHealth(report({ predictionStatus: undefined, predictionReason: undefined, predictedAt: undefined }));
  assert.deepEqual([none.freezeStatus, none.frozenOnTime], ["NO_DECISION", false]);
  // No open in the report: the caller's next open is used; none at all gives null, never "true".
  const bare = report({ nextSessionOpen: undefined, nextSessionDate: undefined });
  assert.equal(buildScanHealth(bare).finishedBeforeOpen, null);
  assert.equal(buildScanHealth(bare).frozenOnTime, false);
  assert.equal(buildScanHealth(bare, { nextSessionDate: "2026-10-05", nextSessionOpen: OPEN }).finishedBeforeOpen, true);
});

test("health record: floor and split-guard exclusions counted by reason with totals", () => {
  const r = buildScanHealth(
    report({
      eligibilityFloorExcludedByReason: { FLOOR_PRICE: 3, FLOOR_DOLLAR_VOLUME: 5, FLOOR_HISTORY: 1 },
      splitGuardExcludedByReason: { SPLIT_UNRECONCILED: 2 },
    }),
  );
  assert.deepEqual(r.eligibilityFloorExcluded, { total: 9, byReason: { FLOOR_DOLLAR_VOLUME: 5, FLOOR_HISTORY: 1, FLOOR_PRICE: 3 } });
  assert.deepEqual(r.splitGuardExcluded, { total: 2, byReason: { SPLIT_UNRECONCILED: 2 } });
  assert.deepEqual(buildScanHealth(report()).eligibilityFloorExcluded, { total: 0, byReason: {} });
  assert.equal(scanHealthKey("2026-10-02"), "permanent/health/scan/2026-10-02.json");
  assert.throws(() => scanHealthKey("../x"), /SCAN_HEALTH_BAD_SESSION_DATE/u);
});

// --- Scanner integration: the record each forward scan writes ---
function days(n: number, last: string): string[] {
  const out: string[] = [];
  for (const d = new Date(`${last}T00:00:00Z`); out.length < n; d.setUTCDate(d.getUTCDate() - 1))
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
  return out;
}

async function scanWorld(clock: string, mode: "FORWARD" | "EVIDENCE_ONLY" = "FORWARD", withSplitLike = false) {
  const { MarketsScanner } = await import("./scanner");
  const { ObjectMarketStorage } = await import("./object-storage");
  const { MemoryObjectClient } = await import("./object-store");
  const { securityId } = await import("./identity");
  const D = "2026-10-02";
  const hist = days(70, D);
  const record = (id: string, symbol: string) =>
    ({ provider: "fixture-provider", providerSecurityId: id, symbol, assetType: "STOCK", country: "US", exchange: "NYSE", active: true, tradable: true });
  const ids = ["i-a", "i-b", "i-t", "i-s"].map((p) => securityId("fixture-provider", p, "STOCK"));
  const mk = (id: string, d: string, close: number, volume: number) =>
    ({ securityId: id, sessionDate: d, open: close, high: close, low: close, close, volume, revision: 1, observedAt: "t", provenance: { provider: "fixture-provider", dataset: "daily-ohlcv", retrievalId: `r-${d}-${id.slice(0, 6)}`, ingestionVersion: "t", normalizerVersion: "t" } }) as unknown as CanonicalDailyBar;
  const allBars = hist.flatMap((d, k) => [mk(ids[0]!, d, 20 + k * 0.01, 1_000_000), mk(ids[1]!, d, 25 - k * 0.01, 1_000_000), mk(ids[2]!, d, 30, 1_000), ...(withSplitLike ? [mk(ids[3]!, d, k < 65 ? 20 : 40, 1_000_000)] : [])]);
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  await storage.initialize();
  await storage.appendBars(allBars.filter((b) => b.sessionDate < D));
  const provider = {
    providerName: "fixture-provider",
    listApprovedSecurities: async () => [record("i-a", "AAA"), record("i-b", "BBB"), record("i-t", "TTT"), ...(withSplitLike ? [record("i-s", "SSS")] : [])],
    getDailyBars: async (day: string, want: string[]) => allBars.filter((b) => b.sessionDate === day && want.includes(b.securityId)),
    getCorporateActions: async () => [],
  };
  const scanner = new MarketsScanner(provider as never, storage, undefined, undefined, () => new Date(clock));
  const report = await scanner.run(D, mode);
  const read = async (key: string) => {
    const bytes = await client.get(key);
    return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as ScanHealthRecord) : undefined;
  };
  return { D, report, client, storage, scanner, read };
}

test("scan writes the health record: before the open, frozen, names covered, floor and split counts (with read-back metadata)", async () => {
  const w = await scanWorld("2026-10-03T05:40:00.000Z");
  assert.equal(w.report.scanHealth, "WRITTEN");
  const rec = await w.read(scanHealthKey(w.D));
  assert.ok(rec);
  assert.deepEqual(await w.read(SCAN_HEALTH_LATEST_KEY), rec);
  assert.equal(rec.schemaVersion, "scan-health-v1");
  assert.equal(rec.finishedBeforeOpen, true);
  assert.equal(rec.freezeStatus, "FROZEN");
  assert.equal(rec.frozenOnTime, true);
  assert.equal(rec.nextSessionOpen, OPEN);
  assert.equal(rec.namesExpected, 3);
  assert.equal(rec.namesCovered, 3);
  assert.deepEqual(rec.eligibilityFloorExcluded, { total: 1, byReason: { FLOOR_DOLLAR_VOLUME: 1 } });
  assert.deepEqual(rec.splitGuardExcluded, { total: 0, byReason: {} });
  const head = await w.client.head(scanHealthKey(w.D));
  assert.ok(head && Object.keys(head.metadata).length > 0, "checksum metadata for the read-back check");
  // A second run for the frozen session is the ALREADY_FROZEN no-op: it must not replace the record.
  const again = await w.scanner.run(w.D, "FORWARD");
  assert.equal(again.status, "ALREADY_FROZEN");
  assert.equal(again.scanHealth, undefined);
  assert.deepEqual(await w.read(scanHealthKey(w.D)), rec);
});

test("scan health record counts the split guard's exclusions by reason (a 2x jump with no split record)", async () => {
  const w = await scanWorld("2026-10-03T05:40:00.000Z", "FORWARD", true);
  const rec = await w.read(scanHealthKey(w.D));
  assert.ok(rec);
  assert.equal(rec.namesCovered, 4);
  assert.deepEqual(rec.splitGuardExcluded, { total: 1, byReason: { SPLIT_LIKE_MOVE_UNRECORDED: 1 } });
  assert.deepEqual(rec.eligibilityFloorExcluded, { total: 1, byReason: { FLOOR_DOLLAR_VOLUME: 1 } });
});

test("scan after the open: the record says not before the open and not frozen on time", async () => {
  const w = await scanWorld("2026-10-05T14:00:00.000Z");
  const rec = await w.read(scanHealthKey(w.D));
  assert.ok(rec);
  assert.equal(rec.finishedBeforeOpen, false);
  assert.equal(rec.freezeStatus, "UNAVAILABLE");
  assert.equal(rec.freezeReason, "FREEZE_AFTER_OPEN");
  assert.equal(rec.frozenOnTime, false);
});

test("evidence-only backfill scans write no nightly health record", async () => {
  const w = await scanWorld("2026-10-03T05:40:00.000Z", "EVIDENCE_ONLY");
  assert.equal(w.report.scanHealth, undefined);
  assert.equal(await w.read(scanHealthKey(w.D)), undefined);
  assert.equal(await w.read(SCAN_HEALTH_LATEST_KEY), undefined);
});

test("a failed health write never fails the scan", async () => {
  const { ObjectMarketStorage } = await import("./object-storage");
  const original = ObjectMarketStorage.prototype.writeScanHealth;
  ObjectMarketStorage.prototype.writeScanHealth = async () => {
    throw new Error("R2_PUT_500");
  };
  try {
    const w = await scanWorld("2026-10-03T05:40:00.000Z");
    assert.equal(w.report.predictionStatus, "FROZEN");
    assert.equal(w.report.scanHealth, "FAILED:R2_PUT_500");
  } finally {
    ObjectMarketStorage.prototype.writeScanHealth = original;
  }
});

export type { PredictionStatus };
