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

test("appendBars is a no-op when 0 new bar keys exist, preserves existing lines byte-for-byte, and refuses SHA/ETag drift", async () => {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const idA = securityId("fixture-provider", "issuer-1", "STOCK");
  const idB = securityId("fixture-provider", "issuer-2", "STOCK");
  const key = "permanent/daily-bars/2026-01.jsonl";
  // Seed an existing line with custom key spacing to prove existing lines stay byte-for-byte untouched.
  const rawExisting = JSON.stringify(bar(idA, "2026-01-22", 100)).replace(":", ": ");
  await client.put(key, new TextEncoder().encode(rawExisting + "\n"));
  const beforeNoop = await client.getWithEtag(key);
  let putCount = 0;
  let putIfMatchCount = 0;
  const origPut = client.put.bind(client);
  const origPutIfMatch = client.putIfMatch.bind(client);
  client.put = async (k, b, m) => { putCount += 1; return origPut(k, b, m); };
  client.putIfMatch = async (k, b, e) => { putIfMatchCount += 1; return origPutIfMatch(k, b, e); };
  // Duplicate key: 0 new bar keys => 0 writes and unchanged ETag.
  await storage.appendBars([bar(idA, "2026-01-22", 999)]);
  assert.equal(putCount, 0);
  assert.equal(putIfMatchCount, 0);
  assert.equal((await client.getWithEtag(key))?.etag, beforeNoop?.etag);
  // Adding a new key uses putIfMatch (1 write) and preserves the existing raw line verbatim.
  await storage.appendBars([bar(idB, "2026-01-22", 50)]);
  assert.equal(putIfMatchCount, 1);
  assert.equal(putCount, 1); // MemoryObjectClient.putIfMatch delegates to this.put
  const afterAdd = new TextDecoder().decode((await client.get(key))!).split("\n").filter(Boolean);
  assert.equal(afterAdd.length, 2);
  assert.ok(afterAdd.includes(rawExisting), "existing raw line preserved byte-for-byte");
  // Simulate concurrent SHA/ETag drift between read and write (putIfMatch path).
  const idC = securityId("fixture-provider", "issuer-3", "STOCK");
  const origGetWithEtag = client.getWithEtag.bind(client);
  client.getWithEtag = async (k) => {
    const res = await origGetWithEtag(k);
    if (k === key && res) {
      await origPut(key, new TextEncoder().encode(new TextDecoder().decode(res.body) + "{\"securityId\":\"concurrent\",\"sessionDate\":\"2026-01-22\",\"revision\":1}\n"));
    }
    return res;
  };
  await assert.rejects(() => storage.appendBars([bar(idC, "2026-01-22", 60)]), /DAILY_BARS_MONTH_SHA_DRIFT/);
  // Fallback client without getWithEtag/putIfMatch still checks SHA before put.
  const noEtagClient = new MemoryObjectClient();
  await noEtagClient.put(key, new TextEncoder().encode(rawExisting + "\n"));
  const origNoEtagGet = noEtagClient.get.bind(noEtagClient);
  const origNoEtagPut = noEtagClient.put.bind(noEtagClient);
  let reads = 0;
  const fallbackClient = {
    get: async (k: string) => {
      const res = await origNoEtagGet(k);
      reads += 1;
      if (k === key && res && reads === 1) {
        await origNoEtagPut(key, new TextEncoder().encode(new TextDecoder().decode(res) + "{\"securityId\":\"drift\",\"sessionDate\":\"2026-01-22\",\"revision\":1}\n"));
      }
      return res;
    },
    put: origNoEtagPut,
    head: noEtagClient.head.bind(noEtagClient),
    delete: noEtagClient.delete.bind(noEtagClient),
    list: noEtagClient.list.bind(noEtagClient),
  };
  await assert.rejects(() => new ObjectMarketStorage(fallbackClient).appendBars([bar(idC, "2026-01-22", 60)]), /DAILY_BARS_MONTH_SHA_DRIFT/);
});
