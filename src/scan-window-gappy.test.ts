// The scan's bar window must reach 61 of a security's OWN closes (MOMENTUM_60D / DRAWDOWN_60D) even
// when the security skipped sessions: thin names miss days in grouped daily.
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalDailyBar, SecurityMasterRecord } from "./contracts";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { DEFAULT_SCANNER_CONFIG, rankSecurities as rankWithFloor } from "./ranking";
// These tests are about ranking mechanics, not the eligibility floor (own tests in eligibility-floor.test.ts):
// their small cheap fixtures run with the floor off.
const rankSecurities = (...a: Parameters<typeof rankWithFloor>) => rankWithFloor(a[0], a[1], a[2], a[3], a[4] ?? DEFAULT_SCANNER_CONFIG, a[5] ?? [], null);
import { SCAN_BAR_LOOKBACK_SESSIONS, scanBarWindowStart } from "./scanner";
import { US_EQUITY_MARKET_CALENDAR as CAL } from "./us-calendar";

const D = "2026-11-20";
function sessionsEndingAt(last: string, n: number): string[] {
  const out: string[] = [];
  for (const d = new Date(`${last}T00:00:00Z`); out.length < n; d.setUTCDate(d.getUTCDate() - 1)) {
    const day = d.toISOString().slice(0, 10);
    const kind = CAL.getSession(day).kind;
    if (kind === "NORMAL" || kind === "HALF_DAY") out.unshift(day);
  }
  return out;
}
const bar = (id: string, date: string, i: number): CanonicalDailyBar =>
  ({ securityId: id, sessionDate: date, open: 10, high: 11, low: 9, close: 10 + (i % 9) / 4, volume: 1000 + i,
    revision: 1, observedAt: "2026-11-21T00:00:00.000Z", ingestedAt: "2026-11-21T00:00:00.000Z", dataQuality: "GOOD",
    corporateActionIds: [], flags: [], schemaVersion: "x",
    provenance: { provider: "p", dataset: "d", retrievalId: "r", ingestionVersion: "v", normalizerVersion: "n" } }) as unknown as CanonicalDailyBar;
const security = (id: string) =>
  ({ securityId: id, currentSymbol: id, historicalSymbols: [], assetType: "STOCK", country: "US", exchange: "XNYS",
    firstSeenAt: "2025-01-01", status: "ACTIVE", tradable: true, providerIdentities: [], eligibility: "LEVEL_2",
    barCount: 100, lastUniverseSeenAt: D }) as unknown as SecurityMasterRecord;

test("a security missing 35 sessions of the window still gets 60-day momentum and drawdown", async () => {
  const all = sessionsEndingAt(D, 140);
  const recent = all.slice(-70);
  const missing = new Set(recent.filter((_, i) => i % 2 === 1)); // 35 of the newest 70 sessions skipped
  assert.equal(missing.size, 35);
  const bars: CanonicalDailyBar[] = [];
  all.forEach((day, i) => {
    bars.push(bar("sec_full", day, i));
    if (!missing.has(day)) bars.push(bar("sec_gappy", day, i));
  });
  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  await storage.appendBars(bars);
  // Same load the scan does (scanner.ts: loadBarsBetween(scanBarWindowStart(D), D)).
  const window = await storage.loadBarsBetween(scanBarWindowStart(D, CAL), D);
  const own = window.filter((b) => b.securityId === "sec_gappy").length;
  assert.ok(own >= 61, `sec_gappy has ${own} bars in the ${SCAN_BAR_LOOKBACK_SESSIONS}-session window`);
  const { ranked } = rankSecurities([security("sec_full"), security("sec_gappy")], window, [], D);
  const gappy = ranked.find((r) => r.securityId === "sec_gappy")!;
  assert.notEqual(gappy.features.values.MOMENTUM_60D, null);
  assert.notEqual(gappy.features.values.DRAWDOWN_60D, null);
});

test("window is 100 sessions: 61 own closes with up to 39 sessions missing", () => {
  assert.equal(SCAN_BAR_LOOKBACK_SESSIONS, 100);
  assert.equal(sessionsEndingAt(D, 100)[0], scanBarWindowStart(D, CAL));
});
