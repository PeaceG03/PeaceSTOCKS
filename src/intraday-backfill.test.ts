import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  CanonicalDailyBar,
  CorporateAction,
  MarketProvider,
  SecurityMasterRecord,
} from "./contracts";
import { backfillHistoricalIntradayEvidence } from "./intraday-backfill";
import { normalizeMassiveTenMinuteBars } from "./intraday";
import { DustReader } from "./reader";
import { MarketStorage } from "./storage";

const security: SecurityMasterRecord = {
  securityId: "security-1",
  currentSymbol: "AAA",
  historicalSymbols: [],
  assetType: "STOCK",
  country: "US",
  exchange: "NYSE",
  firstSeenAt: "2025-01-01T00:00:00.000Z",
  status: "ACTIVE",
  tradable: true,
  providerIdentities: [{ provider: "fixture", providerSecurityId: "AAA" }],
  eligibility: "LEVEL_0",
  barCount: 0,
  lastUniverseSeenAt: "2026-01-02",
};

function fixtureProvider(): MarketProvider {
  return {
    providerName: "fixture",
    listApprovedSecurities: async () => [],
    getDailyBars: async (): Promise<CanonicalDailyBar[]> => [],
    getCorporateActions: async (): Promise<CorporateAction[]> => [],
    getIntradayBars: async (sessionDate, securityIds) =>
      securityIds.flatMap((securityId) =>
        normalizeMassiveTenMinuteBars({
          sessionDate,
          securityId,
          symbol: "AAA",
          aggregates: [
            {
              symbol: "AAA",
              timestamp: Date.parse(`${sessionDate}T14:30:00.000Z`),
              open: 99,
              high: 101,
              low: 98,
              close: 100,
              volume: 10,
            },
          ],
          observedAt: `${sessionDate}T21:00:00.000Z`,
          provenance: {
            provider: "fixture",
            dataset: "fixture-10m",
            retrievalId: `fixture-${sessionDate}`,
            ingestionVersion: "test-v1",
            normalizerVersion: "fixture-v1",
          },
        }),
      ),
  };
}

test("intraday backfill is resumable, idempotent, and seals only validated Dust", async () => {
  const root = await mkdtemp(join(tmpdir(), "peaceai-intraday-backfill-"));
  try {
    const storage = new MarketStorage(root);
    await storage.initialize();
    await storage.saveSecurities([security]);
    const provider = fixtureProvider();
    const first = await backfillHistoricalIntradayEvidence({
      root,
      from: "2026-01-02",
      to: "2026-01-02",
      provider,
    });
    assert.deepEqual(first.completedSessions, ["2026-01-02"]);
    assert.equal(first.sealedArchives, 1);
    assert.equal(first.stoppedOnError, false);
    assert.equal(
      (await new DustReader(root).manifest("2026-01-02")).validation,
      "SEALED_CANONICAL",
    );
    await assert.rejects(readFile(join(root, "transient", "validation", "2026-01-02.jsonl")));
    const second = await backfillHistoricalIntradayEvidence({
      root,
      from: "2026-01-02",
      to: "2026-01-02",
      provider,
    });
    assert.deepEqual(second.skippedExistingSessions, ["2026-01-02"]);
    assert.equal(second.sealedArchives, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
