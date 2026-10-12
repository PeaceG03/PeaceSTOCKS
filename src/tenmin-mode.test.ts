import assert from "node:assert/strict";
import test from "node:test";
import { decideTenMinMode, MAX_FAILURES, type ModeInput } from "./tenmin-mode";

const plan = { windowStart: "2021-10-12", ratePerMin: 5 };
const base: ModeInput = { cursor: "2024-11-01", lastClosed: "2026-10-12", storedFloor: "2021-10-12", gaps: [], plan, prevPlan: plan, lastOutcome: "ok", consecutiveFailures: 0 };

/** Simulated cursor: run decisions until the machine stops, advancing the cursor by `step` sessions per run. */
function simulate(start: ModeInput, step: (i: ModeInput) => ModeInput, max = 1000) {
  const modes: string[] = []; let i = start;
  for (let n = 0; n < max; n++) {
    const d = decideTenMinMode(i); modes.push(d.mode);
    if (d.next === "stop" || d.next === "alert") return { modes, last: d, input: i };
    i = step(i);
  }
  throw new Error("no stop");
}
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

test("catch-up -> daily: 24/7 continue until the cursor passes the last close, then stop (no idle loop)", () => {
  const r = simulate(base, (i) => ({ ...i, cursor: addDays(i.cursor, 60) }));
  assert.ok(r.modes.slice(0, -1).every((m) => m === "CATCH_UP"));
  assert.equal(r.last.mode, "DAILY");
  assert.equal(r.last.next, "stop");
  assert.ok(r.input.cursor > base.lastClosed);
});

test("daily: a new close wakes one catch-up step, then back to daily", () => {
  const caught = { ...base, cursor: "2026-10-13" };
  assert.equal(decideTenMinMode(caught).mode, "DAILY");
  const nextDay = { ...caught, lastClosed: "2026-10-13" };
  assert.equal(decideTenMinMode(nextDay).mode, "CATCH_UP");
  assert.equal(decideTenMinMode({ ...nextDay, cursor: "2026-10-14" }).mode, "DAILY");
});

test("gap check: a missing session inside the window beats daily; filled -> daily", () => {
  const caught = { ...base, cursor: "2026-10-13", gaps: ["2025-03-03"] };
  assert.equal(decideTenMinMode(caught).mode, "GAP_FILL");
  assert.equal(decideTenMinMode({ ...caught, gaps: [] }).mode, "DAILY");
});

test("daily -> plan-upgrade backfill -> daily: a longer history window reopens 24/7 until stored floor reaches it", () => {
  const bigger = { windowStart: "2016-10-12", ratePerMin: 100 };
  const start = { ...base, cursor: "2026-10-13", plan: bigger, prevPlan: plan };
  const d0 = decideTenMinMode(start);
  assert.equal(d0.mode, "BACKFILL_OLDER"); assert.equal(d0.planUpgraded, true); assert.equal(d0.ratePerMin, 100);
  const r = simulate(start, (i) => ({ ...i, prevPlan: i.plan, storedFloor: addDays(i.storedFloor, -180) }));
  assert.ok(r.modes.slice(0, -1).every((m) => m === "BACKFILL_OLDER"));
  assert.equal(r.last.mode, "DAILY");
});

test("rate-only upgrade: no mode change, faster pace", () => {
  const d = decideTenMinMode({ ...base, plan: { ...plan, ratePerMin: 50 } });
  assert.equal(d.mode, "CATCH_UP"); assert.equal(d.planUpgraded, true); assert.equal(d.ratePerMin, 50);
});

test("recovery: failure/rate limit back off then resume at the saved cursor; lost handoff resumes now; alert only when it cannot recover", () => {
  const f1 = decideTenMinMode({ ...base, lastOutcome: "rate_limited", consecutiveFailures: 1 });
  assert.deepEqual([f1.mode, f1.next, f1.waitMs], ["RECOVER", "wait", 5 * 60_000]);
  const f3 = decideTenMinMode({ ...base, lastOutcome: "failed", consecutiveFailures: 3 });
  assert.equal(f3.waitMs, 45 * 60_000);
  assert.deepEqual([decideTenMinMode({ ...base, lastOutcome: "lost_handoff", consecutiveFailures: 1 }).next], ["continue"]);
  assert.equal(decideTenMinMode({ ...base, lastOutcome: "failed", consecutiveFailures: MAX_FAILURES }).mode, "ALERT");
  assert.equal(decideTenMinMode({ ...base, lastOutcome: "refused", consecutiveFailures: 0 }).mode, "ALERT");
  // After a successful retry the same cursor continues catch-up (nothing skipped).
  assert.equal(decideTenMinMode({ ...base, lastOutcome: "ok" }).reason, "CATCH_UP:2024-11-01..2026-10-12");
});

test("no decision deletes: every reachable mode only continues, waits, stops or alerts", () => {
  for (const o of ["ok", "rate_limited", "failed", "cancelled", "lost_handoff", "refused", "none"] as const)
    assert.ok(["continue", "wait", "stop", "alert"].includes(decideTenMinMode({ ...base, lastOutcome: o, consecutiveFailures: 1 }).next));
});

import { lastOutcomeFromRecord } from "./tenmin-mode";
test("shadow adapter: run records map to outcomes", () => {
  assert.equal(lastOutcomeFromRecord(undefined, undefined), "none");
  assert.equal(lastOutcomeFromRecord("STOP_MASSIVE_RATE_LIMITED", "success"), "rate_limited");
  assert.equal(lastOutcomeFromRecord("CONTINUE", "failure"), "failed");
  assert.equal(lastOutcomeFromRecord("CONTINUE", "cancelled"), "cancelled");
  assert.equal(lastOutcomeFromRecord("CONTINUE", "success"), "ok");
});

import { modeFromChainState } from "./tenmin-mode";
test("chain-state adapter: catch-up while ranges remain, daily when done, backfill on probe upgrade, recover on failure", () => {
  const s = { rangesRemaining: 3, gaps: 0, olderReachable: false, probedRatePerMin: undefined, lastOutcome: "ok" as const, consecutiveFailures: 0, ratePerMin: 5 };
  assert.equal(modeFromChainState(s).mode, "CATCH_UP");
  assert.equal(modeFromChainState({ ...s, rangesRemaining: 0 }).mode, "DAILY");
  assert.equal(modeFromChainState({ ...s, rangesRemaining: 0, gaps: 2 }).mode, "GAP_FILL");
  const up = modeFromChainState({ ...s, rangesRemaining: 0, olderReachable: true });
  assert.equal(up.mode, "BACKFILL_OLDER"); assert.equal(up.planUpgraded, true);
  assert.equal(modeFromChainState({ ...s, rangesRemaining: 0, olderReachable: undefined }).mode, "DAILY");
  assert.equal(modeFromChainState({ ...s, lastOutcome: "failed", consecutiveFailures: 1 }).mode, "RECOVER");
  assert.equal(modeFromChainState({ ...s, probedRatePerMin: 100 }).ratePerMin, 100);
});
