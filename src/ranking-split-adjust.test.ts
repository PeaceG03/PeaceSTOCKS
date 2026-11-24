// Features and ranking must use split-adjusted closes. The stored bars are UNADJUSTED, so a 1-for-10
// reverse split looked like a 10x gain and topped the momentum and improving lists. A recorded
// SPLIT / REVERSE_SPLIT now rescales the bars before it; a split that the prices do not reconcile
// with, or a split-sized jump with no recorded split, drops the name from the ranking.
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalDailyBar, CorporateAction, SecurityMasterRecord } from "./contracts";
import { reconstructFeatures } from "./features";
import { MarketStorage } from "./storage";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ranking from "./ranking";

const { DEFAULT_SCANNER_CONFIG } = ranking;
// The new 6th argument (split actions) is passed loosely so this file also runs against the old code.
const rank = ranking.rankSecurities as unknown as (
  s: SecurityMasterRecord[], b: CanonicalDailyBar[], m: CanonicalDailyBar[], d: string, c: typeof DEFAULT_SCANNER_CONFIG, a: CorporateAction[],
) => ReturnType<typeof ranking.rankSecurities> & { excluded?: Array<{ securityId: string; reason: string }> };

function sessions(n: number, last = "2026-11-20"): string[] {
  const out: string[] = [];
  for (let d = new Date(`${last}T00:00:00Z`); out.length < n; d.setUTCDate(d.getUTCDate() - 1))
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
  return out;
}
function security(id: string): SecurityMasterRecord {
  return { securityId: id, currentSymbol: id, historicalSymbols: [], assetType: "STOCK", country: "US", exchange: "XNYS",
    firstSeenAt: "2026-01-01", status: "ACTIVE", tradable: true, providerIdentities: [], eligibility: "LEVEL_2",
    barCount: 0, lastUniverseSeenAt: "2026-11-20" } as unknown as SecurityMasterRecord;
}
function bar(id: string, date: string, close: number, volume = 100_000): CanonicalDailyBar {
  return { securityId: id, sessionDate: date, open: close, high: close, low: close, close, volume, revision: 1,
    observedAt: "t", ingestedAt: "t", dataQuality: "GOOD", corporateActionIds: [], flags: ["UNADJUSTED"], schemaVersion: "x",
    provenance: { provider: "p", dataset: "d", retrievalId: "r", ingestionVersion: "v", normalizerVersion: "n" } } as unknown as CanonicalDailyBar;
}
function split(id: string, effectiveDate: string, from: number, to: number): CorporateAction {
  return { actionId: `a_${id}_${effectiveDate}`, securityId: id, actionType: from > to ? "REVERSE_SPLIT" : "SPLIT", effectiveDate,
    details: { split_from: from, split_to: to }, observedAt: "t",
    provenance: { provider: "p", dataset: "stocks-splits", retrievalId: "r", ingestionVersion: "v", normalizerVersion: "n" } } as unknown as CorporateAction;
}

const days = sessions(80);
const D = days.at(-1)!;
const SPLIT_DAY = days[60]!;

/** 20 names gently drifting up; "rs" drifts down 0.3%/day and has a 1-for-10 reverse split on SPLIT_DAY. */
function world(rsFactor = 10, mutate?: (id: string, k: number, close: number) => number) {
  const securities: SecurityMasterRecord[] = [];
  const bars: CanonicalDailyBar[] = [];
  const add = (id: string, step: number, accel = 0) => {
    securities.push(security(id));
    let price = 5;
    days.forEach((day, k) => {
      price *= 1 + step + accel * k;
      const raw = id === "rs" && k >= 60 ? price * rsFactor : price;
      bars.push(bar(id, day, Number((mutate ? mutate(id, k, raw) : raw).toFixed(6))));
    });
  };
  // The risers also speed up a little, so their improvement is positive while the split name's is ~0.
  for (let i = 0; i < 20; i++) add(`up_${String(i).padStart(2, "0")}`, 0.001 + i * 0.0001, 0.00002);
  add("rs", -0.003);
  return { securities, bars };
}
const set = (r: ReturnType<typeof rank>, t: string) => r.predictions.find((p) => p.setType === t)!.securityIds;

