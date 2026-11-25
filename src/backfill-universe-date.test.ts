import assert from "node:assert/strict";
import test from "node:test";
import { backfillHistoricalEvidence } from "./backfill";
import { runBackfillJob } from "./backfill-job";
import { writeDailyReplyDust } from "./daily-reply-dust";
import { FAKE_MASSIVE_BASE_URL, fakeMassive } from "./fake-massive";
import { securityId } from "./identity";
import { MassiveMarketProvider } from "./massive-provider";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { TICKER_REFERENCE_INDEX_MANIFEST_KEY } from "./ticker-reference-index";

const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";

test("backfill never stamps security-master, membership, or ticker-reference-index with a historical chunk date", async () => {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const fake = fakeMassive({
    tickers: [
      { ticker: "AAA", figi: "FIGI00000AAA", type: "CS", active: true },
      { ticker: "GONE", figi: "FIGI0000GONE", type: "CS", active: false },
    ],
    grouped: () => [{ T: "AAA", o: 10, h: 11, l: 9, c: 10.5, v: 1000 }],
  });
  const seedProvider = new MassiveMarketProvider({
    apiKey: "fake-key-not-real",
    baseUrl: FAKE_MASSIVE_BASE_URL,
    fetchImpl: fake.fetchImpl,
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    keepRawReplies: true,
    now: () => "2025-05-13T21:00:00.000Z",
  });
  await seedProvider.listApprovedSecurities();
  const bars = await seedProvider.getDailyBars("2025-05-13", [securityId("massive-stocks", "FIGI00000AAA", "STOCK")]);
  await writeDailyReplyDust(client, seedProvider.takeRawReplies()[0]!, {
    provider: seedProvider.providerName,
    observedAt: bars[0]!.observedAt,
  });

  // Run historical backfill for 2025-05-13 when current ET date is 2026-11-24.
  const report = await runBackfillJob({
    from: "2025-05-13",
    to: "2025-05-13",
    storage,
    store: client,
    fetchImpl: fake.fetchImpl,
    apiKey: "fake-key-not-real",
    baseUrl: FAKE_MASSIVE_BASE_URL,
    minRequestIntervalMs: 0,
    now: () => "2026-11-24T22:00:00.000Z", // 17:00 ET on 2026-11-24
    zstdVersionProbe: pinnedZstd,
    reopenInactiveTails: true,
  });
  assert.equal(report.status, "COMPLETE");

  const securities = await storage.loadSecurities();
  assert.equal(securities.length, 2);
  for (const s of securities) {
    assert.equal(s.firstSeenAt, "2026-11-24", "firstSeenAt must use today ET, never historical --to");
    assert.equal(s.lastUniverseSeenAt, "2026-11-24", "lastUniverseSeenAt must use today ET");
    if (s.status === "INACTIVE") assert.equal(s.inactiveAt, "2026-11-24");
  }
  const membership = await storage.loadMembership();
  assert.ok(membership.length > 0);
  assert.ok(membership.every((m) => m.effectiveDate === "2026-11-24"));

  const idxManifest = JSON.parse(new TextDecoder().decode((await client.get(TICKER_REFERENCE_INDEX_MANIFEST_KEY))!)) as {
    asOf: string;
    base: { asOf: string; key: string };
  };
  assert.equal(idxManifest.asOf, "2026-11-24");
  assert.equal(idxManifest.base.asOf, "2026-11-24");
  assert.ok(!idxManifest.base.key.includes("base-2025-05-13"));

  // Second reopen call on the same ET date with a pending session skips redundant refreshUniverse ticker requests (kills never-skip).
  const bars14 = await seedProvider.getDailyBars("2025-05-14", [securityId("massive-stocks", "FIGI00000AAA", "STOCK")]);
  await writeDailyReplyDust(client, seedProvider.takeRawReplies()[0]!, {
    provider: seedProvider.providerName,
    observedAt: bars14[0]!.observedAt,
  });
  const reqsBefore = fake.calls.tickers;
  await backfillHistoricalEvidence({
    root: "/unused",
    from: "2025-05-14",
    to: "2025-05-14",
    provider: new MassiveMarketProvider({
      apiKey: "fake-key-not-real",
      baseUrl: FAKE_MASSIVE_BASE_URL,
      fetchImpl: fake.fetchImpl,
      minRequestIntervalMs: 0,
      retryBackoffMs: 0,
      keepRawReplies: true,
    }),
    storage,
    env: {},
    replyDust: true,
    replyDustStore: client,
    zstdVersionProbe: pinnedZstd,
    reopenInactiveTails: true,
    now: () => new Date("2026-11-24T23:00:00.000Z"),
  });
  assert.equal(fake.calls.tickers, reqsBefore, "same-day reopen skips redundant refreshUniverse");
});

