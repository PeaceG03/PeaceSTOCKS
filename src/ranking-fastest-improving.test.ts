// FASTEST_IMPROVING used to be a copy of TOP_15_OVERALL (ranking.ts: rankedIds.slice(0, 15)).
// It is now its own list: the largest rise in 20-session return versus the 20 sessions before
// (needs 41 closes). With too little history the list is empty and marked unavailable, never
// filled from the overall ranking.
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalDailyBar, SecurityMasterRecord } from "./contracts";
import { sha256, stableJson } from "./identity";
import { rankSecurities } from "./ranking";

const FASTEST_IMPROVING_RECIPE = "fastest-improving-return20-delta-v1";
const IMPROVEMENT_MIN_CLOSES = 41;

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
function bar(id: string, date: string, close: number): CanonicalDailyBar {
  return { securityId: id, sessionDate: date, open: close, high: close, low: close, close, volume: 100_000, revision: 1,
    observedAt: "t", ingestedAt: "t", dataQuality: "GOOD", corporateActionIds: [], flags: [], schemaVersion: "x",
    provenance: { provider: "p", dataset: "d", retrievalId: "r", ingestionVersion: "v", normalizerVersion: "n" } } as unknown as CanonicalDailyBar;
}

/**
 * 40 securities, 80 sessions. "lead_*" rise steadily all window (top overall, flat improvement);
 * "turn_*" fall for the first 60 sessions and rise in the last 20 (low overall, big improvement).
 */
function divergent(nDays = 80) {
  const days = sessions(nDays);
  const securities: SecurityMasterRecord[] = [];
  const bars: CanonicalDailyBar[] = [];
  const path = (id: string, step: (d: number) => number) => {
    securities.push(security(id));
    let price = 50;
    days.forEach((day, d) => {
      price *= 1 + step(d);
      bars.push(bar(id, day, Number(price.toFixed(6))));
    });
  };
  for (let i = 0; i < 20; i++) path(`lead_${String(i).padStart(2, "0")}`, () => 0.01 + i * 0.0002);
  for (let i = 0; i < 20; i++) path(`turn_${String(i).padStart(2, "0")}`, (d) => (d < nDays - 20 ? -0.006 : 0.004 + i * 0.0002));
  return { securities, bars, D: days.at(-1)! };
}

/** Reference: closes oldest first; improvement = r(t-20 -> t) - r(t-40 -> t-20). */
function improvement(closes: number[]): number | null {
  if (closes.length < 41) return null;
  const c = (k: number) => closes[closes.length - 1 - k]!;
  return c(0) / c(20) - 1 - (c(20) / c(40) - 1);
}

type Listed = ReturnType<typeof rankSecurities>["predictions"][number] & { recipeVersion?: string; unavailableReason?: string };
const set = (result: ReturnType<typeof rankSecurities>, type: string) => result.predictions.find((p) => p.setType === type)! as Listed;

test("FASTEST_IMPROVING differs from TOP_15_OVERALL when improvement differs from overall rank", () => {
  const { securities, bars, D } = divergent();
  const result = rankSecurities(securities, bars, [], D);
  const top = set(result, "TOP_15_OVERALL");
  const fast = set(result, "FASTEST_IMPROVING");
  assert.notDeepEqual(fast.securityIds, top.securityIds);
  assert.ok(top.securityIds.every((id) => id.startsWith("lead_")), "overall leaders are the steady risers");
  // Exactly the top 15 by the reference improvement value, ties by id.
  const expected = securities
    .map((s) => ({ id: s.securityId, v: improvement(bars.filter((b) => b.securityId === s.securityId).map((b) => b.close))! }))
    .sort((a, b) => b.v - a.v || a.id.localeCompare(b.id))
    .slice(0, 15)
    .map((x) => x.id);
  assert.deepEqual(fast.securityIds, expected);
  assert.ok(fast.securityIds.every((id) => id.startsWith("turn_")));
  assert.equal(fast.recipeVersion, FASTEST_IMPROVING_RECIPE);
  assert.equal(fast.unavailableReason, undefined);
  assert.notEqual(fast.predictionId, top.predictionId);
});

