import assert from "node:assert/strict";
import test from "node:test";
import type {
  CanonicalDailyBar,
  CorporateAction,
  MarketProvider,
  ProviderSecurityRecord,
} from "./contracts";
import { SCANNER_VERSION } from "./contracts";
import { etCalendarDate, etIsoWithOffset, sessionCollectionDue } from "./et-time";
import { fingerprint, securityId } from "./identity";
import { MassiveMarketProvider, groupedDailyPath } from "./massive-provider";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { MarketsScanner } from "./scanner";
import { collectionDue } from "./scheduler";

const D = "2026-10-05";
const D1 = "2026-10-06";

function providerRecord(
  providerSecurityId: string,
  symbol: string,
): ProviderSecurityRecord {
  return {
    provider: "fixture-provider",
    providerSecurityId,
    symbol,
    assetType: "STOCK",
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
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1000,
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
      retrievalId: "r",
      ingestionVersion: "t",
      normalizerVersion: "t",
    },
  };
}

class CountingProvider implements MarketProvider {
  readonly providerName = "fixture-provider";
  calls = 0;
  constructor(
    private readonly universe: ProviderSecurityRecord[],
    private readonly bars: CanonicalDailyBar[],
    private readonly error?: string,
  ) {}
  async listApprovedSecurities(): Promise<ProviderSecurityRecord[]> {
    this.calls += 1;
    if (this.error) throw new Error(this.error);
    return this.universe;
  }
  async getDailyBars(sessionDate: string, ids: string[]): Promise<CanonicalDailyBar[]> {
    this.calls += 1;
    if (this.error) throw new Error(this.error);
    return this.bars.filter((b) => b.sessionDate === sessionDate && ids.includes(b.securityId));
  }
  async getCorporateActions(): Promise<CorporateAction[]> {
    this.calls += 1;
    return [];
  }
}

test("et helpers: session due only when ET date strictly after D", () => {
  // 22:00 ET on D = 2026-10-05T22:00-04:00 = 2026-10-06T02:00Z (EDT)
  const at2200 = new Date("2026-10-06T02:00:00.000Z");
  assert.equal(etCalendarDate(at2200), D);
  assert.equal(sessionCollectionDue(D, at2200), false);
  // 23:59:59 ET on D
  const at235959 = new Date("2026-10-06T03:59:59.000Z");
  assert.equal(etCalendarDate(at235959), D);
  assert.equal(sessionCollectionDue(D, at235959), false);
  // 00:00:00 ET D+1
  const atMidnight = new Date("2026-10-06T04:00:00.000Z");
  assert.equal(etCalendarDate(atMidnight), D1);
  assert.equal(sessionCollectionDue(D, atMidnight), true);
});

test("DST: 05:30Z winter and summer are both due for previous ET date", () => {
  // Winter EST: 2026-01-06T05:30Z = 00:30 ET Jan 6 → due for Jan 5
  const winter = new Date("2026-01-06T05:30:00.000Z");
  assert.equal(etCalendarDate(winter), "2026-01-06");
  assert.equal(sessionCollectionDue("2026-01-05", winter), true);
  assert.equal(sessionCollectionDue("2026-01-06", winter), false);
  const dueW = collectionDue({ now: winter });
  assert.equal(dueW.session.sessionDate, "2026-01-05");
  assert.equal(dueW.due, true);
  // Summer EDT: 2026-07-06T05:30Z = 01:30 ET Jul 6 → due for Jul 5 (Sunday=CLOSED?)
  // Jul 5 2026 is Sunday → CLOSED. Use a Wednesday.
  // 2026-07-08T05:30Z = Wed Jul 8 01:30 EDT → due for Jul 7 (Tue, NORMAL)
  const summer = new Date("2026-07-08T05:30:00.000Z");
  assert.equal(etCalendarDate(summer), "2026-07-08");
  assert.equal(sessionCollectionDue("2026-07-07", summer), true);
  const dueS = collectionDue({ now: summer });
  assert.equal(dueS.session.sessionDate, "2026-07-07");
  assert.equal(dueS.due, true);
});

test("S2: run at 22:00 ET on D → NOT_DUE, 0 requests, nothing written", async () => {
  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  await storage.initialize();
  const provider = new CountingProvider([providerRecord("i1", "AAA")], []);
  // 22:00 ET on 2026-10-05 (EDT) = 02:00Z on 2026-10-06
  const now = () => new Date("2026-10-06T02:00:00.000Z");
  const report = await new MarketsScanner(provider, storage, undefined, undefined, now).run(D);
  assert.equal(report.status, "NOT_DUE");
  assert.equal(provider.calls, 0);
  assert.equal((await storage.loadPredictionStatuses(D)).length, 0);
  assert.equal((await storage.loadBeliefs(D)).length, 0);
  assert.equal((await storage.loadPredictions(D)).length, 0);
});