test("backfill ET UTC-midnight boundary and reopen refresh skip when lastUniverseSeenAt is stale", async () => {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const fake = fakeMassive({
    tickers: [{ ticker: "AAA", figi: "FIGI00000AAA", type: "CS", active: true }],
    grouped: () => [{ T: "AAA", o: 10, h: 11, l: 9, c: 10.5, v: 1000 }],
  });
  const seedProvider = new MassiveMarketProvider({
    apiKey: "fake-key-not-real",
    baseUrl: FAKE_MASSIVE_BASE_URL,
    fetchImpl: fake.fetchImpl,
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    keepRawReplies: true,
    now: () => "2025-05-13T21:00:00.000Z",
  });
  await seedProvider.listApprovedSecurities();
  const bars = await seedProvider.getDailyBars("2025-05-13", [securityId("massive-stocks", "FIGI00000AAA", "STOCK")]);
  await writeDailyReplyDust(client, seedProvider.takeRawReplies()[0]!, {
    provider: seedProvider.providerName,
    observedAt: bars[0]!.observedAt,
  });

  // Seed security-master with stale lastUniverseSeenAt (2026-11-23 < ET 2026-11-24).
  await storage.saveSecurities([
    {
      securityId: securityId("massive-stocks", "FIGI00000AAA", "STOCK"),
      currentSymbol: "AAA",
      historicalSymbols: [{ symbol: "AAA", effectiveFrom: "2024-01-02", source: "massive-stocks" }],
      assetType: "STOCK",
      country: "US",
      exchange: "XNAS",
      firstSeenAt: "2024-01-02",
      status: "ACTIVE",
      tradable: true,
      providerIdentities: [{ provider: "massive-stocks", providerSecurityId: "FIGI00000AAA" }],
      eligibility: "LEVEL_0",
      barCount: 0,
      lastUniverseSeenAt: "2026-11-23",
    },
  ]);

  const callsBefore = fake.calls.tickers;
  // 2026-11-25T00:30:00Z is 2026-11-25 in UTC, 2026-11-24 in ET!
  const report = await runBackfillJob({
    from: "2025-05-13",
    to: "2025-05-13",
    storage,
    store: client,
    fetchImpl: fake.fetchImpl,
    apiKey: "fake-key-not-real",
    baseUrl: FAKE_MASSIVE_BASE_URL,
    minRequestIntervalMs: 0,
    now: () => "2026-11-25T00:30:00.000Z",
    zstdVersionProbe: pinnedZstd,
    reopenInactiveTails: true,
  });
  assert.equal(report.status, "COMPLETE");
  assert.ok(fake.calls.tickers > callsBefore, "stale lastUniverseSeenAt must refresh universe (kills always-skip)");
  const sec = (await storage.loadSecurities())[0]!;
  assert.equal(sec.lastUniverseSeenAt, "2026-11-24", "UTC midnight boundary uses ET date 2026-11-24");

  const idxManifest = JSON.parse(new TextDecoder().decode((await client.get(TICKER_REFERENCE_INDEX_MANIFEST_KEY))!)) as {
    asOf: string;
  };
  assert.equal(idxManifest.asOf, "2026-11-24", "index asOf uses ET date 2026-11-24");
});

