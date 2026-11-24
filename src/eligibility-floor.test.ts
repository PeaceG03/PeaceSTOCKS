import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { CanonicalDailyBar, CorporateAction, SecurityMasterRecord } from "./contracts";
import { ELIGIBILITY_FLOOR, ELIGIBILITY_FLOOR_FILE, floorExclusion, parseEligibilityFloor, type EligibilityFloor } from "./eligibility-floor";
import { DEFAULT_SCANNER_CONFIG, rankSecurities } from "./ranking";

const floor = ELIGIBILITY_FLOOR;
function days(n: number, last = "2026-11-20"): string[] {
  const out: string[] = [];
  for (const d = new Date(`${last}T00:00:00Z`); out.length < n; d.setUTCDate(d.getUTCDate() - 1))
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
  return out;
}
const bar = (id: string, sessionDate: string, close: number, volume: number) =>
  ({ securityId: id, sessionDate, open: close, high: close, low: close, close, volume, revision: 1, observedAt: "t" }) as unknown as CanonicalDailyBar;
/** n bars ending at the last day, `close` and `volume` per bar index. */
const series = (n: number, close: (k: number) => number, volume: (k: number) => number, id = "a") =>
  days(n).map((d, k) => bar(id, d, close(k), volume(k)));

test("floor config: exactly the fixed rule, strictly parsed", () => {
  assert.deepEqual({ ...floor }, {
    version: "eligibility-floor-v1",
    minLastCloseUsd: 5,
    minMedianDollarVolumeUsd: 5_000_000,
    dollarVolumeSessions: 20,
    minHistorySessions: 60,
  });
  const base = JSON.parse(readFileSync(ELIGIBILITY_FLOOR_FILE, "utf8")) as Record<string, unknown>;
  const bad = (patch: Record<string, unknown>, drop?: string) => {
    const copy = { ...base, ...patch };
    if (drop) delete copy[drop];
    assert.throws(() => parseEligibilityFloor(JSON.stringify(copy)), /ELIGIBILITY_FLOOR_INVALID/u, JSON.stringify(patch));
  };
  bad({ extra: 1 });
  bad({}, "minHistorySessions");
  bad({ minLastCloseUsd: -1 });
  bad({ minLastCloseUsd: "5" });
  bad({ minHistorySessions: 59.5 });
  bad({ dollarVolumeSessions: 0 });
  bad({ version: "v1" });
  assert.throws(() => parseEligibilityFloor("nope"), /NOT_JSON/u);
});

test("floor thresholds: price >= $5, median 20-session dollar volume >= $5M, >= 60 sessions (boundaries inclusive)", () => {
  const ok = (n = 60, price = 5, vol = 1_000_000) => series(n, () => price, () => vol);
  assert.equal(floorExclusion(ok(), floor), undefined); // exactly $5 x 1M = $5M, exactly 60 sessions
  assert.equal(floorExclusion(ok(59), floor), "FLOOR_HISTORY");
  assert.equal(floorExclusion(ok(60, 4.99), floor), "FLOOR_PRICE");
  assert.equal(floorExclusion(ok(60, 5, 999_999), floor), "FLOOR_DOLLAR_VOLUME");
  // Price is the LAST close: an expensive past does not save a name that is now under $5.
  assert.equal(floorExclusion(series(60, (k) => (k < 59 ? 50 : 4.5), () => 10_000_000), floor), "FLOOR_PRICE");
  assert.equal(floorExclusion(series(60, (k) => (k < 59 ? 1 : 6), () => 10_000_000), floor), undefined);
  // Dollar volume is the MEDIAN of the LAST 20 bars: one spike does not pass, old liquidity does not count.
  assert.equal(floorExclusion(series(60, () => 10, (k) => (k === 59 ? 1e12 : 100_000)), floor), "FLOOR_DOLLAR_VOLUME");
  assert.equal(floorExclusion(series(60, () => 10, (k) => (k < 40 ? 1e9 : 100_000)), floor), "FLOOR_DOLLAR_VOLUME");
  assert.equal(floorExclusion(series(60, () => 10, (k) => (k >= 40 && k % 2 === 0 ? 100_000 : 600_000)), floor), "FLOOR_DOLLAR_VOLUME"); // median of 20 = (100k+600k)/2 x $10 = $3.5M
  assert.equal(floorExclusion(series(60, () => 10, (k) => (k >= 40 && k < 49 ? 100_000 : 600_000)), floor), undefined); // 11 of 20 at $6M
  // The thresholds come from the floor passed in.
  const loose: EligibilityFloor = { ...floor, minLastCloseUsd: 1, minMedianDollarVolumeUsd: 1, minHistorySessions: 10 };
  assert.equal(floorExclusion(series(10, () => 2, () => 1), loose), undefined);
  assert.equal(floorExclusion(series(9, () => 2, () => 1), loose), "FLOOR_HISTORY");
});

