// A session whose daily-bars pack is already sealed is checked BEFORE any session write:
// - the stored pack verifies against the stored rows => nothing is collected or appended again
//   (no Massive request, no bars/actions/membership/coverage/ticker-index write), the session completes;
// - it does not verify => the session FAILS with DAILY_BARS_PACK_EXISTS_DIFFERENT and zero session writes.
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalDailyBar, CorporateAction, MarketProvider, ProviderSecurityRecord } from "./contracts";
import { dailyBarsSidecarFileKey, dailyBarsSidecarManifestKey, writeDailyBarsSidecar } from "./daily-bars-sidecar";
import { securityId } from "./identity";
import { MemoryObjectClient, type ObjectMetadata } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { MarketsScanner, US_EQUITY_CALENDAR } from "./scanner";
import { beforeNextSessionOpen } from "./session-open";

const DAY = "2026-01-20"; // Tuesday
const AT = "2026-01-21T05:00:00.000Z";
const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";
const PROVIDER = "fixture-provider";
const records: ProviderSecurityRecord[] = ["AAA", "BBB"].map((symbol) => ({
  provider: PROVIDER, providerSecurityId: symbol, symbol, assetType: "STOCK", country: "US", exchange: "XNYS", active: true, tradable: true,
}) as ProviderSecurityRecord);
const ids = records.map((r) => securityId(PROVIDER, r.providerSecurityId, r.assetType));
const bar = (id: string, close: number, stamp = AT): CanonicalDailyBar =>
  ({ securityId: id, sessionDate: DAY, open: 1, high: 2, low: 0.5, close, volume: 10, observedAt: stamp, ingestedAt: stamp,
    dataQuality: "GOOD", corporateActionIds: [], flags: [], schemaVersion: "x", revision: 1,
    provenance: { provider: PROVIDER, dataset: "stocks-grouped-daily", retrievalId: "r1", ingestionVersion: "v", normalizerVersion: "n" } }) as unknown as CanonicalDailyBar;

class Provider implements MarketProvider {
  readonly providerName = PROVIDER;
  calls: string[] = [];
  async listApprovedSecurities() { this.calls.push("listApprovedSecurities"); return records; }
  async getDailyBars() { this.calls.push("getDailyBars"); return ids.map((id) => bar(id, 9, "2026-11-24T02:00:00.000Z")); }
  async getCorporateActions(): Promise<CorporateAction[]> { this.calls.push("getCorporateActions"); return []; }
}
class CountingClient extends MemoryObjectClient {
  puts: string[] = [];
  override async put(key: string, body: Uint8Array, metadata: ObjectMetadata = {}) { this.puts.push(key); return super.put(key, body, metadata); }
}
const SESSION_WRITES = ["appendBars", "appendActions", "appendMembership", "recordCorporateActionCoverage", "saveTickerReferenceIndex", "saveSecurities", "writePartitionManifest", "appendCorrections"];
function spied(storage: ObjectMarketStorage) {
  const calls: string[] = [];
  const proxy = new Proxy(storage, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { calls.push(String(prop)); return value.apply(target, args); };
    },
  });
  return { proxy, calls };
}
async function scan(storage: ObjectMarketStorage, packStore: CountingClient, provider = new Provider()) {
  const spy = spied(storage);
  const report = await new MarketsScanner(provider, spy.proxy, US_EQUITY_CALENDAR, undefined, () => beforeNextSessionOpen(DAY),
    { store: packStore, zstdVersionProbe: pinnedZstd }).run(DAY, "EVIDENCE_ONLY");
  return { report, provider, writes: spy.calls.filter((c) => SESSION_WRITES.includes(c)) };
}

test("pack refusal leaves zero session writes and makes no Massive request", async () => {
  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  await storage.initialize();
  const packStore = new CountingClient();
  // Sealed pack for DAY whose row is not among the stored rows (nothing stored for DAY).
  await writeDailyBarsSidecar({ store: packStore, sessionDate: DAY, rows: [bar(ids[0]!, 5)], dust: null });
  const before = await packStore.get(dailyBarsSidecarFileKey(DAY));
  packStore.puts = [];
  const { report, provider, writes } = await scan(storage, packStore);
  assert.equal(report.status, "FAILED");
  assert.ok(report.unresolvedFailures.includes(`DAILY_BARS_PACK_EXISTS_DIFFERENT:${DAY}`), report.unresolvedFailures.join(","));
  assert.deepEqual(writes, [], "no session write before the pack check passes");
  assert.deepEqual(provider.calls, [], "no Massive request");
  assert.deepEqual(packStore.puts, []);
  assert.deepEqual(await packStore.get(dailyBarsSidecarFileKey(DAY)), before);
  assert.equal((await storage.loadBars(DAY)).length, 0);
});

test("a pack file without its manifest is refused before any write too", async () => {
  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  await storage.initialize();
  const packStore = new CountingClient();
  await writeDailyBarsSidecar({ store: packStore, sessionDate: DAY, rows: [bar(ids[0]!, 5)], dust: null });
  await packStore.delete(dailyBarsSidecarManifestKey(DAY));
  const { report, provider, writes } = await scan(storage, packStore);
  assert.equal(report.status, "FAILED");
  assert.deepEqual(writes, []);
  assert.deepEqual(provider.calls, []);
});

test("a sealed pack that verifies: the stored evidence is used, nothing is collected or appended again", async () => {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  await storage.initialize();
  const stored = ids.map((id, i) => bar(id, 3 + i));
  await storage.appendBars(stored);
  const packStore = new CountingClient();
  await writeDailyBarsSidecar({ store: packStore, sessionDate: DAY, rows: await storage.loadBars(DAY), dust: null });
  // A row appended after the seal (another identity for the same day) is reported, never packed or removed.
  await storage.appendBars([bar(securityId(PROVIDER, "CCC", "STOCK"), 7)]);
  const monthBefore = await client.get(`permanent/daily-bars/${DAY.slice(0, 7)}.jsonl`);
  packStore.puts = [];
  const { report, provider, writes } = await scan(storage, packStore);
  assert.notEqual(report.status, "FAILED", report.unresolvedFailures.join(","));
  assert.equal(report.dailyBarsSidecar?.status, "sealed-verified");
  assert.ok(report.unresolvedFailures.includes(`DAILY_BARS_ROWS_OUTSIDE_PACK:${DAY}:1`), report.unresolvedFailures.join(","));
  assert.deepEqual(provider.calls, [], "no Massive request for a sealed session");
  assert.deepEqual(writes.filter((w) => w !== "saveSecurities"), [], "no collection write (eligibility refresh after the check is fine)");
  assert.deepEqual(packStore.puts, []);
  assert.deepEqual(await client.get(`permanent/daily-bars/${DAY.slice(0, 7)}.jsonl`), monthBefore);
});

test("no pack yet: the session is collected and its pack is written, as before", async () => {
  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  await storage.initialize();
  const packStore = new CountingClient();
  const { report, provider } = await scan(storage, packStore);
  assert.notEqual(report.status, "FAILED", report.unresolvedFailures.join(","));
  assert.ok(provider.calls.includes("getDailyBars"));
  assert.equal(report.dailyBarsSidecar?.status, "stored");
  assert.ok(await packStore.get(dailyBarsSidecarManifestKey(DAY)));
});
