import assert from "node:assert/strict";
import test from "node:test";
import { securityId } from "./identity";
import { MassiveMarketProvider, mergeSameIdentity } from "./massive-provider";
import type { ProviderSecurityRecord } from "./contracts";
import { ScanYieldError } from "./scan-yield";

function securityIdForTest(): string {
  return securityId("massive-stocks", "SPY", "ETF");
}
test("Massive HTTP failures preserve safe provider diagnostics", async () => {
  const provider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    fetchImpl: async () =>
      new Response(JSON.stringify({ status: "ERROR", code: "NOT_AUTHORIZED", message: "denied" }), {
        status: 403,
        headers: { "request-id": "req-test" },
      }),
  });

  await assert.rejects(
    provider.listApprovedSecurities(),
    /MASSIVE_HTTP_403:requestId=req-test:body=\{"status":"ERROR","code":"NOT_AUTHORIZED","message":"denied"\}/,
  );
});

test("Massive 10-minute adapter normalizes provider aggregates into canonical session evidence", async () => {
  const provider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    fetchImpl: async (input) => {
      const url = String(input);
      assert.match(url, /\/v2\/aggs\/ticker\/SPY\/range\/10\/minute\/2026-01-02\/2026-01-02/);
      return new Response(
        JSON.stringify({
          request_id: "req-10m",
          results: [
            {
              t: Date.parse("2026-01-02T14:30:00.000Z"),
              o: 100,
              h: 101,
              l: 99,
              c: 100.5,
              v: 1234,
              vw: 100.25,
              n: 4,
            },
          ],
        }),
        { status: 200 },
      );
    },
  });
  const securityId = securityIdForTest();
  provider.bindUniverse([
    {
      provider: "massive-stocks",
      providerSecurityId: "SPY",
      symbol: "SPY",
      assetType: "ETF",
      country: "US",
      exchange: "NYSE",
      active: true,
      tradable: true,
    },
  ]);
  const bars = await provider.getIntradayBars("2026-01-02", [securityId]);
  assert.equal(bars.length, 39);
  assert.equal(bars[0]?.state, "VALID_TRADED");
  assert.equal(bars[0]?.volume, 1234);
  assert.equal(bars[1]?.state, "PROVIDER_MISSING");
  assert.equal(bars[0]?.provenance.dataset, "stocks-aggregates-10m");
});

test("Massive end-of-day 403 is provider-not-ready and is not retried", async () => {
  let calls = 0;
  const provider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          status: "NOT_AUTHORIZED",
          message: "Attempted to request today's data before end of day",
        }),
        { status: 403, headers: { "request-id": "req-eod" } },
      );
    },
  });
  await assert.rejects(
    provider.listApprovedSecurities(),
    /PROVIDER_NOT_READY:.*before end of day/,
  );
  assert.equal(calls, 1);
});

test("Massive 429 and network failures back off, then surface", async () => {
  let limited = 0;
  const limitedProvider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    fetchImpl: async () => {
      limited += 1;
      return new Response("{}", { status: 429, headers: { "request-id": "req-429" } });
    },
  });
  await assert.rejects(limitedProvider.listApprovedSecurities(), /MASSIVE_HTTP_429/);
  assert.equal(limited, 3);
  assert.equal(limitedProvider.rateLimitedResponses, 3);

  // A 429 that a retry recovers from is still counted.
  let recovered = 0;
  const recoveringProvider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    fetchImpl: async () =>
      ++recovered === 1
        ? new Response("{}", { status: 429 })
        : new Response(JSON.stringify({ results: [] }), { status: 200 }),
  });
  await recoveringProvider.listApprovedSecurities();
  assert.equal(recoveringProvider.rateLimitedResponses, 1);

  let network = 0;
  const networkProvider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    fetchImpl: async () => {
      network += 1;
      throw new Error("socket hang up");
    },
  });
  await assert.rejects(networkProvider.listApprovedSecurities(), /MASSIVE_NETWORK:socket hang up/);
  assert.equal(network, 3);
});

