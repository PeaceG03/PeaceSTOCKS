import assert from "node:assert/strict";
import test from "node:test";
import { backfillHistoricalEvidence } from "./backfill";
import { securityId } from "./identity";
import { MassiveMarketProvider } from "./massive-provider";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { pointInTimeUniverse, symbolOn } from "./pit-universe";
import type { SecurityMasterRecord } from "./contracts";

// Survivorship: a historical backfill must keep names that later went inactive / delisted for the
// sessions they traded, and must not credit a reused ticker's old bars to the new listing.
// Fixture (synthetic symbols): AAA trades throughout. GONE traded on 01-20 and 01-21 and was
// delisted on 01-21. RUSE was an old company's ticker until 01-20 (delisted 01-20); a new company
// listed under RUSE on 01-21.
const DAYS = ["2026-01-20", "2026-01-21", "2026-01-22"];
const ticker = (symbol: string, figi: string, extra: Record<string, unknown> = {}) => ({
  ticker: symbol,
  share_class_figi: figi,
  type: "CS",
  market: "stocks",
  locale: "us",
  primary_exchange: "XNYS",
  ...extra,
});
const ACTIVE_PAGE = { results: [ticker("AAA", "FIGI-AAA", { active: true }), ticker("RUSE", "FIGI-RUSE-NEW", { active: true, list_date: "2026-01-21" })] };
const INACTIVE_PAGE = {
  results: [
    ticker("GONE", "FIGI-GONE", { active: false, delisted_utc: "2026-01-21T21:00:00Z" }),
    ticker("RUSE", "FIGI-RUSE-OLD", { active: false, delisted_utc: "2026-01-20T21:00:00Z" }),
  ],
};
const TRADED: Record<string, Record<string, number>> = {
  "2026-01-20": { AAA: 10, GONE: 5, RUSE: 7 }, // RUSE here is the old company
  "2026-01-21": { AAA: 11, GONE: 4, RUSE: 30 }, // RUSE here is the new company
  "2026-01-22": { AAA: 12, RUSE: 31 },
};

function provider(): MassiveMarketProvider {
  return new MassiveMarketProvider({
    apiKey: "fixture-key-not-real",
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    now: () => "2026-01-23T00:00:00.000Z",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v3/reference/tickers")
        return new Response(JSON.stringify(url.searchParams.get("active") === "false" ? INACTIVE_PAGE : ACTIVE_PAGE), { status: 200 });
      const day = /\/grouped\/locale\/us\/market\/stocks\/(\d{4}-\d{2}-\d{2})$/u.exec(url.pathname)?.[1];
      if (day) {
        const t = Date.parse(`${day}T21:00:00Z`);
        const results = Object.entries(TRADED[day] ?? {}).map(([T, c]) => ({ T, o: c, h: c, l: c, c, v: 1000, t }));
        return new Response(JSON.stringify({ status: "OK", results }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "OK", results: [] }), { status: 200 });
    },
  });
}

const id = (figi: string) => securityId("massive-stocks", figi, "STOCK");

test("backfill keeps later-delisted names for the sessions they traded and maps a reused ticker point in time", async () => {
  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  const result = await backfillHistoricalEvidence({ root: "/unused", from: DAYS[0]!, to: DAYS[2]!, provider: provider(), storage, env: {} });
  assert.equal(result.stoppedOnError, false);
  const stored = (await storage.loadBars())
    .map((bar) => `${bar.sessionDate}|${bar.securityId}|${bar.close}`)
    .sort();
  const want = [
    `2026-01-20|${id("FIGI-AAA")}|10`,
    `2026-01-20|${id("FIGI-GONE")}|5`,
    `2026-01-20|${id("FIGI-RUSE-OLD")}|7`,
    `2026-01-21|${id("FIGI-AAA")}|11`,
    `2026-01-21|${id("FIGI-GONE")}|4`,
    `2026-01-21|${id("FIGI-RUSE-NEW")}|30`,
    `2026-01-22|${id("FIGI-AAA")}|12`,
    `2026-01-22|${id("FIGI-RUSE-NEW")}|31`,
  ].sort();
  assert.deepEqual(stored, want);
  // The delisting date is kept on the master so later backfills know when a name stopped trading.
  const gone = (await storage.loadSecurities()).find((s) => s.securityId === id("FIGI-GONE"));
  assert.equal(gone?.status, "INACTIVE");
  assert.equal(gone?.delistedAt, "2026-01-21");
  assert.deepEqual(result.survivorship, { inactiveNameSessions: 3, ambiguousSymbolSessions: 0 });
});

