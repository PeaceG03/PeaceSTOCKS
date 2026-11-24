// Auditor round 4: under a pre-guard or manually resealed range, an unfinished tracked day (not
// STUCK_SHORT) keeps holding history until the daily step stamps it STUCK_SHORT (SEALED_OVER) with its
// bar count; then it releases, the fallback resolves it, and health lists it under B2's rules.
import assert from "node:assert/strict";
import test from "node:test";
import type { SecurityMasterRecord, TenMinuteRangeReply } from "./contracts";
import { readStuckDays, stuckDayLine, stuckDayNeedsAttention } from "./health-check";
import { MemoryObjectClient } from "./object-store";
import { readTenMinDailyIndex, runTenMinDailyLiquid, tenMinDailyHistoryHold } from "./tenmin-daily-liquid";
import { heldDayResolution } from "./tenmin-redispatch";
import { tenMinRangeManifestKey } from "./tenmin-range-reply-dust";

const DAY = "2026-10-09";
const security = (symbol: string): SecurityMasterRecord => ({
  securityId: `sec_${symbol.toLowerCase()}`, currentSymbol: symbol, historicalSymbols: [], assetType: "STOCK", country: "US", exchange: "XNYS",
  firstSeenAt: "2024-01-01", status: "ACTIVE", tradable: true, providerIdentities: [], eligibility: "LEVEL_2", barCount: 100, lastUniverseSeenAt: DAY,
});
const SECURITIES = ["AAA", "BBB", "CCC", "DDD"].map(security);
const DV: Record<string, number> = { AAA: 4000, BBB: 3000, CCC: 2000, DDD: 1000 };
const aggBar = (iso: string, p: number) => `{"v":100,"vw":${p},"o":${p},"c":${p + 0.01},"h":${p + 0.02},"l":${p - 0.01},"t":${Date.parse(iso)},"n":3}`;
const barsOnDay = (symbol: string, d: string, count: number) =>
  Array.from({ length: count }, (_, i) => aggBar(new Date(Date.parse(`${d}T13:30:00Z`) + i * 600_000).toISOString(), symbol.charCodeAt(0) + i / 100));
const pages = (calls: string[]) => async (sec: { securityId: string; symbol: string }, from: string, to: string): Promise<TenMinuteRangeReply[]> => {
  calls.push(`${sec.symbol}:${from}`);
  const bars = barsOnDay(sec.symbol, from, sec.symbol === "BBB" ? 30 : 39);
  const body = `{"ticker":"${sec.symbol}","adjusted":false,"results":[${bars.join(",")}],"status":"OK","request_id":"SYN-${sec.symbol}-${from}","count":${bars.length}}`;
  return [{ page: 1, request: `/v2/aggs/ticker/${sec.symbol}/range/10/minute/${from}/${to}?adjusted=false`, fetchedAt: "2026-10-10T06:31:00.000Z", body: new TextEncoder().encode(body), rangeFrom: from, rangeTo: to, securityId: sec.securityId, symbol: sec.symbol }];
};
const run = (store: MemoryObjectClient, calls: string[]) =>
  runTenMinDailyLiquid({
    store, securities: SECURITIES, provider: "massive-stocks", n: 3, maxRequests: 100, lastCompletedSession: DAY, catchupSessions: 1,
    loadBars: async (sessions) => sessions.flatMap((sessionDate) => Object.entries(DV).map(([s, v]) => ({ securityId: `sec_${s.toLowerCase()}`, sessionDate, close: 10, volume: v / 10, revision: 0 }))),
    nowIso: () => "2026-10-10T06:30:00.000Z", zstdVersionProbe: () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***", fetchPages: pages(calls),
  });
const hold = (store: MemoryObjectClient) => tenMinDailyHistoryHold(store, { lastCompletedSession: DAY, catchupSessions: 1 });

test("SEALED_OVER: an unfinished day under a later seal holds history until stamped STUCK_SHORT with its count", async () => {
  const store = new MemoryObjectClient();
  const calls: string[] = [];
  await run(store, calls); // one failed pass: BBB 30/39
  assert.equal((await readTenMinDailyIndex(store, DAY))!.notDoneRuns, 1);
  assert.equal(await hold(store), DAY);
  // A range sealed over the day without the guard (pre-guard seal or manual reseal).
  await store.put(tenMinRangeManifestKey("2026-09-01", "2026-10-31"), new TextEncoder().encode("{}"));
  assert.equal(await hold(store), DAY, "not STUCK_SHORT yet: still holds (only full or STUCK_SHORT unblocks)");
  assert.equal(heldDayResolution(`WAIT_DAILY_STEP:${DAY}`, { status: "RAN", finishedAt: "2026-10-10T07:00:00Z", sessions: [{ sessionDate: DAY, status: "SKIPPED_RANGE_SEALED" }] }, "2026-10-10T06:00:00Z"), undefined);

  calls.length = 0;
  const sealed = await run(store, calls);
  assert.deepEqual(calls, [], "nothing fetched under the seal");
  assert.equal(sealed.sessions[0]!.status, "STUCK_SHORT");
  assert.ok(sealed.warnings.includes(`TENMIN_DAILY_STUCK_SHORT_SEALED_OVER:${DAY}:108/117`));
  const index = (await readTenMinDailyIndex(store, DAY))!;
  assert.equal(index.done, undefined, "never full");
  assert.deepEqual({ ...index.stuckShort, at: "t" }, { status: "STUCK_SHORT", reason: "SEALED_OVER", at: "t", passes: 1, dayBars: "108/117", dailyBars: "3/3", shortNames: 1, missingDailyBars: 0 });
  assert.equal(await hold(store), undefined, "STUCK_SHORT releases the chain");
  const report = { status: "RAN", finishedAt: "2026-10-10T07:00:00Z", sessions: sealed.sessions.map((s) => ({ sessionDate: s.sessionDate, status: s.status })) };
  assert.equal(heldDayResolution(`WAIT_DAILY_STEP:${DAY}`, report, "2026-10-10T06:00:00Z"), `${DAY}:STUCK_SHORT`);

  // Health lists it (B2 rules: in the window it needs a person; fewer than 6 failed passes).
  const stuck = await readStuckDays(store, new Date("2026-10-10T12:00:00Z"));
  const day = stuck.find((d) => d.sessionDate === DAY)!;
  assert.ok(stuckDayNeedsAttention(day));
  assert.match(stuckDayLine(day), /2026-10-09 STUCK_SHORT, short of 39 bars: 108\/117 bars.*sealed over by a history range after 1 failed pass\/es, fewer than 6 failed passes/);
});
