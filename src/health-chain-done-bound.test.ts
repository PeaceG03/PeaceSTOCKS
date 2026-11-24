// A finished history chain (STOP_DONE) is idle until its next 2-month range closes; it is flagged only
// once that close plus 3 days has passed (Auditor round 5; a flat 8 days alerted mid-cycle).
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHealth } from "./health-check";
import { HEALTH_PARTS } from "./health-checkins";

const parts = HEALTH_PARTS.map((p) => ({
  name: p.name,
  ...(p.allowedSilenceMinutes === undefined ? {} : { allowedSilenceMinutes: p.allowedSilenceMinutes }),
  ...(p.idle ? { idle: p.idle } : {}),
}));
const chainStatus = (at: string, nowIso: string) =>
  evaluateHealth({
    parts,
    now: new Date(nowIso),
    latest: new Map([["history chain", { part: "history-chain", state: "OK", at, message: "STOP_DONE:no range left" }]]),
  }).parts.find((p) => p.name === "history chain")!.status;

test("STOP_DONE idle: mid-cycle reads OK; past the next range close + 3 days it is flagged", () => {
  // Finished on 11-02 (Sep-Oct closed); the next range is Nov-Dec, closing at the end of 12-31.
  const at = "2026-11-02T12:00:00Z";
  assert.equal(chainStatus(at, "2026-11-20T12:00:00Z"), "OK"); // 18 days: mid-cycle, not an alert
  assert.equal(chainStatus(at, "2026-12-31T20:00:00Z"), "OK");
  assert.equal(chainStatus(at, "2027-01-03T23:00:00Z"), "OK"); // close (01-01 00:00Z) + 3 d = 01-04 00:00Z
  assert.equal(chainStatus(at, "2027-01-04T01:00:00Z"), "no response");
  // The schedule is the chain's own 2-month pairs: finished in early January -> Jan-Feb closes end of 02-28.
  assert.equal(chainStatus("2027-01-05T08:00:00Z", "2027-03-03T12:00:00Z"), "OK");
  assert.equal(chainStatus("2027-01-05T08:00:00Z", "2027-03-04T01:00:00Z"), "no response");
});
