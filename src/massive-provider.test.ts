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