test("S2: 23:59:59 ET on D is NOT_DUE; 00:00:00 ET D+1 is due (gate opens)", async () => {
  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  await storage.initialize();
  const id = securityId("fixture-provider", "i1", "STOCK");
  const provider = new CountingProvider([providerRecord("i1", "AAA")], [bar(id, D, 100)]);
  const notDue = await new MarketsScanner(
    provider,
    storage,
    undefined,
    undefined,
    () => new Date("2026-10-06T03:59:59.000Z"),
  ).run(D);
  assert.equal(notDue.status, "NOT_DUE");
  assert.equal(provider.calls, 0);

  const due = await new MarketsScanner(
    provider,
    storage,
    undefined,
    undefined,
    () => new Date("2026-10-06T04:00:00.000Z"),
  ).run(D);
  assert.notEqual(due.status, "NOT_DUE");
  assert.ok(provider.calls > 0);
});

test("S2: 403 before end of day → PROVIDER_NOT_READY with path; readiness lists refusal; later success records firstAllowedAt", async () => {
  let phase: "refuse" | "allow" = "refuse";
  let clockMs = Date.parse("2026-10-06T04:30:00.000Z"); // 00:30 ET D+1
  const provider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    clock: () => clockMs,
    now: () => new Date(clockMs).toISOString(),
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/v3/reference/tickers")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                ticker: "AAA",
                share_class_figi: "figi-aaa",
                type: "CS",
                market: "stocks",
                locale: "us",
                primary_exchange: "XNAS",
                active: true,
              },
            ],
            status: "OK",
            next_url: null,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v2/aggs/grouped/")) {
        if (phase === "refuse") {
          return new Response(
            JSON.stringify({
              status: "NOT_AUTHORIZED",
              message: "Attempted to request today's data before end of day",
            }),
            { status: 403, headers: { "request-id": "req-eod" } },
          );
        }
        return new Response(
          JSON.stringify({
            results: [
              {
                T: "AAA",
                v: 1,
                o: 1,
                c: 1,
                h: 1,
                l: 1,
                t: Date.parse(`${D}T14:30:00Z`),
                n: 1,
              },
            ],
            status: "OK",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    },
  });

  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  await storage.initialize();
  const now = () => new Date(clockMs);
  const scanner = new MarketsScanner(provider, storage, undefined, undefined, now);

  await assert.rejects(async () => {
    // Drive grouped-daily through getDailyBars after binding universe
    const secs = await provider.listApprovedSecurities();
    provider.bindUniverse(secs);
    await provider.getDailyBars(D, [securityId("massive-stocks", "figi-aaa", "STOCK")]);
  }, new RegExp(`PROVIDER_NOT_READY:${groupedDailyPath(D).replace(/\//g, "\\/")}:.*before end of day`));

  const readinessAfterRefuse = provider.providerReadinessFor(D);
  assert.ok(readinessAfterRefuse);
  assert.equal(readinessAfterRefuse!.refusedGroupedDailyAt.length, 1);
  assert.equal(readinessAfterRefuse!.refusedGroupedDailyAt[0], etIsoWithOffset(new Date(clockMs)));
  assert.equal(readinessAfterRefuse!.firstAllowedGroupedDailyAt, undefined);

  // Full scanner run that hits NOT_READY on bars (universe ok)
  phase = "refuse";
  const report = await scanner.run(D);
  assert.equal(report.status, "PROVIDER_NOT_READY");
  assert.ok(
    report.unresolvedFailures.some((f) => f.includes(groupedDailyPath(D))),
    report.unresolvedFailures.join(","),
  );
  assert.ok(report.providerReadiness);
  assert.ok(report.providerReadiness!.refusedGroupedDailyAt.length >= 1);

  // Later success
  phase = "allow";
  clockMs = Date.parse("2026-10-06T05:00:00.000Z");
  const secs = await provider.listApprovedSecurities();
  provider.bindUniverse(secs);
  await provider.getDailyBars(D, [securityId("massive-stocks", "figi-aaa", "STOCK")]);
  const ready = provider.providerReadinessFor(D)!;
  assert.ok(ready.firstAllowedGroupedDailyAt);
  assert.equal(ready.firstAllowedGroupedDailyAt, etIsoWithOffset(new Date(clockMs)));
});

test("etIsoWithOffset includes numeric offset (EST/EDT)", () => {
  // Winter
  const winter = etIsoWithOffset(new Date("2026-01-06T05:30:00.000Z"));
  assert.match(winter, /^2026-01-06T00:30:00-05:00$/);
  // Summer
  const summer = etIsoWithOffset(new Date("2026-07-08T05:30:00.000Z"));
  assert.match(summer, /^2026-07-08T01:30:00-04:00$/);
});