test("a recorded 1-for-10 reverse split is adjusted out: no fake 10x gain, not picked for momentum or improving", () => {
  const { securities, bars } = world();
  const result = rank(securities, bars, [], D, DEFAULT_SCANNER_CONFIG, [split("rs", SPLIT_DAY, 10, 1)]);
  const rs = result.ranked.find((r) => r.securityId === "rs");
  assert.ok(rs, "the adjusted name is still ranked");
  // Adjusted 60-session return of a -0.3%/day drift, not ~+900%.
  const expected = (1 - 0.003) ** 60 - 1;
  assert.ok(Math.abs(rs.features.values.MOMENTUM_60D! - expected) < 1e-4, `momentum ${rs.features.values.MOMENTUM_60D}`);
  assert.ok(rs.features.values.RETURN_20D! < 0);
  for (const t of ["STRONGEST_MOMENTUM", "FASTEST_IMPROVING"]) assert.equal(set(result, t).includes("rs"), false, t);
  // Its momentum and trend family scores are the lowest of all names (they were the highest unadjusted).
  assert.equal(rs.familyScores.momentum, 0);
  assert.equal(rs.familyScores.trend, 0);
  // Dollar volume is unchanged by the adjustment (prices x10, volume /10 before the split).
  const raw = reconstructFeatures("rs", D, bars.filter((b) => b.securityId === "rs"));
  assert.ok(Math.abs(rs.features.values.AVG_DOLLAR_VOLUME_20D! - raw.values.AVG_DOLLAR_VOLUME_20D!) < 1e-6);
});

test("a forward 2-for-1 split is adjusted the other way", () => {
  const { securities, bars } = world(0.5);
  const result = rank(securities, bars, [], D, DEFAULT_SCANNER_CONFIG, [split("rs", SPLIT_DAY, 1, 2)]);
  const rs = result.ranked.find((r) => r.securityId === "rs")!;
  assert.ok(Math.abs(rs.features.values.MOMENTUM_60D! - ((1 - 0.003) ** 60 - 1)) < 1e-4);
});

test("a split the prices do not reconcile with drops the name (no guess)", () => {
  const { securities, bars } = world(3); // prices jumped 3x, the record says 10x
  const result = rank(securities, bars, [], D, DEFAULT_SCANNER_CONFIG, [split("rs", SPLIT_DAY, 10, 1)]);
  assert.equal(result.ranked.some((r) => r.securityId === "rs"), false);
  assert.deepEqual(result.excluded, [{ securityId: "rs", reason: "SPLIT_UNRECONCILED" }]);
  for (const p of result.predictions) assert.equal(p.securityIds.includes("rs"), false);
});

test("a split-sized jump with no recorded split drops the name", () => {
  const { securities, bars } = world();
  const result = rank(securities, bars, [], D, DEFAULT_SCANNER_CONFIG, []);
  assert.equal(result.ranked.some((r) => r.securityId === "rs"), false);
  assert.deepEqual(result.excluded, [{ securityId: "rs", reason: "PRICE_GAP_UNEXPLAINED" }]);
});

test("a split after the scanned session is not used (no look-ahead), and old splits before the window are harmless", () => {
  const { securities, bars } = world(1); // no jump in prices
  const after = rank(securities, bars, [], D, DEFAULT_SCANNER_CONFIG, [split("rs", "2026-11-23", 10, 1), split("up_00", "2020-01-02", 10, 1)]);
  const plain = rank(securities, bars, [], D, DEFAULT_SCANNER_CONFIG, []);
  assert.deepEqual(after.predictions, plain.predictions);
  assert.deepEqual(after.ranked, plain.ranked);
  assert.equal(after.excluded, undefined);
});

