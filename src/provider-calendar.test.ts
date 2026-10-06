import assert from "node:assert/strict";
import test from "node:test";
import { securityId } from "./identity";
import { MassiveMarketProvider } from "./massive-provider";
import { collectionDue } from "./scheduler";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("Massive adapter normalizes only US stocks and ETFs and preserves inactive records", async () => {
  const calls: URL[] = [];
  const provider = new MassiveMarketProvider({
    apiKey: "test-key",
    baseUrl: "https://api.massive.test",
    minRequestIntervalMs: 0,
    fetchImpl: async (input) => {
      const url = new URL(input.toString());
      calls.push(url);
      return response({
        request_id: "universe-1",
        results:
          url.searchParams.get("active") === "false"
            ? [
                {
                  ticker: "OLD",
                  type: "CS",
                  market: "stocks",
                  locale: "us",
                  active: false,
                  composite_figi: "FIGI-OLD",
                },
              ]
            : [
                {
                  ticker: "AAA",
                  type: "CS",
                  market: "stocks",
                  locale: "us",
                  active: true,
                  share_class_figi: "FIGI-AAA",
                  primary_exchange: "XNAS",
                },
                {
                  ticker: "FUND",
                  type: "ETF",
                  market: "stocks",
                  locale: "us",
                  active: true,
                  composite_figi: "FIGI-FUND",
                },
                { ticker: "OPT", type: "OPTION", market: "stocks", locale: "us", active: true },
                { ticker: "ADR", type: "CS", market: "stocks", locale: "global", active: true },
              ],
      });
    },
  });
  const universe = await provider.listApprovedSecurities();
  assert.deepEqual(
    universe.map((item) => [item.symbol, item.assetType, item.active]),
    [
      ["AAA", "STOCK", true],
      ["FUND", "ETF", true],
      ["OLD", "STOCK", false],
    ],
  );
  assert.equal(
    calls.every(
      (url) =>
        url.origin === "https://api.massive.test" && url.searchParams.get("apiKey") === "test-key",
    ),
    true,
  );
  assert.throws(
    () => new MassiveMarketProvider({ apiKey: "x", baseUrl: "http://api.massive.test" }),
    /MASSIVE_HTTPS_REQUIRED/,
  );
});

test("Massive adapter normalizes grouped unadjusted daily bars and actions", async () => {
  const now = "2026-08-26T22:00:00.000Z";
  const provider = new MassiveMarketProvider({
    apiKey: "test-key",
    baseUrl: "https://api.massive.test",
    minRequestIntervalMs: 0,
    now: () => now,
    fetchImpl: async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path.includes("grouped"))
        return response({
          request_id: "bars-1",
          results: [{ T: "AAA", o: 1, h: 2, l: 0.5, c: 1.5, v: 100, t: 1787781600000 }],
        });
      if (path.includes("splits"))
        return response({
          request_id: "split-1",
          results: [
            {
              id: "split-1",
              ticker: "AAA",
              adjustment_type: "forward_split",
              split_from: 1,
              split_to: 2,
            },
          ],
        });
      return response({
        request_id: "div-1",
        results: [{ id: "div-1", ticker: "AAA", cash_amount: 0.25 }],
      });
    },
  });
  const id = securityId("massive-stocks", "FIGI-AAA", "STOCK");
  provider.bindUniverse([
    {
      provider: "massive-stocks",
      providerSecurityId: "FIGI-AAA",
      symbol: "AAA",
      assetType: "STOCK",
      country: "US",
      exchange: "XNAS",
      active: true,
      tradable: true,
    },
  ]);
  const bars = await provider.getDailyBars("2026-08-26", [id]);
  assert.equal(bars[0]?.securityId, id);
  assert.equal(bars[0]?.flags.includes("UNADJUSTED"), true);
  assert.equal(bars[0]?.provenance.dataset, "stocks-grouped-daily");
  const actions = await provider.getCorporateActions("2026-08-26", [id]);
  assert.deepEqual(actions.map((action) => action.actionType).sort(), ["DIVIDEND", "SPLIT"]);
  await assert.rejects(provider.getDailyBars("bad-date", [id]), /INVALID_SESSION_DATE/);
});

test("NYSE calendar recognizes holidays and common early closes", () => {
  assert.equal(US_EQUITY_MARKET_CALENDAR.getSession("2026-01-01").kind, "CLOSED");
  assert.equal(US_EQUITY_MARKET_CALENDAR.getSession("2026-11-27").kind, "HALF_DAY");
  assert.equal(US_EQUITY_MARKET_CALENDAR.getSession("2026-11-25").kind, "NORMAL");
  assert.equal(US_EQUITY_MARKET_CALENDAR.getSession("2026-11-28").kind, "CLOSED");
  // One-off closure: national day of mourning for President Carter.
  assert.equal(US_EQUITY_MARKET_CALENDAR.getSession("2025-01-09").kind, "CLOSED");
  assert.equal(US_EQUITY_MARKET_CALENDAR.getSession("2025-01-08").kind, "NORMAL");
  assert.equal(US_EQUITY_MARKET_CALENDAR.getSession("2025-01-10").kind, "NORMAL");
});

test("scheduler waits through close plus provider publication delay", () => {
  const before = collectionDue({ now: new Date("2026-08-26T19:00:00.000Z") });
  const after = collectionDue({ now: new Date("2026-08-26T21:00:00.000Z") });
  assert.equal(before.reason, "BEFORE_CLOSE");
  assert.equal(after.due, true);
});