test("concurrent Massive calls share one pace", async () => {
  const stamps: number[] = [];
  const provider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 40,
    retryBackoffMs: 0,
    fetchImpl: async () => {
      stamps.push(Date.now());
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    },
  });
  provider.bindUniverse([
    {
      provider: "massive-stocks",
      providerSecurityId: "SPY",
      symbol: "SPY",
      assetType: "ETF",
      country: "US",
      exchange: "NYSE",
      active: true,
      tradable: true,
    },
  ]);
  await provider.getCorporateActions("2026-01-22", [securityIdForTest()]);
  assert.equal(stamps.length >= 2, true);
  assert.equal(stamps[1]! - stamps[0]! >= 40, true);
});

test("an invalid Massive credential is rejected without retry", async () => {
  let calls = 0;
  const provider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ message: "invalid api key" }), {
        status: 401,
        headers: { "request-id": "req-auth" },
      });
    },
  });
  await assert.rejects(provider.listApprovedSecurities(), /MASSIVE_CREDENTIAL_REJECTED/);
  assert.equal(calls, 1);
});

test("Massive ticker listing checks shouldStop at each later page boundary and returns nothing partial", async () => {
  const urls: string[] = [];
  const provider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    fetchImpl: async (input) => {
      const url = String(input);
      urls.push(url);
      const page = urls.length;
      return new Response(
        JSON.stringify({
          results: [{ ticker: `T${page}`, type: "CS", market: "stocks", locale: "us", active: true }],
          next_url: `https://api.massive.com/v3/reference/tickers?cursor=p${page + 1}`,
        }),
        { status: 200 },
      );
    },
  });
  let asked = 0;
  await assert.rejects(
    provider.listApprovedSecurities({
      shouldStop: async () => (++asked === 3 ? "SCAN_GUARD_WINDOW:2026-01-22T21:15:00.000Z" : undefined),
    }),
    (error: unknown) =>
      error instanceof ScanYieldError && error.reason === "SCAN_GUARD_WINDOW:2026-01-22T21:15:00.000Z",
  );
  // Not asked before the first page; asked before pages 2, 3 and 4; stopped before page 4.
  assert.equal(asked, 3);
  assert.equal(urls.length, 3);
});

test("an inactive ticker never replaces an active ticker with the same FIGI", async () => {
  const provider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    fetchImpl: async (input) => {
      const active = new URL(String(input)).searchParams.get("active");
      const ticker = (symbol: string, isActive: boolean, figi: string, extra: object = {}) => ({
        ticker: symbol,
        type: "CS",
        market: "stocks",
        locale: "us",
        active: isActive,
        share_class_figi: figi,
        ...extra,
      });
      const results =
        active === "false"
          ? [
              ticker("OLDN", false, "FIGI-SAME", { list_date: "2019-03-01", delisted_utc: "2024-05-20T00:00:00Z" }),
              ticker("GONE", false, "FIGI-GONE", { delisted_utc: "2023-01-03T00:00:00Z" }),
            ]
          : [ticker("NEWN", true, "FIGI-SAME", { list_date: "2024-05-21" }), ticker("LIVE", true, "FIGI-LIVE")];
      return new Response(JSON.stringify({ request_id: `universe-${active}`, results }), { status: 200 });
    },
  });
  const universe = await provider.listApprovedSecurities();
  assert.deepEqual(
    universe.map((item) => [item.symbol, item.active]),
    [
      ["GONE", false],
      ["LIVE", true],
      ["NEWN", true],
    ],
  );
  const renamed = universe.find((item) => item.symbol === "NEWN");
  assert.deepEqual(renamed?.formerSymbols, [{ symbol: "OLDN", listingDate: "2019-03-01", delistedDate: "2024-05-20" }]);
  assert.equal(universe.find((item) => item.symbol === "GONE")?.delistedDate, "2023-01-03");
  assert.equal(universe.find((item) => item.symbol === "LIVE")?.formerSymbols, undefined);
});

