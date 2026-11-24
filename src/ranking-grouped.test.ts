// rankSecurities groups bars by security once. Output must stay byte-identical to the old
// per-security filter, and the work must grow with bars, not securities x bars.
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalDailyBar, SecurityMasterRecord } from "./contracts";
import { reconstructFeatures } from "./features";
import { sha256, stableJson } from "./identity";
import { rankSecurities } from "./ranking";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function sessions(n: number, last = "2026-11-20"): string[] {
  const out: string[] = [];
  for (let d = new Date(`${last}T00:00:00Z`); out.length < n; d.setUTCDate(d.getUTCDate() - 1))
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
  return out;
}
const LEVELS = ["LEVEL_0", "LEVEL_1", "LEVEL_2", "LEVEL_3"] as const;
function security(id: string, status: string, eligibility: string): SecurityMasterRecord {
  return { securityId: id, currentSymbol: id.slice(-4), historicalSymbols: [], assetType: "STOCK", country: "US",
    exchange: "XNYS", firstSeenAt: "2026-01-01", status, tradable: true, providerIdentities: [], eligibility,
    barCount: 0, lastUniverseSeenAt: "2026-11-20" } as unknown as SecurityMasterRecord;
}
function bar(id: string, date: string, close: number, volume: number, revision: number, tag: string): CanonicalDailyBar {
  return { securityId: id, sessionDate: date, open: close, high: close * 1.01, low: close * 0.99, close, volume,
    revision, observedAt: tag, ingestedAt: tag, dataQuality: "GOOD", corporateActionIds: [], flags: [],
    schemaVersion: "x", provenance: { provider: "p", dataset: "d", retrievalId: tag, ingestionVersion: "v", normalizerVersion: "n" } } as unknown as CanonicalDailyBar;
}

/** Varied: gaps, revisions in either order, same-revision ties, bars after the session, shuffled input. */
function dataset(nSec: number, nDays: number, seed: number) {
  const r = rng(seed);
  const days = sessions(nDays + 3);
  const D = days[nDays - 1]!; // the last 3 days are after the scanned session
  const securities: SecurityMasterRecord[] = [];
  const bars: CanonicalDailyBar[] = [];
  for (let i = 0; i < nSec; i++) {
    const id = `sec_${String(i).padStart(6, "0")}`;
    securities.push(security(id, r() < 0.9 ? "ACTIVE" : "INACTIVE", LEVELS[Math.floor(r() * 4)]!));
    const gapRate = r() * 0.5;
    let price = 10 + r() * 90;
    for (const day of days) {
      if (r() < gapRate) continue;
      price *= 1 + (r() - 0.5) * 0.08;
      const volume = Math.floor(1_000 + r() * 1e6);
      bars.push(bar(id, day, Number(price.toFixed(4)), volume, 1, `a${i}`));
      const roll = r();
      if (roll < 0.05) bars.push(bar(id, day, Number((price * 1.02).toFixed(4)), volume, 2, `b${i}`));
      else if (roll < 0.08) bars.push(bar(id, day, Number((price * 0.97).toFixed(4)), volume, 1, `tie${i}`));
    }
  }
  for (let i = bars.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [bars[i], bars[j]] = [bars[j]!, bars[i]!];
  }
  const spy = securities[0]!.securityId;
  return { securities, bars, benchmark: bars.filter((b) => b.securityId === spy), D };
}

/** The pre-change latestBars, kept here as the reference. */
function oldLatestBars(bars: CanonicalDailyBar[], securityId: string, date: string): CanonicalDailyBar[] {
  const byDate = new Map<string, CanonicalDailyBar>();
  for (const b of bars
    .filter((item) => item.securityId === securityId && item.sessionDate <= date)
    .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate) || a.revision - b.revision))
    byDate.set(b.sessionDate, b);
  return [...byDate.values()].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
}

test("rankings are byte-identical to the per-security filter on a varied dataset", () => {
  const { securities, bars, benchmark, D } = dataset(400, 110, 7);
  const result = rankSecurities(securities, bars, benchmark, D);
  // Golden digest recorded from the pre-change code (91efd143) on this exact dataset.
  assert.equal(sha256(stableJson(result)), GOLDEN);
  assert.ok(result.ranked.length > 100 && result.beliefs.length === 400);
  const byId = new Map(result.beliefs.map((b) => [b.securityId, b]));
  for (const s of securities)
    assert.equal(byId.get(s.securityId)!.evidenceAsOfFingerprint, sha256(JSON.stringify(oldLatestBars(bars, s.securityId, D))));
  for (const item of result.ranked)
    assert.deepEqual(item.features, reconstructFeatures(item.securityId, D, oldLatestBars(bars, item.securityId, D), benchmark));
});
const GOLDEN = "37ecb845beecdba01c4dd5471179a6137d96d9e1aee978315402837c097e2665";

test("rankSecurities reads each bar's securityId a constant number of times (not once per security)", () => {
  const { securities, bars, benchmark, D } = dataset(1_500, 40, 11);
  let reads = 0;
  const counted = bars.map((b) => {
    const copy = { ...b } as Record<string, unknown>;
    const id = b.securityId;
    Object.defineProperty(copy, "securityId", { enumerable: true, get: () => (reads++, id) });
    return copy as unknown as CanonicalDailyBar;
  });
  rankSecurities(securities, counted, benchmark, D);
  // Grouping reads it once per bar; the evidence fingerprint's JSON.stringify once more.
  assert.ok(reads <= 3 * counted.length, `securityId reads=${reads} bars=${counted.length} securities=${securities.length}`);
});

test("10.7k securities x 100 sessions ranks in seconds", (t) => {
  const days = sessions(100);
  const D = days.at(-1)!;
  const securities: SecurityMasterRecord[] = [];
  const bars: CanonicalDailyBar[] = [];
  for (let i = 0; i < 10_700; i++) {
    const id = `sec_${String(i).padStart(6, "0")}`;
    securities.push(security(id, "ACTIVE", "LEVEL_2"));
    for (let d = 0; d < days.length; d++)
      bars.push({ securityId: id, sessionDate: days[d]!, close: 10 + ((i * 7 + d * 13) % 97) / 3, volume: 1000 + d, revision: 1 } as unknown as CanonicalDailyBar);
  }
  const started = performance.now();
  const result = rankSecurities(securities, bars, bars.filter((b) => b.securityId === "sec_000000"), D);
  const seconds = (performance.now() - started) / 1000;
  t.diagnostic(`rankSecurities 10,700 x 100 (${bars.length} bars): ${seconds.toFixed(2)} s`);
  assert.equal(result.ranked.length, 10_700);
  assert.ok(seconds < 30, `took ${seconds.toFixed(1)} s`);
});