test("with too little history FASTEST_IMPROVING is empty and marked unavailable, not copied from overall", () => {
  const { securities, bars, D } = divergent(IMPROVEMENT_MIN_CLOSES - 1);
  const result = rankSecurities(securities, bars, [], D);
  assert.equal(set(result, "TOP_15_OVERALL").securityIds.length, 15);
  const fast = set(result, "FASTEST_IMPROVING");
  assert.deepEqual(fast.securityIds, []);
  assert.equal(fast.unavailableReason, "INSUFFICIENT_HISTORY");
});

test("names without 41 closes are left out of FASTEST_IMPROVING; the rest still rank", () => {
  const { securities, bars, D } = divergent();
  const short = new Set(["turn_19", "turn_18"]);
  const days = [...new Set(bars.map((b) => b.sessionDate))].sort();
  const cut = days.at(-40)!;
  const trimmed = bars.filter((b) => !short.has(b.securityId) || b.sessionDate >= cut); // 40 closes
  const fast = set(rankSecurities(securities, trimmed, [], D), "FASTEST_IMPROVING");
  assert.equal(fast.securityIds.length, 15);
  assert.ok(fast.securityIds.every((id) => !short.has(id)));
});

test("the other four lists, beliefs and rankings are unchanged by the FASTEST_IMPROVING fix", () => {
  // Same seeded dataset as ranking-grouped.test.ts; digest of everything except FASTEST_IMPROVING,
  // recorded from the pre-fix code (main 733cac54).
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  }
  const LEVELS = ["LEVEL_0", "LEVEL_1", "LEVEL_2", "LEVEL_3"] as const;
  const r = rng(7);
  const days = sessions(113);
  const D = days[109]!;
  const securities: SecurityMasterRecord[] = [];
  const bars: CanonicalDailyBar[] = [];
  for (let i = 0; i < 400; i++) {
    const id = `sec_${String(i).padStart(6, "0")}`;
    securities.push({ ...security(id), currentSymbol: id.slice(-4), status: r() < 0.9 ? "ACTIVE" : "INACTIVE", eligibility: LEVELS[Math.floor(r() * 4)]! } as unknown as SecurityMasterRecord);
    const gapRate = r() * 0.5;
    let price = 10 + r() * 90;
    for (const day of days) {
      if (r() < gapRate) continue;
      price *= 1 + (r() - 0.5) * 0.08;
      const volume = Math.floor(1_000 + r() * 1e6);
      const mk = (close: number, revision: number, tag: string) =>
        ({ ...bar(id, day, close), high: close * 1.01, low: close * 0.99, volume, revision, observedAt: tag, ingestedAt: tag,
          provenance: { provider: "p", dataset: "d", retrievalId: tag, ingestionVersion: "v", normalizerVersion: "n" } }) as unknown as CanonicalDailyBar;
      bars.push(mk(Number(price.toFixed(4)), 1, `a${i}`));
      const roll = r();
      if (roll < 0.05) bars.push(mk(Number((price * 1.02).toFixed(4)), 2, `b${i}`));
      else if (roll < 0.08) bars.push(mk(Number((price * 0.97).toFixed(4)), 1, `tie${i}`));
    }
  }
  for (let i = bars.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [bars[i], bars[j]] = [bars[j]!, bars[i]!];
  }
  const result = rankSecurities(securities, bars, bars.filter((b) => b.securityId === securities[0]!.securityId), D);
  const other = { ...result, predictions: result.predictions.filter((p) => p.setType !== "FASTEST_IMPROVING") };
  assert.equal(sha256(stableJson(other)), "786c59c31117d8b467c226e0a81ab4829eefd8ec698156914ea7abfd07cd95dc");
});
