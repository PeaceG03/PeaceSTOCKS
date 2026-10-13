// Builder teaching example: simulated-cursor handoff upgrade -> backfill -> daily (no network, no store).
import assert from "node:assert/strict";
import test from "node:test";
import { addCalendarDays } from "./tenmin-history";
import { backfillEndDate, decideBackfill, planBackfillRanges } from "./tenmin-backfill";

// Adapter rule: the mode machine's storedFloor is the day after backfillEndDate (the stored pair's start), so window
// days inside the stored pair (one-off head) never count as backfillable.
const floorOf = (earliest: string) => addCalendarDays(backfillEndDate(earliest), 1);
import { decideTenMinMode } from "./tenmin-mode";

test("sim: plan upgrade -> BACKFILL_OLDER, ranges drain newest first, then DAILY; key gate holds", () => {
  let earliest = "2024-10-11";
  const plan0 = { windowStart: "2024-10-07", ratePerMin: 5 };
  const daily = decideTenMinMode({ cursor: "2026-10-14", lastClosed: "2026-10-13", storedFloor: floorOf(earliest), gaps: [], plan: plan0, prevPlan: plan0, lastOutcome: "ok", consecutiveFailures: 0 });
  assert.equal(daily.mode, "DAILY");
  assert.equal(decideBackfill(false, planBackfillRanges(earliest, "2024-03-15").length, false), "daily");

  const plan1 = { windowStart: "2024-03-15", ratePerMin: 5 };
  const up = decideTenMinMode({ cursor: "2026-10-14", lastClosed: "2026-10-13", storedFloor: floorOf(earliest), gaps: [], plan: plan1, prevPlan: plan0, lastOutcome: "ok", consecutiveFailures: 0 });
  assert.equal(up.mode, "BACKFILL_OLDER");
  assert.equal(up.planUpgraded, true);
  assert.equal(decideBackfill(true, 3, true), "hold");

  const seen: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const pending = planBackfillRanges(earliest, plan1.windowStart);
    const act = decideBackfill(true, pending.length, false);
    if (act === "daily") break;
    assert.equal(act, "dispatch");
    const r = pending[0]!;
    assert.ok(r.fetchTo < earliest, "never overlaps stored data");
    seen.push(`${r.fetchFrom}_${r.fetchTo}`);
    earliest = r.fetchFrom; // simulated store: the range sealed
  }
  assert.deepEqual(seen, ["2024-07-01_2024-08-31", "2024-05-01_2024-06-30", "2024-03-15_2024-04-30"]);
  // 2024-09-01..2024-10-10 shares the one-off's calendar pair and is never planned.
  assert.ok(seen.every((s) => !s.includes("2024-09") && !s.includes("2024-10")));
  const back = decideTenMinMode({ cursor: "2026-10-14", lastClosed: "2026-10-13", storedFloor: earliest, gaps: [], plan: plan1, prevPlan: plan1, lastOutcome: "ok", consecutiveFailures: 0 });
  assert.equal(back.mode, "DAILY");
});

test("sim: failed backfill run recovers by retry and re-plans the same range (resume by verify)", () => {
  const before = planBackfillRanges("2024-10-11", "2024-03-15");
  const rec = decideTenMinMode({ cursor: "2026-10-14", lastClosed: "2026-10-13", storedFloor: "2024-10-11", gaps: [], plan: { windowStart: "2024-03-15", ratePerMin: 5 }, lastOutcome: "failed", consecutiveFailures: 1 });
  assert.equal(rec.mode, "RECOVER");
  assert.deepEqual(planBackfillRanges("2024-10-11", "2024-03-15"), before);
});
