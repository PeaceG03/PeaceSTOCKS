import assert from "node:assert/strict";
import test from "node:test";
import { DUST_SCHEMA_VERSION } from "./contracts";
import { securityId } from "./identity";
import type { CanonicalDailyBar, ProviderSecurityRecord } from "./contracts";
import { MemoryObjectClient, R2ObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { MarketsScanner } from "./scanner";

const record = (providerSecurityId: string, symbol: string, assetType: "STOCK" | "ETF" = "STOCK"): ProviderSecurityRecord => ({
  provider: "fixture-provider",
  providerSecurityId,
  symbol,
  assetType,
  country: "US",
  exchange: "NYSE",
  active: true,
  tradable: true,
});

function bar(securityIdValue: string, date: string, close: number): CanonicalDailyBar {
  return {
    securityId: securityIdValue,
    sessionDate: date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
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

test("object store keeps evidence, the scheduler cursor, and the source commit", async () => {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const id = securityId("fixture-provider", "issuer-1", "STOCK");
  const previous = process.env.PEACESTOCKS_SOURCE_COMMIT;
  process.env.PEACESTOCKS_SOURCE_COMMIT = "abc123";
  try {
    const provider = {
      providerName: "fixture-provider",
      async listApprovedSecurities() {
        return [record("issuer-1", "AAA")];
      },
      async getDailyBars() {
        return [bar(id, "2026-01-22", 100)];
      },
      async getCorporateActions() {
        return [];
      },
    };
    const report = await new MarketsScanner(provider, storage).run("2026-01-22");
    assert.equal(report.sourceCommit, "abc123");
    await storage.appendBars([bar(id, "2026-01-22", 100)]);
    assert.equal((await storage.loadBars()).length, 1);
    await storage.saveSchedulerState({
      schemaVersion: "peaceai-markets-scheduler-host:v1",
      forwardClockStartedAt: "2026-01-22T21:45:00.000Z",
      lastObservedSessionDate: "2026-01-21",
    });
    const state = (await storage.loadSchedulerState()) as { lastObservedSessionDate: string };
    assert.equal(state.lastObservedSessionDate, "2026-01-21");
    const stored = JSON.parse(new TextDecoder().decode((await client.get(`runs/${report.runId}.json`))!));
    assert.equal(stored.sourceCommit, "abc123");
  } finally {
    if (previous === undefined) delete process.env.PEACESTOCKS_SOURCE_COMMIT;
    else process.env.PEACESTOCKS_SOURCE_COMMIT = previous;
  }
});

test("pending archive bytes stay until a durable ack", async () => {
  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  const body = new TextEncoder().encode("sealed-evidence");
  const pending = await storage.putPendingArchive("session-2026-01-22", body);
  assert.equal(pending.format, "opaque-pending-evidence");
  assert.equal(pending.acked, false);
  assert.notEqual(pending.format, DUST_SCHEMA_VERSION);
  await assert.rejects(() => storage.purgePendingArchive(pending.objectId), /PENDING_ARCHIVE_NOT_ACKED/);
  assert.equal((await storage.readPendingArchive(pending.objectId))?.byteLength, body.byteLength);
  await storage.ackPendingArchive(pending.objectId);
  await storage.purgePendingArchive(pending.objectId);
  assert.equal(await storage.readPendingArchive(pending.objectId), undefined);
});

test("R2 client signs requests for the configured bucket and does not use dust-v1", async () => {
  assert.equal(DUST_SCHEMA_VERSION, "dust-v1");
  let captured: Request | undefined;
  const client = new R2ObjectClient({
    accountId: "account",
    bucket: "peacestocks",
    accessKeyId: "key",
    secretAccessKey: "secret",
    now: () => new Date("2026-01-22T00:00:00.000Z"),
    fetchImpl: async (input, init) => {
      captured = new Request(input, init);
      return new Response(null, { status: 200 });
    },
  });
  await client.put("permanent/security-master.json", new TextEncoder().encode("{}"));
  assert.equal(captured?.url, "https://account.r2.cloudflarestorage.com/peacestocks/permanent/security-master.json");
  assert.match(captured?.headers.get("authorization") ?? "", /AWS4-HMAC-SHA256/);
  assert.equal(captured?.method, "PUT");
});

test("appendBars only touches the months being written", async () => {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const id = securityId("fixture-provider", "issuer-1", "STOCK");
  await storage.appendBars([bar(id, "2026-01-22", 100)]);
  await storage.appendBars([bar(id, "2026-02-02", 101)]);
  const keys = await client.list("permanent/daily-bars/");
  assert.deepEqual(keys, ["permanent/daily-bars/2026-01.jsonl", "permanent/daily-bars/2026-02.jsonl"]);
  await storage.appendBars([bar(id, "2026-02-03", 102)]);
  assert.equal((await storage.loadBars("2026-02-02")).length, 1);
  assert.equal((await storage.loadBars("2026-02-03")).length, 1);
  assert.equal((await storage.loadBars("2026-01-22")).length, 1);
});