function security(id: string): SecurityMasterRecord {
  return { securityId: id, currentSymbol: id.toUpperCase(), assetType: "STOCK", status: "ACTIVE", eligibility: "LEVEL_2", barCount: 80 } as unknown as SecurityMasterRecord;
}

test("ranking: names under the floor are in no list and counted by reason; the floor's version is in the fingerprint", () => {
  const n = 80;
  const D = days(n).at(-1)!;
  const liquid = Array.from({ length: 20 }, (_, i) => `liq_${String(i).padStart(2, "0")}`);
  const bars = [
    ...liquid.flatMap((id, i) => series(n, (k) => 20 * (1 + 0.001 * i) ** k, () => 1_000_000, id)),
    // Best momentum of all, but cheap, thin or new: must never be picked.
    ...series(n, (k) => 1 * 1.02 ** k, () => 50_000_000, "cheap"),
    ...series(n, (k) => 20 * 1.02 ** k, () => 1_000, "thin"),
    ...series(30, (k) => 20 * 1.05 ** k, () => 1_000_000, "new"),
  ];
  const securities = [...liquid, "cheap", "thin", "new"].map(security);
  const on = rankSecurities(securities, bars, [], D);
  const reasons = Object.fromEntries((on.floorExcluded ?? []).map((e) => [e.securityId, e.reason]));
  assert.deepEqual(reasons, { cheap: "FLOOR_PRICE", new: "FLOOR_HISTORY", thin: "FLOOR_DOLLAR_VOLUME" }); // cheap ends at ~$4.77
  for (const p of on.predictions) for (const id of ["cheap", "thin", "new"]) assert.equal(p.securityIds.includes(id), false, `${p.setType} ${id}`);
  assert.equal(on.ranked.length, 20);
  const off = rankSecurities(securities, bars, [], D, DEFAULT_SCANNER_CONFIG, [] as CorporateAction[], null);
  assert.equal(off.floorExcluded, undefined);
  const momentumOff = off.predictions.find((p) => p.setType === "STRONGEST_MOMENTUM")!.securityIds;
  for (const id of ["cheap", "thin"]) assert.ok(momentumOff.includes(id), id); // they would be picked without the floor
  assert.notEqual(on.predictions[0]!.configFingerprint, off.predictions[0]!.configFingerprint);
  assert.notEqual(on.predictions[0]!.predictionId, off.predictions[0]!.predictionId);
});

test("scan: the floor applies to the frozen lists and the report counts the names it left out", async () => {
  const { MarketsScanner } = await import("./scanner");
  const { ObjectMarketStorage } = await import("./object-storage");
  const { MemoryObjectClient } = await import("./object-store");
  const { securityId } = await import("./identity");
  const D2 = "2026-10-02";
  const hist = days(70, D2);
  const record = (id: string, symbol: string, assetType: "STOCK" | "ETF" = "STOCK") =>
    ({ provider: "fixture-provider", providerSecurityId: id, symbol, assetType, country: "US", exchange: "NYSE", active: true, tradable: true });
  const ids = { a: securityId("fixture-provider", "i-a", "STOCK"), thin: securityId("fixture-provider", "i-t", "STOCK"), spy: securityId("fixture-provider", "i-spy", "ETF") };
  const mk = (id: string, d: string, close: number, volume: number) =>
    ({ ...bar(id, d, close, volume), provenance: { provider: "fixture-provider", dataset: "daily-ohlcv", retrievalId: `r-${d}-${id.slice(0, 6)}`, ingestionVersion: "t", normalizerVersion: "t" } }) as CanonicalDailyBar;
  const allBars = hist.flatMap((d, k) => [mk(ids.a, d, 20 + k * 0.01, 1_000_000), mk(ids.thin, d, 30 + k * 0.5, 1_000), mk(ids.spy, d, 400 + k, 1_000_000)]);
  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  await storage.initialize();
  await storage.appendBars(allBars.filter((b) => b.sessionDate < D2));
  const provider = {
    providerName: "fixture-provider",
    listApprovedSecurities: async () => [record("i-a", "AAA"), record("i-t", "TTT"), record("i-spy", "SPY", "ETF")],
    getDailyBars: async (day: string, want: string[]) => allBars.filter((b) => b.sessionDate === day && want.includes(b.securityId)),
    getCorporateActions: async () => [],
  };
  const report = await new MarketsScanner(provider as never, storage, undefined, undefined, () => new Date("2026-10-03T05:40:00.000Z")).run(D2, "FORWARD");
  assert.equal(report.predictionStatus, "FROZEN");
  assert.ok((report.skips ?? []).includes("ELIGIBILITY_FLOOR_EXCLUDED:1"), JSON.stringify(report.skips));
  const lists = await storage.loadPredictions(D2);
  assert.ok(lists.length > 0);
  for (const list of lists) assert.equal(list.securityIds.includes(ids.thin), false, list.setType);
  assert.ok(lists.find((l) => l.setType === "TOP_15_OVERALL")!.securityIds.includes(ids.a));
});

