import assert from "node:assert/strict";
import test from "node:test";
import { securityId } from "./identity";
import { MassiveMarketProvider } from "./massive-provider";

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
