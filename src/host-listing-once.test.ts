// The approved-securities listing (about 37 paced Massive requests, ~463 s live) is fetched once per
// host run, not once per catch-up session.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalDailyBar, CorporateAction, MarketProvider, ProviderSecurityRecord } from "./contracts";
import { runScannerHost } from "./host";
import { MassiveMarketProvider } from "./massive-provider";

async function withSeededHost<T>(lastObserved: string, fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-listing-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "scheduler-host-state.json"),
    `${JSON.stringify({ schemaVersion: "peaceai-markets-scheduler-host:v1", forwardClockStartedAt: "2026-11-01T05:30:00.000Z", lastObservedSessionDate: lastObserved }, null, 2)}\n`,
  );
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
}
const host = (root: string, provider: MarketProvider) =>
  runScannerHost({
    now: new Date("2026-11-21T05:30:00.000Z"),
    storageRoot: root,
    provider,
    completionDelayMinutes: 30,
    env: { PEACESTOCKS_SCAN_MAX_SESSIONS: "3" },
    clock: () => 0,
    stageSink: () => {},
  });

test("Massive requests: the ticker listing is paged once per run, not once per session", async () => {
  await withSeededHost("2026-11-02", async (root) => {
    const requests: string[] = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const provider = new MassiveMarketProvider({
      apiKey: "test-key",
      minRequestIntervalMs: 0,
      retryBackoffMs: 0,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        requests.push(url.pathname.split("/").slice(0, 4).join("/"));
        if (url.pathname.startsWith("/v3/reference/tickers"))
          return json({ status: "OK", next_url: null, results: [{ ticker: "AAA", share_class_figi: "figi-aaa", type: "CS", market: "stocks", locale: "us", primary_exchange: "XNAS", active: url.searchParams.get("active") !== "false" }] });
        if (url.pathname.startsWith("/v2/aggs/grouped/")) {
          const day = url.pathname.split("/").at(-1)!;
          return json({ status: "OK", results: [{ T: "AAA", o: 1, h: 2, l: 0.5, c: 1.5, v: 10, t: Date.parse(`${day}T21:00:00Z`) }] });
        }
        return json({ status: "OK", results: [] });
      },
    });
    const result = await host(root, provider);
    assert.deepEqual(result.sessions, ["2026-11-03", "2026-11-04", "2026-11-05"]);
    const listing = requests.filter((r) => r.startsWith("/v3/reference/tickers")).length;
    const perSession = requests.filter((r) => !r.startsWith("/v3/reference/tickers")).length / 3;
    // Before: 2 listing pages (active + inactive) x 3 sessions = 6. After: 2 for the whole run.
    assert.equal(listing, 2, requests.join("\n"));
    assert.ok(perSession >= 1);
  });
});

test("a failed listing is not reused: the next session lists again", async () => {
  await withSeededHost("2026-11-02", async (root) => {
    let calls = 0;
    const provider: MarketProvider = {
      providerName: "fixture-provider",
      async listApprovedSecurities(): Promise<ProviderSecurityRecord[]> {
        calls += 1;
        if (calls === 1) throw new Error("MASSIVE_HTTP_503");
        return [{ provider: "fixture-provider", providerSecurityId: "i1", symbol: "AAA", assetType: "STOCK", country: "US", exchange: "NYSE", active: true, tradable: true }];
      },
      async getDailyBars(sessionDate: string, ids: string[]): Promise<CanonicalDailyBar[]> {
        return ids.map((id) => ({ securityId: id, sessionDate, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, observedAt: `${sessionDate}T21:00:00Z`, ingestedAt: `${sessionDate}T22:00:00Z`, dataQuality: "GOOD", corporateActionIds: [], flags: [], schemaVersion: "foundation-d-v0", revision: 1, provenance: { provider: "fixture-provider", dataset: "daily-ohlcv", retrievalId: "r", ingestionVersion: "t", normalizerVersion: "t" } }) as CanonicalDailyBar);
      },
      async getCorporateActions(): Promise<CorporateAction[]> { return []; },
    };
    await host(root, provider);
    assert.equal(calls, 2, "failed first listing, one successful listing reused after");
  });
});
