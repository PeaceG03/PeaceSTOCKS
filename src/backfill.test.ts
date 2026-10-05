import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalDailyBar, MarketProvider, ProviderSecurityRecord } from "./contracts";
import { backfillHistoricalEvidence } from "./backfill";
import { securityId } from "./identity";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";

const providerName = "fixture-provider";

function record(providerSecurityId: string, symbol: string, assetType: "STOCK" | "ETF" = "STOCK"): ProviderSecurityRecord {
  return {
    provider: providerName,
    providerSecurityId,
    symbol,
    assetType,
    country: "US",
    exchange: "NYSE",
    active: true,
    tradable: true,
  };
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
      provider: providerName,
      dataset: "daily-ohlcv",
      retrievalId: `retrieval-${date}`,
      ingestionVersion: "test",
      normalizerVersion: "test",
    },
  };
}

function makeProvider(calls: { sessions: string[] }): MarketProvider {
  const aaa = securityId(providerName, "issuer-aaa", "STOCK");
  const spy = securityId(providerName, "spy", "ETF");
  return {
    providerName,
    async listApprovedSecurities() {
      return [record("issuer-aaa", "AAA"), record("spy", "SPY", "ETF")];
    },
    async getDailyBars(sessionDate: string) {
      calls.sessions.push(sessionDate);
      return [bar(aaa, sessionDate, 100), bar(spy, sessionDate, 400)];
    },
    async getCorporateActions() {
      return [];
    },
  };
}

test("backfill writes through the object store and resumes progress", async () => {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const calls = { sessions: [] as string[] };
  const provider = makeProvider(calls);
  const first = await backfillHistoricalEvidence({
    root: "/unused",
    from: "2026-01-20",
    to: "2026-01-22",
    provider,
    storage,
    env: {},
  });
  assert.deepEqual(first.completedSessions, ["2026-01-20", "2026-01-21", "2026-01-22"]);
  assert.equal(first.stoppedOnError, false);
  assert.equal((await storage.loadBars()).length >= 6, true);
  assert.ok(await client.get("backfill-state.json"));
  const beforeKeys = await client.list("");
  const beforeBars = (await storage.loadBars()).length;
  calls.sessions.length = 0;
  const second = await backfillHistoricalEvidence({
    root: "/unused",
    from: "2026-01-20",
    to: "2026-01-22",
    provider,
    storage,
    env: {},
  });
  assert.deepEqual(second.skippedExistingSessions, ["2026-01-20", "2026-01-21", "2026-01-22"]);
  assert.deepEqual(calls.sessions, []);
  assert.equal((await storage.loadBars()).length, beforeBars);
  assert.deepEqual(await client.list(""), beforeKeys);
  const eligibility = first.eligibility;
  assert.equal((eligibility.LEVEL_1 ?? 0) + (eligibility.LEVEL_0 ?? 0) >= 1, true);
});

test("backfill refuses to start without the object store when required", async () => {
  await assert.rejects(
    () =>
      backfillHistoricalEvidence({
        root: "/tmp/unused-backfill",
        from: "2026-01-20",
        to: "2026-01-22",
        env: { PEACESTOCKS_REQUIRE_OBJECT_STORE: "1" },
        provider: makeProvider({ sessions: [] }),
      }),
    /OBJECT_STORE_REQUIRED/,
  );
});

test("backfill stops on provider-not-ready without marking the session complete", async () => {
  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  let listed = false;
  const provider: MarketProvider = {
    providerName,
    async listApprovedSecurities() {
      listed = true;
      return [record("issuer-aaa", "AAA")];
    },
    async getDailyBars() {
      throw new Error("PROVIDER_NOT_READY:before end of day");
    },
    async getCorporateActions() {
      return [];
    },
  };
  const result = await backfillHistoricalEvidence({
    root: "/unused",
    from: "2026-01-22",
    to: "2026-01-22",
    provider,
    storage,
    env: {},
  });
  assert.equal(listed, true);
  assert.equal(result.stoppedOnError, true);
  assert.deepEqual(result.completedSessions, []);
  assert.match(result.failedSessions["2026-01-22"] ?? "", /PROVIDER_NOT_READY/);
  const progress = (await storage.loadBackfillProgress()) as { completedSessions: string[] };
  assert.deepEqual(progress.completedSessions, []);
});