test("reopen failedSessions and stoppedOnError ignore stale failures outside [from, to]", async () => {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const fake = fakeMassive({
    tickers: [{ ticker: "AAA", figi: "FIGI00000AAA", type: "CS", active: true }],
    grouped: () => [{ T: "AAA", o: 10, h: 11, l: 9, c: 10.5, v: 1000 }],
  });
  const seedProvider = new MassiveMarketProvider({
    apiKey: "fake-key-not-real",
    baseUrl: FAKE_MASSIVE_BASE_URL,
    fetchImpl: fake.fetchImpl,
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    keepRawReplies: true,
    now: () => "2025-05-13T21:00:00.000Z",
  });
  await seedProvider.listApprovedSecurities();
  const bars = await seedProvider.getDailyBars("2025-05-13", [securityId("massive-stocks", "FIGI00000AAA", "STOCK")]);
  await writeDailyReplyDust(client, seedProvider.takeRawReplies()[0]!, {
    provider: seedProvider.providerName,
    observedAt: bars[0]!.observedAt,
  });

  await storage.saveBackfillReopenProgress({
    schemaVersion: "markets-scanner-backfill-reopen-v1",
    provider: "massive-stocks",
    completedSessions: [],
    failedSessions: { "2024-10-07": "MASSIVE_HTTP_403:plan_window" },
    updatedAt: "2026-11-24T22:00:00.000Z",
  });

  // Case A: 2025-05-13 succeeds -> stale 2024-10-07 must not leak into report.failedSessions
  const okReport = await runBackfillJob({
    from: "2025-05-13",
    to: "2025-05-13",
    storage,
    store: client,
    fetchImpl: fake.fetchImpl,
    apiKey: "fake-key-not-real",
    baseUrl: FAKE_MASSIVE_BASE_URL,
    minRequestIntervalMs: 0,
    now: () => "2026-11-24T22:30:00.000Z",
    zstdVersionProbe: pinnedZstd,
    reopenInactiveTails: true,
  });
  assert.equal(okReport.status, "COMPLETE");
  assert.deepEqual(okReport.failedSessions, {});

  // Case B: 2025-05-14 fails with HTTP 500 -> stale 2024-10-07 403 must not mask stopReason as PLAN_WINDOW_403
  const failFake = fakeMassive({
    tickers: [{ ticker: "AAA", figi: "FIGI00000AAA", type: "CS", active: true }],
    grouped: () => [],
    onRequest: (url) => {
      if (url.pathname.includes("/grouped/")) return new Response("boom", { status: 500 });
      return undefined;
    },
  });
  const failReport = await runBackfillJob({
    from: "2025-05-14",
    to: "2025-05-14",
    storage,
    store: client,
    fetchImpl: failFake.fetchImpl,
    apiKey: "fake-key-not-real",
    baseUrl: FAKE_MASSIVE_BASE_URL,
    minRequestIntervalMs: 0,
    now: () => "2026-11-24T22:35:00.000Z",
    zstdVersionProbe: pinnedZstd,
    reopenInactiveTails: true,
  });
  assert.equal(failReport.status, "STOPPED_RESUMABLE");
  assert.equal(failReport.stopReason, "SESSION_FAILED");
  assert.deepEqual(Object.keys(failReport.failedSessions), ["2025-05-14"]);

  // Checkpoint on disk still retains 2024-10-07 alongside 2025-05-14
  const saved = (await storage.loadBackfillReopenProgress()) as { failedSessions: Record<string, string> };
  assert.equal(typeof saved.failedSessions["2024-10-07"], "string");
  assert.equal(typeof saved.failedSessions["2025-05-14"], "string");
});