const master = (over: Partial<SecurityMasterRecord>): SecurityMasterRecord => ({
  securityId: "sec_x",
  currentSymbol: "X",
  historicalSymbols: [{ symbol: "X", effectiveFrom: "2026-10-02", source: "massive-stocks" }],
  assetType: "STOCK",
  country: "US",
  exchange: "XNYS",
  firstSeenAt: "2026-10-02",
  status: "ACTIVE",
  tradable: true,
  providerIdentities: [{ provider: "massive-stocks", providerSecurityId: "X" }],
  eligibility: "LEVEL_0",
  barCount: 0,
  lastUniverseSeenAt: "2026-10-02",
  ...over,
});

test("symbolOn: listing and delisting bounds, inactive falls back to inactiveAt, renames by history", () => {
  assert.equal(symbolOn(master({ listingDate: "2025-01-02" }), "2025-01-01"), undefined);
  assert.equal(symbolOn(master({ listingDate: "2025-01-02" }), "2025-01-02"), "X");
  const inactive = master({ status: "INACTIVE", delistedAt: "2025-06-30", inactiveAt: "2026-10-02" });
  assert.equal(symbolOn(inactive, "2025-06-30"), "X");
  assert.equal(symbolOn(inactive, "2025-07-01"), undefined);
  assert.equal(symbolOn(master({ status: "INACTIVE", inactiveAt: "2026-10-02" }), "2026-10-02"), "X");
  assert.equal(symbolOn(master({ status: "INACTIVE", inactiveAt: "2026-10-02" }), "2026-10-03"), undefined);
  const renamed = master({
    currentSymbol: "Y",
    historicalSymbols: [
      { symbol: "X", effectiveFrom: "2026-10-02", effectiveTo: "2026-11-01", source: "s" },
      { symbol: "Y", effectiveFrom: "2026-11-01", source: "s" },
    ],
  });
  assert.equal(symbolOn(renamed, "2025-03-03"), "X");
  assert.equal(symbolOn(renamed, "2026-10-31"), "X");
  assert.equal(symbolOn(renamed, "2026-11-01"), "Y");
});

test("pointInTimeUniverse: one active and one inactive on a symbol -> active; two inactive -> ambiguous, dropped", () => {
  const a = master({ securityId: "sec_a", providerIdentities: [{ provider: "p", providerSecurityId: "A" }] });
  const b = master({ securityId: "sec_b", status: "INACTIVE", inactiveAt: "2026-10-02", providerIdentities: [{ provider: "p", providerSecurityId: "B" }] });
  const c = master({ securityId: "sec_c", status: "INACTIVE", inactiveAt: "2026-10-02", currentSymbol: "Z", historicalSymbols: [{ symbol: "Z", effectiveFrom: "2026-10-02", source: "p" }], providerIdentities: [{ provider: "p", providerSecurityId: "C" }] });
  const d = master({ securityId: "sec_d", status: "INACTIVE", inactiveAt: "2026-10-02", currentSymbol: "Z", historicalSymbols: [{ symbol: "Z", effectiveFrom: "2026-10-02", source: "p" }], providerIdentities: [{ provider: "p", providerSecurityId: "D" }] });
  const other = master({ securityId: "sec_o", currentSymbol: "O", providerIdentities: [{ provider: "q", providerSecurityId: "O" }] });
  const pit = pointInTimeUniverse([a, b, c, d, other], "2025-05-05", "p");
  assert.deepEqual([...pit.bySymbol], [["X", "sec_a"]]);
  assert.deepEqual(pit.memberIds, ["sec_a"]);
  assert.equal(pit.ambiguousSymbols, 1);
  assert.equal(pit.inactiveMembers, 0);
  const solo = pointInTimeUniverse([b], "2025-05-05", "p");
  assert.deepEqual(pit.records.map((r) => r.symbol), ["X"]);
  assert.deepEqual(solo.memberIds, ["sec_b"]);
  assert.equal(solo.inactiveMembers, 1);
  assert.equal(solo.records[0]?.active, false);
});
