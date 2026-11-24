import assert from "node:assert/strict";
import test from "node:test";
import { HEALTH_CHECK_LATEST_KEY, readStuckDays, runHealthCheck, shortStocksLine, stuckDayLine } from "./health-check";
import { sha256Hex } from "./intraday-reply-dust";
import { MemoryObjectClient } from "./object-store";
import { tenMinDailyIndexKey, tenMinDailyIndexCounts } from "./tenmin-daily-liquid";
import { barCount, shortStockCounts, tenMinSessionDone } from "./tenmin-day-done";

const NOW = new Date("2026-10-27T13:40:00Z");

async function putIndex(store: MemoryObjectClient, sessionDate: string, extra: Record<string, unknown>): Promise<void> {
  const body = {
    schemaVersion: "tenmin-daily-liquid-index-v1",
    sessionDate,
    rangeFrom: "2026-09-01",
    rangeTo: "2026-10-31",
    provider: "massive-stocks",
    rule: { n: 3, lookbackSessions: 20, method: "m", trailingSessions: [] },
    selectedAt: "t",
    selected: [
      { securityId: "sec_a", symbol: "A" },
      { securityId: "sec_b", symbol: "B" },
      { securityId: "sec_c", symbol: "C" },
    ],
    stored: [],
    gaps: [],
    ...extra,
    updatedAt: "t",
  };
  const checksum = sha256Hex(new TextEncoder().encode(JSON.stringify(body)));
  await store.put(tenMinDailyIndexKey(sessionDate), new TextEncoder().encode(JSON.stringify({ ...body, checksum })));
}

test("counts: the done-day verdict carries bars stored vs. needed per day and per short stock", () => {
  assert.equal(barCount(38, 39), "38/39");
  const verdict = tenMinSessionDone({
    sessionDate: "2026-10-09",
    selected: ["sec_a", "sec_b", "sec_c"],
    savedBars: new Map([["sec_a", 39], ["sec_b", 38], ["sec_c", 45]]),
    dailyBarsSaved: new Set(["sec_a", "sec_b", "sec_c"]),
  });
  assert.equal(verdict.barsStored, 116, "a count above 39 is capped");
  assert.equal(verdict.barsNeeded, 117);
  assert.deepEqual(verdict.shortStocks, [{ securityId: "sec_b", bars: 38 }]);
  assert.deepEqual(shortStockCounts([{ securityId: "x", bars: 38 }, { securityId: "y", bars: 0 }, { securityId: "z", bars: 38 }], 39), { "0/39": 1, "38/39": 2 });
});

test("counts: health output and latest.json show each stuck day and short stock as stored/needed", async () => {
  const store = new MemoryObjectClient();
  await putIndex(store, "2026-10-21", {
    stored: [
      { securityId: "sec_a", fetch: {}, bars: 39 },
      { securityId: "sec_b", fetch: {}, bars: 38 },
    ],
    notDoneRuns: 6,
    shortNames: 2,
    missingDailyBars: 0,
    dayBars: "77/117",
    shortStocks: [
      { securityId: "sec_b", bars: "38/39" },
      { securityId: "sec_c", bars: "0/39" },
    ],
    dailyBars: "3/3",
  });
  const [day] = await readStuckDays(store, NOW);
  assert.equal(day!.bars, "77/117");
  assert.equal(day!.dailyBars, "3/3");
  assert.deepEqual(day!.shortStocks, [{ securityId: "sec_b", bars: "38/39" }, { securityId: "sec_c", bars: "0/39" }]);
  assert.equal(shortStocksLine(day!.shortStocks), "1 at 0/39, 1 at 38/39");
  assert.equal(
    stuckDayLine(day!),
    "daily 10-minute step: 2026-10-21 stuck short of 39 bars: 77/117 bars, 2 stock/s short (1 at 0/39, 1 at 38/39), daily bars 3/3, after 6 re-run/s",
  );
  const result = await runHealthCheck(store, NOW);
  assert.ok(result.lines.includes(stuckDayLine(day!)));
  assert.ok(!result.lines.join("\n").includes("sec_b"), "health lines (logs) carry counts, not stock names");
  const latest = JSON.parse(new TextDecoder().decode((await store.get(HEALTH_CHECK_LATEST_KEY))!)) as {
    stuckDays: { bars: string; shortStocks: { securityId: string; bars: string }[] }[];
  };
  assert.equal(latest.stuckDays[0]!.bars, "77/117");
  assert.deepEqual(latest.stuckDays[0]!.shortStocks[0], { securityId: "sec_b", bars: "38/39" });
});

test("counts: an index written before the counts gets them from its stored entries", () => {
  const counts = tenMinDailyIndexCounts(
    {
      selected: [
        { securityId: "sec_a", symbol: "A", rank: 1, dollarVolume: 2, sessions: 20 },
        { securityId: "sec_b", symbol: "B", rank: 2, dollarVolume: 1, sessions: 20 },
      ],
      stored: [{ securityId: "sec_a", fetch: {} as never, bars: 20 }],
      missingDailyBars: 1,
    },
    21,
  );
  assert.deepEqual(counts, {
    dayBars: "20/42",
    shortStocks: [{ securityId: "sec_a", bars: "20/21" }, { securityId: "sec_b", bars: "0/21" }],
    dailyBars: "1/2",
  });
});
