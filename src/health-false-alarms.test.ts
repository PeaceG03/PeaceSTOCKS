// Known false non-OK cases fixed before the health issue goes live (Auditor, early review d):
// the history chain idle after it finished, gap refill before its first run, and late crons.
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHealth, runHealthCheck } from "./health-check";
import { HEALTH_PARTS, pruneHealthCheckins, writeHealthCheckin } from "./health-checkins";
import { MemoryObjectClient } from "./object-store";

const parts = HEALTH_PARTS.map((p) => ({ name: p.name, ...(p.allowedSilenceMinutes === undefined ? {} : { allowedSilenceMinutes: p.allowedSilenceMinutes }), ...(p.idle ? { idle: p.idle } : {}) }));
const hours = (h: number, from: string) => new Date(Date.parse(from) + h * 3_600_000).toISOString();

test("false alarm: the history chain that finished (STOP_DONE) is idle (up to its 8-day bound); a working chain is not", () => {
  const at = "2026-11-01T12:00:00.000Z";
  const now = new Date(hours(24 * 7, at)); // a week later (the 8-day bound: health-chain-done-bound.test.ts)
  const done = evaluateHealth({ parts, now, latest: new Map([["history chain", { part: "history-chain", state: "OK", at, message: "STOP_DONE:no-range-left" }]]) });
  assert.equal(done.parts.find((p) => p.name === "history chain")!.status, "OK");
  const working = evaluateHealth({ parts, now: new Date(hours(37, at)), latest: new Map([["history chain", { part: "history-chain", state: "OK", at, message: "CONTINUE_TIME_BUDGET" }]]) });
  assert.equal(working.parts.find((p) => p.name === "history chain")!.status, "no response");
  // Waiting on the daily step: allowed as long as the daily step's own silence (80 h), not 36 h.
  const held = (h: number) =>
    evaluateHealth({ parts, now: new Date(hours(h, at)), latest: new Map([["history chain", { part: "history-chain", state: "OK", at, message: "WAIT_DAILY_STEP:2026-10-30" }]]) }).parts.find((p) => p.name === "history chain")!.status;
  assert.equal(held(60), "OK");
  assert.equal(held(81), "no response");
});

test("false alarm: a part that never checked in is not 'no response' before its allowance has passed since check-ins began", () => {
  const since = "2026-11-24T00:00:00.000Z"; // merge day: the first check-ins
  const early = evaluateHealth({ parts, now: new Date(hours(30, since)), monitoringSince: since, latest: new Map() });
  assert.equal(early.parts.find((p) => p.name === "gap refill")!.status, "OK");
  assert.ok(early.lines.includes("gap refill: OK (no check-in yet; first run expected within its schedule)"));
  const late = evaluateHealth({ parts, now: new Date(hours(24 * 9, since)), monitoringSince: since, latest: new Map() });
  assert.equal(late.parts.find((p) => p.name === "gap refill")!.status, "no response");
});

test("false alarm: crons 7-8 h late are inside the margin (12 h on top of the longest normal gap)", () => {
  const sat = "2026-11-21T09:30:00.000Z"; // Sat 09:30Z -> Tue 05:30Z is 68 h
  const lateBy = (h: number) =>
    evaluateHealth({ parts, now: new Date(hours(68 + h, sat)), latest: new Map([["scan", { part: "scan", state: "OK", at: sat }]]) }).parts.find((p) => p.name === "scan")!.status;
  assert.equal(lateBy(8), "OK");
  assert.equal(lateBy(13), "no response");
});

test("false alarm: an idle part keeps its last check-in through pruning (still seen a month later)", async () => {
  const store = new MemoryObjectClient();
  await writeHealthCheckin(store, { part: "history-chain", state: "OK", at: "2026-10-01T12:00:00.000Z", message: "CONTINUE_TIME_BUDGET" });
  await writeHealthCheckin(store, { part: "history-chain", state: "OK", at: "2026-10-02T12:00:00.000Z", message: "STOP_DONE:no-range-left" });
  const now = new Date("2026-11-23T19:40:00Z");
  assert.equal(await pruneHealthCheckins(store, now), 1);
  const run = await runHealthCheck(store, now);
  const chain = run.parts.find((p) => p.name === "history chain")!;
  // Its last check-in survives pruning; a month of STOP_DONE silence is past the 8-day bound, so it is
  // flagged as silent since 10-02, never as "no check-in at all".
  assert.equal(chain.lastCheckinAt, "2026-10-02T12:00:00.000Z");
  assert.equal(chain.status, "no response");
});