test("same-identity merge: active wins in either order, same status keeps the later record", () => {
  const record = (symbol: string, active: boolean): ProviderSecurityRecord => ({
    provider: "massive-stocks",
    providerSecurityId: "FIGI-X",
    symbol,
    assetType: "STOCK",
    country: "US",
    exchange: "XNAS",
    active,
    tradable: active,
  });
  for (const order of [
    [record("A", true), record("B", false)],
    [record("B", false), record("A", true)],
  ]) {
    const output = new Map<string, ProviderSecurityRecord>();
    for (const item of order) mergeSameIdentity(output, item);
    assert.equal(output.size, 1);
    assert.equal(output.get("FIGI-X|STOCK")?.symbol, "A");
    assert.deepEqual(output.get("FIGI-X|STOCK")?.formerSymbols, [{ symbol: "B" }]);
  }
  const inactive = new Map<string, ProviderSecurityRecord>();
  for (const item of [record("C", false), record("D", false), record("C", false)]) mergeSameIdentity(inactive, item);
  assert.equal(inactive.get("FIGI-X|STOCK")?.symbol, "C");
  assert.deepEqual(inactive.get("FIGI-X|STOCK")?.formerSymbols, [{ symbol: "D" }]);
  const same = new Map<string, ProviderSecurityRecord>();
  for (const item of [record("E", true), record("E", false)]) mergeSameIdentity(same, item);
  assert.equal(same.get("FIGI-X|STOCK")?.active, true);
  assert.equal(same.get("FIGI-X|STOCK")?.formerSymbols, undefined);
});

test("grouped daily and 10-minute requests keep Massive's exact reply bytes", async () => {
  // Odd spacing and a unicode escape prove the stored bytes are the wire bytes, not re-serialized JSON.
  const grouped = '{"adjusted":false,"results":[{"T":"SPY","v":1234.5,"vw":100.1,"o":100,"c":101,"h":102,"l":99,"t":1767387600000,"n":7}],  "status":"OK","request_id":"req-\\u0067rouped"}';
  const tenMinute = `{"ticker":"SPY","results":[{"v":10,"vw":100.25,"o":100,"c":100.5,"h":101,"l":99,"t":${Date.parse("2026-01-02T14:30:00.000Z")},"n":4}],"status":"OK","request_id":"req-10m"}\n`;
  const provider = new MassiveMarketProvider({
    apiKey: "secret-key",
    minRequestIntervalMs: 0,
    keepRawReplies: true,
    now: () => "2026-01-02T22:00:00.000Z",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/grouped/")) return new Response(grouped, { status: 200 });
      if (url.pathname.includes("/range/10/minute/")) return new Response(tenMinute, { status: 200 });
      return new Response('{"status":"ERROR"}', { status: 500 });
    },
  });
  provider.bindUniverse([
    { provider: "massive-stocks", providerSecurityId: "SPY", symbol: "SPY", assetType: "ETF", country: "US", exchange: "ARCX", active: true, tradable: true },
  ]);
  const id = securityIdForTest();
  const daily = await provider.getDailyBars("2026-01-02", [id]);
  const intraday = await provider.getIntradayBars("2026-01-02", [id]);
  assert.equal(daily.length, 1);
  assert.equal(daily[0]?.provenance.retrievalId, "req-grouped");
  assert.ok(intraday.some((bar) => bar.close === 100.5));
  const replies = provider.takeRawReplies();
  assert.deepEqual(
    replies.map(({ body, ...meta }) => meta),
    [
      {
        dataset: "stocks-grouped-daily",
        sessionDate: "2026-01-02",
        request: "/v2/aggs/grouped/locale/us/market/stocks/2026-01-02?adjusted=false&include_otc=false",
        fetchedAt: "2026-01-02T22:00:00.000Z",
      },
      {
        dataset: "stocks-aggregates-10m",
        sessionDate: "2026-01-02",
        securityId: id,
        symbol: "SPY",
        request: "/v2/aggs/ticker/SPY/range/10/minute/2026-01-02/2026-01-02?adjusted=false&sort=asc&limit=50000",
        fetchedAt: "2026-01-02T22:00:00.000Z",
      },
    ],
  );
  assert.deepEqual(replies[0]?.body, new TextEncoder().encode(grouped));
  assert.deepEqual(replies[1]?.body, new TextEncoder().encode(tenMinute));
  assert.ok(replies.every((reply) => !reply.request.includes("secret-key")));
  assert.deepEqual(provider.takeRawReplies(), []);
});

