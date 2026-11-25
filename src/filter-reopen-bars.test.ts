import assert from "node:assert/strict";
import test from "node:test";
import { filterReopenBars } from "./backfill";
import type { CanonicalDailyBar, SecurityMasterRecord } from "./contracts";
import { MARKET_SCHEMA_VERSION } from "./contracts";

function rec(overrides: Partial<SecurityMasterRecord> & { securityId: string; currentSymbol: string; status: "ACTIVE" | "INACTIVE" }): SecurityMasterRecord {
  return {
    historicalSymbols: [],
    providerIdentities: [{ provider: "massive-stocks", providerSecurityId: `figi:${overrides.securityId}` }],
    assetType: "STOCK",
    country: "US",
    exchange: "XNAS",
    tradable: overrides.status === "ACTIVE",
    eligibility: "LEVEL_3",
    barCount: 0,
    firstSeenAt: "2024-10-11",
    lastUniverseSeenAt: "2026-11-25",
    ...(overrides.status === "INACTIVE" ? { inactiveAt: "2026-10-15" } : {}),
    ...overrides,
  };
}

function bar(securityId: string, sessionDate: string, close = 10): CanonicalDailyBar {
  return {
    securityId,
    sessionDate,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    observedAt: `${sessionDate}T21:00:00Z`,
    ingestedAt: `${sessionDate}T21:05:00Z`,
    dataQuality: "GOOD",
    corporateActionIds: [],
    flags: [],
    schemaVersion: MARKET_SCHEMA_VERSION,
    revision: 1,
    provenance: { provider: "massive-stocks", dataset: "stocks-grouped-daily", retrievalId: `g-${sessionDate}`, ingestionVersion: "v0", normalizerVersion: "v0" },
  };
}

test("filterReopenBars: a same-ticker existing row on a different sessionDate must not skip", () => {
  const owner = rec({
    securityId: "sec_old",
    currentSymbol: "REU",
    status: "INACTIVE",
    inactiveAt: "2026-10-14",
    historicalSymbols: [{ symbol: "REU", effectiveFrom: "2024-01-01", source: "massive-stocks" }],
  });
  const later = rec({
    securityId: "sec_new",
    currentSymbol: "REU",
    status: "INACTIVE",
    inactiveAt: "2026-11-01",
    listingDate: "2026-10-15",
    historicalSymbols: [{ symbol: "REU", effectiveFrom: "2026-10-15", source: "massive-stocks" }],
  });
  const candidate = bar("sec_new", "2026-10-15", 21.5);
  const sameSession = filterReopenBars([candidate], [bar("sec_old", "2026-10-15", 20.5)], [owner, later], "2026-10-15");
  assert.equal(sameSession.newBars.length, 0);
  assert.equal(sameSession.skippedCollisionByStatus.INACTIVE, 1);

  const otherSession = filterReopenBars([candidate], [bar("sec_old", "2026-10-14", 20.5)], [owner, later], "2026-10-15");
  assert.equal(otherSession.skippedCollisionByStatus.INACTIVE ?? 0, 0);
  assert.equal(otherSession.newBars.length, 1);
  assert.equal(otherSession.newBars[0]!.securityId, "sec_new");
  assert.equal(otherSession.newBars[0]!.sessionDate, "2026-10-15");
});
