import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalDailyBar, MarketProvider, ProviderSecurityRecord } from "./contracts";
import { securityId } from "./identity";
import { readScannerRoute } from "./read-api";
import { MarketsScanner } from "./scanner";
import { MarketStorage } from "./storage";

const record = (providerSecurityId: string, symbol: string): ProviderSecurityRecord => ({
  provider: "fixture-provider",
  providerSecurityId,
  symbol,
  assetType: "STOCK",
  country: "US",
  exchange: "NYSE",
  active: true,
  tradable: true,
});

function sessions(count: number, end: string): string[] {
  const last = new Date(`${end}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(last);
    date.setUTCDate(last.getUTCDate() - (count - 1 - index));
    return date.toISOString().slice(0, 10);
  });
}

function bar(id: string, date: string, close: number): CanonicalDailyBar {
  return {
    securityId: id,
    sessionDate: date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000_000,
    observedAt: `${date}T21:00:00Z`,
    ingestedAt: `${date}T22:00:00Z`,
    dataQuality: "GOOD",
    corporateActionIds: [],
    flags: [],
    schemaVersion: "foundation-d-v0",
    revision: 1,
    provenance: {
      provider: "fixture-provider",
      dataset: "daily-ohlcv",
      retrievalId: `retrieval-${date}`,
      ingestionVersion: "test",
      normalizerVersion: "test",
    },
  };
}

test("a rerun keeps one belief and the read API returns tickers", async () => {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-read-"));
  try {
    const aaa = securityId("fixture-provider", "issuer-aaa", "STOCK");
    const bbb = securityId("fixture-provider", "issuer-bbb", "STOCK");
    const dates = sessions(21, "2026-01-22");
    const bars = dates.flatMap((date, index) => [
      bar(aaa, date, 100 + index),
      bar(bbb, date, 50),
    ]);
    const provider: MarketProvider = {
      providerName: "fixture-provider",
      async listApprovedSecurities() {
        return [record("issuer-aaa", "AAA"), record("issuer-bbb", "BBB")];
      },
      async getDailyBars() {
        return bars;
      },
      async getCorporateActions() {
        return [];
      },
    };
    const storage = new MarketStorage(root);
    const scanner = new MarketsScanner(provider, storage);
    const first = await scanner.run("2026-01-22");
    const beliefs = await storage.loadBeliefs("2026-01-22");
    const predictions = await storage.loadPredictions("2026-01-22");
    await scanner.run("2026-01-22");
    assert.equal((await storage.loadBeliefs("2026-01-22")).length, beliefs.length);
    assert.equal((await storage.loadPredictions("2026-01-22")).length, predictions.length);
    assert.equal(new Set(predictions.map((item) => item.predictionId)).size, 5);
    const top = await readScannerRoute(storage, "/scanner/top15");
    const rows = top.body as Array<{ ticker: string; securityId: string; overallRank: number | null }>;
    assert.equal(top.status, 200);
    assert.ok(rows.length >= 1);
    assert.notEqual(rows[0]?.ticker, "UNKNOWN");
    assert.equal(rows[0]?.securityId.startsWith("sec_"), true);
    assert.equal(typeof rows[0]?.overallRank, "number");
    const health = await readScannerRoute(storage, "/scanner/health");
    assert.equal((health.body as { sourceCommit: string; sessionDate: string }).sessionDate, "2026-01-22");
    assert.equal(await readScannerRoute(storage, "/nope").then((result) => result.status), 404);
    assert.equal(first.status === "COMPLETE" || first.status === "COMPLETE_WITH_WARNINGS", true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