test("failed and non-bar requests keep no raw reply", async () => {
  const provider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    keepRawReplies: true,
    fetchImpl: async (input) =>
      String(input).includes("/v3/reference/tickers")
        ? new Response('{"results":[],"status":"OK"}', { status: 200 })
        : new Response('{"status":"ERROR","message":"boom"}', { status: 500 }),
  });
  provider.bindUniverse([
    { provider: "massive-stocks", providerSecurityId: "SPY", symbol: "SPY", assetType: "ETF", country: "US", exchange: "ARCX", active: true, tradable: true },
  ]);
  await provider.listApprovedSecurities();
  provider.bindUniverse([
    { provider: "massive-stocks", providerSecurityId: "SPY", symbol: "SPY", assetType: "ETF", country: "US", exchange: "ARCX", active: true, tradable: true },
  ]);
  await assert.rejects(provider.getDailyBars("2026-01-02", [securityIdForTest()]));
  assert.deepEqual(provider.takeRawReplies(), []);
});

test("raw replies are not kept unless asked for", async () => {
  const provider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    fetchImpl: async () => new Response('{"results":[],"status":"OK"}', { status: 200 }),
  });
  provider.bindUniverse([
    { provider: "massive-stocks", providerSecurityId: "SPY", symbol: "SPY", assetType: "ETF", country: "US", exchange: "ARCX", active: true, tradable: true },
  ]);
  await provider.getDailyBars("2026-01-02", [securityIdForTest()]);
  assert.deepEqual(provider.takeRawReplies(), []);
});


test("ten-minute range fetch returns exact page bytes and request without apiKey", async () => {
  // Odd spacing proves stored bytes are the wire bytes, not re-serialized JSON.
  const pageBody =
    '{"ticker":"SPY","resultsCount":1,"results":[{"v":10,"o":100,"c":101,"h":102,"l":99,"t":1767387600000}],  "status":"OK","request_id":"req-range-1"}';
  const urls: string[] = [];
  const provider = new MassiveMarketProvider({
    apiKey: "secret-key",
    minRequestIntervalMs: 0,
    now: () => "2026-03-01T22:00:00.000Z",
    fetchImpl: async (input) => {
      urls.push(String(input));
      return new Response(pageBody, { status: 200 });
    },
  });
  const id = securityIdForTest();
  const pages = await provider.getTenMinuteRangeReplies(
    { securityId: id, symbol: "SPY" },
    "2026-01-02",
    "2026-02-28",
  );
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.page, 1);
  assert.equal(
    pages[0]?.request,
    "/v2/aggs/ticker/SPY/range/10/minute/2026-01-02/2026-02-28?adjusted=false&sort=asc&limit=50000",
  );
  assert.ok(!pages[0]?.request.includes("secret-key"));
  assert.ok(!pages[0]?.request.includes("apiKey"));
  assert.deepEqual(pages[0]?.body, new TextEncoder().encode(pageBody));
  assert.equal(pages[0]?.rangeFrom, "2026-01-02");
  assert.equal(pages[0]?.rangeTo, "2026-02-28");
  assert.equal(pages[0]?.securityId, id);
  assert.equal(pages[0]?.symbol, "SPY");
  assert.equal(pages[0]?.fetchedAt, "2026-03-01T22:00:00.000Z");
  assert.match(urls[0]!, /apiKey=secret-key/);
  assert.match(urls[0]!, /\/v2\/aggs\/ticker\/SPY\/range\/10\/minute\/2026-01-02\/2026-02-28/);
  // Range replies are returned directly; the global buffer stays empty.
  assert.deepEqual(provider.takeRawReplies(), []);
});