test("floor uses the last CLOSE, not the open: fixtures with open != close", () => {
  // Opens on the wrong side of each threshold: the close decides.
  const withOpen = (closeAt: number, openAt: number, volume = 1_000_000) =>
    days(60).map((d) => ({ ...bar("o", d, closeAt, volume), open: openAt, high: Math.max(openAt, closeAt), low: Math.min(openAt, closeAt) }) as CanonicalDailyBar);
  assert.equal(floorExclusion(withOpen(4.99, 6), floor), "FLOOR_PRICE"); // opened above $5, closed under
  assert.equal(floorExclusion(withOpen(5, 4), floor), undefined); // opened under $5, closed at $5
  // Dollar volume is close x volume: $4 open x 1.5M = $6M would pass, $3 close x 1.5M = $4.5M does not.
  assert.equal(floorExclusion(withOpen(3, 4, 1_500_000), { ...floor, minLastCloseUsd: 1 }), "FLOOR_DOLLAR_VOLUME");
  assert.equal(floorExclusion(withOpen(4, 3, 1_500_000), { ...floor, minLastCloseUsd: 1 }), undefined);
});

test("floor uses split-adjusted bars: a split that crosses $5 (ranking end to end)", () => {
  const n = 80;
  const dates = days(n);
  const D = dates.at(-1)!;
  const splitDay = dates[n - 10]!;
  const liquid = Array.from({ length: 5 }, (_, i) => `liq_${i}`);
  // fwd: $12 before a 4-for-1 split, $3 after (now under $5). rev: $2 before a 1-for-4 reverse split, $8 after.
  const fwd = dates.map((d, k) => bar("fwd", d, k < n - 10 ? 12 : 3, k < n - 10 ? 1_000_000 : 4_000_000));
  const rev = dates.map((d, k) => bar("rev", d, k < n - 10 ? 2 : 8, k < n - 10 ? 4_000_000 : 1_000_000));
  const bars = [...liquid.flatMap((id, i) => series(n, (k) => 20 * (1 + 0.001 * i) ** k, () => 1_000_000, id)), ...fwd, ...rev];
  const split = (securityId: string, from: number, to: number) =>
    ({ corporateActionId: `s-${securityId}`, securityId, actionType: from < to ? "SPLIT" : "REVERSE_SPLIT", effectiveDate: splitDay, details: { split_from: from, split_to: to }, observedAt: "t" }) as unknown as CorporateAction;
  const result = rankSecurities([...liquid, "fwd", "rev"].map(security), bars, [], D, DEFAULT_SCANNER_CONFIG, [split("fwd", 1, 4), split("rev", 4, 1)]);
  assert.equal(result.excluded, undefined, JSON.stringify(result.excluded)); // both splits reconcile
  const reasons = Object.fromEntries((result.floorExcluded ?? []).map((e) => [e.securityId, e.reason]));
  assert.deepEqual(reasons, { fwd: "FLOOR_PRICE" });
  assert.ok(result.ranked.some((r) => r.securityId === "rev"), "the reverse-split name is $8 now and liquid");
});
