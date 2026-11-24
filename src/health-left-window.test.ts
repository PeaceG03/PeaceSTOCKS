// Auditor B2: a day that left the daily step's window not done is shown in health for 31 days, and is
// not OK when it left with fewer than 6 failed passes (it skipped the usual STUCK_SHORT route).
import assert from "node:assert/strict";
import test from "node:test";
import { readStuckDays, runHealthCheck } from "./health-check";
import { writeHealthCheckin } from "./health-checkins";
import { sha256Hex } from "./intraday-reply-dust";
import { MemoryObjectClient } from "./object-store";
import { tenMinDailyIndexKey } from "./tenmin-daily-liquid";

const NOW = new Date("2026-11-24T13:40:00Z"); // window (10 sessions) = Nov 10 .. Nov 23
const enc = new TextEncoder();

async function put(store: MemoryObjectClient, sessionDate: string, extra: Record<string, unknown>) {
  const body = {
    schemaVersion: "tenmin-daily-liquid-index-v1",
    sessionDate,
    rangeFrom: "2026-11-01",
    rangeTo: "2026-12-31",
    provider: "massive-stocks",
    rule: { n: 1, lookbackSessions: 20, method: "m", trailingSessions: [] },
    selectedAt: "t",
    selected: [{ rank: 1, securityId: "sec_a", symbol: "A", dollarVolume: 1, sessions: 20 }],
    stored: [{ securityId: "sec_a", fetch: {}, bars: 30 }],
    gaps: [],
    shortNames: 1,
    missingDailyBars: 0,
    dayBars: "30/39",
    shortStocks: [{ securityId: "sec_a", bars: "30/39" }],
    dailyBars: "1/1",
    doneRule: "done-day-v1",
    ...extra,
    updatedAt: "t",
  };
  await store.put(tenMinDailyIndexKey(sessionDate), enc.encode(JSON.stringify({ ...body, checksum: sha256Hex(enc.encode(JSON.stringify(body))) })));
}
const stuck = (reason: string, passes: number) => ({ stuckShort: { status: "STUCK_SHORT", reason, at: "t", passes, dayBars: "30/39", dailyBars: "1/1", shortNames: 1, missingDailyBars: 0 } });

test("B2: a LEFT_WINDOW STUCK_SHORT day with fewer than 6 passes is listed and is not OK", async () => {
  const store = new MemoryObjectClient();
  await writeHealthCheckin(store, { part: "scan", state: "OK", at: "2026-11-24T09:40:00.000Z" });
  await put(store, "2026-11-06", { notDoneRuns: 2, ...stuck("LEFT_WINDOW", 2) });
  const days = await readStuckDays(store, NOW);
  assert.deepEqual(days.map((d) => [d.sessionDate, d.leftWindow]), [["2026-11-06", true]]);
  const run = await runHealthCheck(store, NOW);
  assert.ok(run.lines.includes("daily 10-minute step: 2026-11-06 STUCK_SHORT, short of 39 bars: 30/39 bars, 1 stock/s short (1 at 30/39), daily bars 1/1, left the window after 2 failed pass/es, fewer than 6 failed passes (not done, no longer retried)"));
  assert.match(run.headline, /daily 10-minute step \(1 stuck day\/s\)/u);
  assert.equal(run.attention, true);
});

test("B2: a day that left after 6 failed passes is listed but alone needs no person; old, done and pre-rule days are not listed", async () => {
  const store = new MemoryObjectClient();
  await writeHealthCheckin(store, { part: "scan", state: "OK", at: "2026-11-24T09:40:00.000Z" });
  await writeHealthCheckin(store, { part: "tenmin-daily", state: "OK", at: "2026-11-24T10:40:00.000Z" });
  await writeHealthCheckin(store, { part: "history-chain", state: "OK", at: "2026-11-24T11:40:00.000Z" });
  await writeHealthCheckin(store, { part: "gap-refill", state: "OK", at: "2026-11-22T15:00:00.000Z" });
  await put(store, "2026-11-05", { notDoneRuns: 6, ...stuck("FAILED_PASSES", 6) });
  await put(store, "2026-10-16", { notDoneRuns: 1, ...stuck("LEFT_WINDOW", 1) }); // 39 days ago: past 31 days
  await put(store, "2026-11-04", { done: { at: "t", expectedBars: 39 } });
  await put(store, "2026-11-03", { doneRule: undefined, dayBars: undefined, shortStocks: undefined, shortNames: undefined, missingDailyBars: undefined }); // main's shape
  const days = await readStuckDays(store, NOW);
  assert.deepEqual(days.map((d) => d.sessionDate), ["2026-11-05"]);
  const run = await runHealthCheck(store, NOW);
  assert.ok(run.lines.some((l) => l.startsWith("daily 10-minute step: 2026-11-05 STUCK_SHORT") && l.includes("left the window after 6 failed pass/es (not done")));
  assert.equal(run.attention, false, `headline: ${run.headline}`);
});

test("B2: a tracked day that left the window while the daily step was paused (not stamped yet) is not OK", async () => {
  const store = new MemoryObjectClient();
  await put(store, "2026-11-02", { notDoneRuns: 1 });
  const [day] = await readStuckDays(store, NOW);
  assert.equal(day?.sessionDate, "2026-11-02");
  assert.equal(day?.leftWindow, true);
  assert.equal((await runHealthCheck(store, NOW)).attention, true);
});