test("storage: loadSplitActions returns only SPLIT and REVERSE_SPLIT records", async () => {
  const root = await mkdtemp(join(tmpdir(), "split-actions-"));
  try {
    const storage = new MarketStorage(root);
    const dividend = { ...split("x", "2026-01-02", 1, 1), actionId: "div", actionType: "DIVIDEND" } as CorporateAction;
    await storage.appendActions([split("rs", SPLIT_DAY, 10, 1), dividend, split("y", "2026-02-02", 1, 2)]);
    const got = await (storage as unknown as { loadSplitActions(): Promise<CorporateAction[]> }).loadSplitActions();
    assert.deepEqual(got.map((a) => a.actionType).sort(), ["REVERSE_SPLIT", "SPLIT"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the scan loads the stored split records: an unreconcilable split keeps the name out of the frozen lists", async () => {
  const { MarketsScanner } = await import("./scanner");
  const { ObjectMarketStorage } = await import("./object-storage");
  const { MemoryObjectClient } = await import("./object-store");
  const { securityId } = await import("./identity");
  const D2 = "2026-10-02";
  const hist = sessions(70, D2);
  const record = (id: string, symbol: string, assetType: "STOCK" | "ETF" = "STOCK") =>
    ({ provider: "fixture-provider", providerSecurityId: id, symbol, assetType, country: "US", exchange: "NYSE", active: true, tradable: true });
  const ids = { a: securityId("fixture-provider", "i-a", "STOCK"), b: securityId("fixture-provider", "i-b", "STOCK"), spy: securityId("fixture-provider", "i-spy", "ETF") };
  const mk = (id: string, d: string, close: number) => ({ ...bar(id, d, close), provenance: { provider: "fixture-provider", dataset: "daily-ohlcv", retrievalId: `r-${d}-${id.slice(0, 6)}`, ingestionVersion: "t", normalizerVersion: "t" } }) as CanonicalDailyBar;
  const allBars = hist.flatMap((d, k) => [mk(ids.a, d, 20 + k * 0.01), mk(ids.b, d, 30 + k * 0.02), mk(ids.spy, d, 400 + k)]);
  const run = async (actions: CorporateAction[], splitReadFails = false) => {
    const storage = new ObjectMarketStorage(new MemoryObjectClient());
    if (splitReadFails)
      (storage as unknown as { loadSplitActions(): Promise<CorporateAction[]> }).loadSplitActions = async () => {
        throw new Error("split records unreadable");
      };
    await storage.initialize();
    await storage.appendBars(allBars.filter((b) => b.sessionDate < D2));
    await storage.appendActions(actions);
    const provider = {
      providerName: "fixture-provider",
      listApprovedSecurities: async () => [record("i-a", "AAA"), record("i-b", "BBB"), record("i-spy", "SPY", "ETF")],
      getDailyBars: async (day: string, want: string[]) => allBars.filter((b) => b.sessionDate === day && want.includes(b.securityId)),
      getCorporateActions: async () => [],
    };
    const report = await new MarketsScanner(provider as never, storage, undefined, undefined, () => new Date("2026-10-03T05:40:00.000Z")).run(D2, "FORWARD");
    const status = (await storage.loadPredictionStatuses(D2)).at(-1);
    return { report, status, top: (await storage.loadPredictions(D2)).find((p) => p.setType === "TOP_15_OVERALL")?.securityIds ?? [] };
  };
  const plain = await run([]);
  assert.ok(plain.top.includes(ids.a));
  assert.equal((plain.report.skips ?? []).some((s) => s.startsWith("SPLIT_ADJUST_EXCLUDED")), false);
  // Recorded 1-for-10 reverse split, but the prices never moved: cannot be reconciled.
  const bad = await run([split(ids.a, hist[50]!, 10, 1)]);
  assert.equal(bad.report.predictionStatus, "FROZEN");
  assert.equal(bad.top.includes(ids.a), false);
  assert.ok(bad.top.includes(ids.b));
  assert.ok((bad.report.skips ?? []).includes("SPLIT_ADJUST_EXCLUDED:1"));
  // Split records cannot be read: reported, and nothing is frozen (a source failure).
  const unread = await run([], true);
  assert.ok((unread.report.unresolvedFailures ?? []).some((f) => f.startsWith("SPLIT_ACTIONS_READ_FAILED:")), JSON.stringify(unread.report.unresolvedFailures));
  assert.equal(unread.report.predictionStatus, "UNAVAILABLE");
  assert.equal(unread.report.predictionReason, "SOURCE_COLLECTION_FAILED");
  assert.equal(unread.status?.status, "UNAVAILABLE");
  assert.equal(unread.status?.reason, "SOURCE_COLLECTION_FAILED");
  assert.deepEqual(unread.top, []);
});

test("bars before the split: prices x factor, volume / factor (dollar volume kept); bars on/after untouched", async () => {
  const { splitAdjustedBars } = await import("./split-adjust");
  const b = [bar("z", "2026-11-16", 1, 1000), bar("z", "2026-11-17", 1.1, 2000), bar("z", "2026-11-18", 10.5, 300), bar("z", "2026-11-19", 10, 400)];
  const got = splitAdjustedBars(b, [{ effectiveDate: "2026-11-18", factor: 10 }], "2026-11-19");
  assert.ok("bars" in got);
  assert.deepEqual(got.bars.map((x) => [x.close, x.volume]), [[10, 100], [11, 200], [10.5, 300], [10, 400]]);
  assert.equal(got.bars[2], b[2]);
});

test("two different split factors recorded for one name on the same date: excluded, never multiplied", () => {
  // Synthetic version of a real case: a 1-for-10 reverse and a 2-for-1 forward, both effective the same day.
  // Raw prices jump exactly 5x, so multiplying the two factors (10 x 0.5) would "reconcile" perfectly.
  const { securities, bars } = world(5);
  const result = rank(securities, bars, [], D, DEFAULT_SCANNER_CONFIG, [
    split("rs", SPLIT_DAY, 10, 1),
    { ...split("rs", SPLIT_DAY, 1, 2), actionId: "a_rs_second" },
  ]);
  assert.equal(result.ranked.some((r) => r.securityId === "rs"), false);
  assert.deepEqual(result.excluded, [{ securityId: "rs", reason: "SPLIT_UNRECONCILED" }]);
  // The same factor recorded twice (two ids) is one split, not a conflict.
  const dup = rank(securities, world(10).bars, [], D, DEFAULT_SCANNER_CONFIG, [split("rs", SPLIT_DAY, 10, 1), { ...split("rs", SPLIT_DAY, 10, 1), actionId: "dup" }]);
  assert.ok(dup.ranked.some((r) => r.securityId === "rs"));
});

/** n flat daily bars for "z" (close 10), with the close multiplied by `ratio` from bar `at` on (held). */
function flatBars(n: number, at: number, ratio: number): CanonicalDailyBar[] {
  const ds = sessions(n);
  return ds.map((d, k) => bar("z", d, k >= at ? 10 * ratio : 10));
}

test("two splits in one window are both applied (each to the bars before its own date)", async () => {
  const { splitAdjustedBars } = await import("./split-adjust");
  const ds = sessions(30);
  // 1-for-10 reverse at bar 5, then 2-for-1 forward at bar 9: raw 1 -> 10 -> 5.
  const b = ds.map((d, k) => bar("z", d, k < 5 ? 1 : k < 9 ? 10 : 5));
  const got = splitAdjustedBars(b, [{ effectiveDate: ds[5]!, factor: 10 }, { effectiveDate: ds[9]!, factor: 0.5 }], ds.at(-1)!);
  assert.ok("bars" in got, JSON.stringify(got));
  // Fully adjusted to today's share basis: every close is 5.
  for (const x of got.bars) assert.ok(Math.abs(x.close - 5) < 1e-9, String(x.close));
  assert.ok(Math.abs(got.bars[0]!.volume - 100_000 / 5) < 1e-6);
});

test("a split record with no usable factor excludes the name (not ignored)", () => {
  const { securities, bars } = world(1); // prices never moved, so ignoring the record would rank the name
  for (const bad of [split("rs", SPLIT_DAY, 10, 0), { ...split("rs", SPLIT_DAY, 1, 1), details: {} } as CorporateAction]) {
    const result = rank(securities, bars, [], D, DEFAULT_SCANNER_CONFIG, [bad]);
    assert.equal(result.ranked.some((r) => r.securityId === "rs"), false);
    assert.deepEqual(result.excluded, [{ securityId: "rs", reason: "SPLIT_UNRECONCILED" }]);
  }
});

test("the unexplained-gap rule fires downward too (a drop to 1/3 or below)", () => {
  const { securities, bars } = world(0.25); // a 4-for-1-sized drop with no split recorded
  const result = rank(securities, bars, [], D, DEFAULT_SCANNER_CONFIG, []);
  assert.equal(result.ranked.some((r) => r.securityId === "rs"), false);
  assert.deepEqual(result.excluded, [{ securityId: "rs", reason: "PRICE_GAP_UNEXPLAINED" }]);
});

test("the unexplained-gap boundary is 3x: 3x and 3.5x either way are excluded", async () => {
  const { splitAdjustedBars } = await import("./split-adjust");
  for (const ratio of [3, 3.5, 1 / 3, 1 / 3.5]) {
    const got = splitAdjustedBars(flatBars(40, 5, ratio), [], sessions(40).at(-1)!);
    assert.deepEqual(got, { excluded: "PRICE_GAP_UNEXPLAINED" }, `ratio ${ratio}`);
  }
  // Just inside the boundary (an old move, outside any recent-session check) is kept.
  assert.ok("bars" in splitAdjustedBars(flatBars(40, 5, 2.9), [], sessions(40).at(-1)!));
});

test("two split dates with no bar between them are excluded, not combined", async () => {
  const { splitAdjustedBars } = await import("./split-adjust");
  const ds = sessions(30);
  // The name has no bar on ds[5]; records on ds[5] (1-for-10) and ds[6] (2-for-1) both land on bar ds[6].
  const b = ds.filter((_, k) => k !== 5).map((d) => bar("z", d, d < ds[5]! ? 1 : 5));
  const got = splitAdjustedBars(b, [{ effectiveDate: ds[5]!, factor: 10 }, { effectiveDate: ds[6]!, factor: 0.5 }], ds.at(-1)!);
  assert.deepEqual(got, { excluded: "SPLIT_UNRECONCILED" });
});
