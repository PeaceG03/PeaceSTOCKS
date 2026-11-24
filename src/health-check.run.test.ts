import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HEALTH_CHECK_LATEST_KEY, HEALTH_CHECK_STATE_KEY, NO_PARTS_REPORTING, readStuckDays, runHealthCheck } from "./health-check";
import { writeHealthCheckin } from "./health-checkins";
import { sha256Hex } from "./intraday-reply-dust";
import { MemoryObjectClient } from "./object-store";
import { tenMinDailyIndexKey } from "./tenmin-daily-liquid";

const NOW = new Date("2026-10-27T13:40:00Z");

test("health run: reads each part's latest check-in, carries no-response counts, writes latest.json", async () => {
  const store = new MemoryObjectClient();
  assert.equal((await runHealthCheck(store, NOW)).headline, NO_PARTS_REPORTING);
  await writeHealthCheckin(store, { part: "scan", state: "OK", at: "2026-10-27T09:31:00.000Z" });
  await writeHealthCheckin(store, { part: "tenmin-daily", state: "OK", at: "2026-10-27T10:21:00.000Z" });
  await writeHealthCheckin(store, { part: "gap-refill", state: "ERROR", at: "2026-10-25T15:00:00.000Z", message: "GAP_REFILL_EXIT_2" });
  const first = await runHealthCheck(store, NOW);
  // The history chain has not reported yet: tracked as missing, not as an error.
  assert.ok(first.lines.includes("no response from history chain, requested health check 2 time/s"), "count carried from the first check");
  assert.ok(first.lines.includes("gap refill: error: GAP_REFILL_EXIT_2"));
  assert.equal(first.errors, 1);
  assert.equal(first.missing, 1);
  assert.match(first.headline, /^needs attention: history chain \(no response\), gap refill \(error\)$/u);
  const stored = JSON.parse(new TextDecoder().decode((await store.get(HEALTH_CHECK_LATEST_KEY))!)) as { headline: string };
  assert.equal(stored.headline, first.headline);
  const state = JSON.parse(new TextDecoder().decode((await store.get(HEALTH_CHECK_STATE_KEY))!)) as { requests: Record<string, number> };
  assert.equal(state.requests["history chain"], 2);
});

test("health run: a day the daily step keeps re-running short of 39 bars is flagged as stuck", async () => {
  const store = new MemoryObjectClient();
  // readTenMinDailyIndex verifies the index checksum, so write indexes in the daily step's own shape.
  const put = async (sessionDate: string, extra: Record<string, unknown>) => {
    const body = {
      schemaVersion: "tenmin-daily-liquid-index-v1",
      sessionDate,
      rangeFrom: "2026-09-01",
      rangeTo: "2026-10-31",
      provider: "massive-stocks",
      rule: { n: 1, lookbackSessions: 20, method: "m", trailingSessions: [] },
      selectedAt: "t",
      selected: [],
      stored: [],
      gaps: [],
      ...extra,
      updatedAt: "t",
    };
    const checksum = sha256Hex(new TextEncoder().encode(JSON.stringify(body)));
    await store.put(tenMinDailyIndexKey(sessionDate), new TextEncoder().encode(JSON.stringify({ ...body, checksum })));
  };
  await put("2026-10-21", { notDoneRuns: 6, shortNames: 3, missingDailyBars: 0 });
  await put("2026-10-22", { notDoneRuns: 2, shortNames: 1, missingDailyBars: 0 });
  await put("2026-10-23", { done: { at: "t", expectedBars: 39 }, notDoneRuns: 9, shortNames: 0, missingDailyBars: 0 });
  const stuck = await readStuckDays(store, NOW);
  assert.deepEqual(stuck, [{ sessionDate: "2026-10-21", expectedBars: 39, shortNames: 3, missingDailyBars: 0, reRuns: 6, bars: "0/0", shortStocks: [], dailyBars: "0/0" }]);
  const result = await runHealthCheck(store, NOW);
  assert.ok(result.lines.includes("daily 10-minute step: 2026-10-21 stuck short of 39 bars: 0/0 bars, 3 stock/s short (), daily bars 0/0, after 6 re-run/s"));
});

test("health workflow: scheduled outside the scan guard windows, R2 only, runs the health check", async () => {
  const yml = await readFile(new URL("../.github/workflows/health.yml", import.meta.url), "utf8");
  assert.match(yml, /cron: "40 1,7,13,19 \* \* \*"/u);
  assert.match(yml, /run: pnpm -s exec tsx src\/health-check\.ts/u);
  assert.ok(!/MASSIVE_API_KEY/u.test(yml), "no Massive key");
});