test("ten-minute range fetch follows next_url and keeps every page's exact bytes", async () => {
  const page1 =
    '{"results":[{"v":1,"o":1,"c":1,"h":1,"l":1,"t":1}],"next_url":"https://api.massive.com/v2/aggs/ticker/SPY/range/10/minute/2026-01-02/2026-02-28?cursor=p2","status":"OK"}';
  const page2 =
    '{"results":[{"v":2,"o":2,"c":2,"h":2,"l":2,"t":2}],  "status":"OK","request_id":"p2"}\n';
  const urls: string[] = [];
  const provider = new MassiveMarketProvider({
    apiKey: "secret-key",
    minRequestIntervalMs: 0,
    now: () => "2026-03-01T22:00:00.000Z",
    fetchImpl: async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("cursor=p2")) return new Response(page2, { status: 200 });
      return new Response(page1, { status: 200 });
    },
  });
  const id = securityIdForTest();
  const pages = await provider.getTenMinuteRangeReplies(
    { securityId: id, symbol: "SPY" },
    "2026-01-02",
    "2026-02-28",
  );
  assert.equal(pages.length, 2);
  assert.equal(pages[0]?.page, 1);
  assert.equal(pages[1]?.page, 2);
  assert.deepEqual(pages[0]?.body, new TextEncoder().encode(page1));
  assert.deepEqual(pages[1]?.body, new TextEncoder().encode(page2));
  assert.equal(
    pages[0]?.request,
    "/v2/aggs/ticker/SPY/range/10/minute/2026-01-02/2026-02-28?adjusted=false&sort=asc&limit=50000",
  );
  assert.equal(
    pages[1]?.request,
    "/v2/aggs/ticker/SPY/range/10/minute/2026-01-02/2026-02-28?cursor=p2",
  );
  assert.ok(pages.every((p) => !p.request.includes("secret-key") && !p.request.includes("apiKey")));
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => u.includes("apiKey=secret-key")));
  assert.ok(urls[1]!.includes("cursor=p2"));
});

test("ten-minute range fetch refuses a next_url on a different origin", async () => {
  const provider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          results: [],
          next_url: "https://evil.example/v2/aggs/ticker/SPY/range/10/minute/2026-01-02/2026-02-28?cursor=x",
        }),
        { status: 200 },
      ),
  });
  await assert.rejects(
    provider.getTenMinuteRangeReplies(
      { securityId: securityIdForTest(), symbol: "SPY" },
      "2026-01-02",
      "2026-02-28",
    ),
    /MASSIVE_UNTRUSTED_NEXT_URL/,
  );
});

test("ten-minute range pages share the provider pace", async () => {
  const stamps: number[] = [];
  const provider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 40,
    retryBackoffMs: 0,
    fetchImpl: async (input) => {
      stamps.push(Date.now());
      const url = String(input);
      if (url.includes("cursor=p2"))
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response(
        JSON.stringify({
          results: [],
          next_url: "https://api.massive.com/v2/aggs/ticker/SPY/range/10/minute/2026-01-02/2026-02-28?cursor=p2",
        }),
        { status: 200 },
      );
    },
  });
  await provider.getTenMinuteRangeReplies(
    { securityId: securityIdForTest(), symbol: "SPY" },
    "2026-01-02",
    "2026-02-28",
  );
  assert.equal(stamps.length, 2);
  assert.equal(stamps[1]! - stamps[0]! >= 40, true);
});
