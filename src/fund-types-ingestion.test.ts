// ETNs and closed-end funds stay out of the stock lists because ingestion keeps only the provider's
// CS (common stock) and ETF types; the provider has separate types for ETNs ("ETN") and funds ("FUND"). The security
// master keeps no issuer name, so a fund the provider mistypes as CS would still enter (documented in
// docs/SCANNER.md, "Stock lists hold stocks only"). Guard: every other type is dropped at ingestion.
import assert from "node:assert/strict";
import test from "node:test";
import { MassiveMarketProvider } from "./massive-provider";

test("ingestion keeps CS (as STOCK) and ETF only: ETN, FUND, ETV, ETS, ADRs, preferreds, warrants, rights, units are dropped", async () => {
  const types = ["CS", "ETF", "ETN", "FUND", "ETV", "ETS", "ADRC", "ADRP", "PFD", "WARRANT", "RIGHT", "UNIT", "SP", "OS", "GDR", "BOND"];
  const provider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    fetchImpl: async (input) => {
      const active = new URL(String(input)).searchParams.get("active") !== "false";
      const results = active
        ? types.map((type) => ({ ticker: `X${type}`, share_class_figi: `figi-${type}`, type, market: "stocks", locale: "us", primary_exchange: "XNYS", active: true }))
        : [];
      return new Response(JSON.stringify({ status: "OK", results, next_url: null }), { status: 200 });
    },
  });
  const listed = await provider.listApprovedSecurities();
  assert.deepEqual(listed.map((r) => [r.symbol, r.assetType]).sort(), [["XCS", "STOCK"], ["XETF", "ETF"]]);
});
