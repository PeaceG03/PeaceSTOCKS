import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalDailyBar, SecurityMasterRecord } from "./contracts";
import { ELIGIBILITY_FLOOR } from "./eligibility-floor";
import { fingerprint } from "./identity";
import { DEFAULT_SCANNER_CONFIG, rankSecurities, STOCK_LIST_ASSET_TYPE } from "./ranking";
import { resolveSpyBenchmarkId } from "./scanner";

function days(n: number, last = "2026-11-20"): string[] {
  const out: string[] = [];
  for (const d = new Date(`${last}T00:00:00Z`); out.length < n; d.setUTCDate(d.getUTCDate() - 1))
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
  return out;
}
const bar = (id: string, sessionDate: string, close: number) =>
  ({ securityId: id, sessionDate, open: close, high: close, low: close, close, volume: 1_000_000, revision: 1, observedAt: "t" }) as unknown as CanonicalDailyBar;
const sec = (id: string, assetType: string, symbol = id.toUpperCase()) =>
  ({ securityId: id, currentSymbol: symbol, assetType, status: "ACTIVE", eligibility: "LEVEL_3", barCount: 300 }) as unknown as SecurityMasterRecord;

function world() {
  const n = 80;
  const D = days(n).at(-1)!;
  const stocks = Array.from({ length: 20 }, (_, i) => `stk_${String(i).padStart(2, "0")}`);
  const funds = ["etf_hot", "etf_calm", "spy"];
  const bars = [
    ...stocks.flatMap((id, i) => days(n).map((d, k) => bar(id, d, 20 * (1 + 0.001 * i) ** k))),
    // ETFs with the best momentum and the lowest risk: they would top every list if allowed.
    ...days(n).map((d, k) => bar("etf_hot", d, 20 * 1.03 ** k)),
    ...days(n).map((d, k) => bar("etf_calm", d, 100 + k * 0.001)),
    ...days(n).map((d, k) => bar("spy", d, 400 + k)),
  ];
  const securities = [...stocks.map((id) => sec(id, "STOCK")), sec("etf_hot", "ETF"), sec("etf_calm", "ETF"), sec("spy", "ETF", "SPY")];
  return { D, bars, securities, stocks, funds };
}

test("stock lists: ETFs are in no list and no ranking, by the security master's type; SPY stays the benchmark", () => {
  assert.equal(STOCK_LIST_ASSET_TYPE, "STOCK");
  const w = world();
  const spyId = resolveSpyBenchmarkId(w.securities);
  assert.equal(spyId, "spy");
  const benchmark = w.bars.filter((b) => b.securityId === spyId);
  for (const floor of [undefined, null] as const) {
    const r = floor === undefined
      ? rankSecurities(w.securities, w.bars, benchmark, w.D)
      : rankSecurities(w.securities, w.bars, benchmark, w.D, DEFAULT_SCANNER_CONFIG, [], null);
    assert.equal(r.nonStockExcluded, 3);
    assert.deepEqual(r.ranked.map((x) => x.securityId).sort(), w.stocks);
    for (const p of r.predictions) for (const id of w.funds) assert.equal(p.securityIds.includes(id), false, `${p.setType} ${id}`);
    assert.ok(r.predictions.every((p) => p.securityIds.length > 0));
    // Relative strength is still computed against SPY.
    for (const b of r.beliefs)
      if (w.funds.includes(b.securityId)) assert.equal(b.meaningfulDecision, "NOT_ELIGIBLE", b.securityId);
      else assert.equal(typeof b.familyScores.relativeStrength, "number", b.securityId);
  }
  // The same world with the ETFs typed as stocks would put them in the lists (the filter is what keeps them out).
  const asStocks = w.securities.map((s) => (s.securityId.startsWith("etf_") ? { ...s, assetType: "STOCK" as const } : s));
  const leak = rankSecurities(asStocks, w.bars, benchmark, w.D, DEFAULT_SCANNER_CONFIG, [], null);
  assert.ok(leak.predictions.some((p) => p.securityIds.includes("etf_hot") || p.securityIds.includes("etf_calm")));
  assert.equal(leak.nonStockExcluded, 1); // only SPY left
});

test("stock lists: an unknown or missing type is not a stock either", () => {
  const w = world();
  const odd = w.securities.map((s) => (s.securityId === "stk_00" ? ({ ...s, assetType: "FUND" } as unknown as SecurityMasterRecord) : s.securityId === "stk_01" ? ({ ...s, assetType: undefined } as unknown as SecurityMasterRecord) : s));
  const r = rankSecurities(odd, w.bars, [], w.D, DEFAULT_SCANNER_CONFIG, [], null);
  assert.equal(r.nonStockExcluded, 5);
  assert.equal(r.ranked.some((x) => x.securityId === "stk_00" || x.securityId === "stk_01"), false);
  // Inactive names were never candidates and are not counted as non-stock exclusions.
  const inactive = w.securities.map((s) => (s.securityId === "etf_hot" ? ({ ...s, status: "INACTIVE" } as SecurityMasterRecord) : s));
  assert.equal(rankSecurities(inactive, w.bars, [], w.D, DEFAULT_SCANNER_CONFIG, [], null).nonStockExcluded, 2);
});

test("stock lists: the production fingerprint names the stocks-only rule", () => {
  const w = world();
  const on = rankSecurities(w.securities, w.bars, [], w.D);
  assert.equal(
    on.predictions[0]!.configFingerprint,
    fingerprint({ ...DEFAULT_SCANNER_CONFIG, eligibilityFloor: ELIGIBILITY_FLOOR.version, listAssetType: "STOCK" }),
  );
});
