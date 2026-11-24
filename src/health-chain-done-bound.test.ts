// A finished history chain (STOP_DONE) is not silent forever: after 8 days it is flagged.
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHealth } from "./health-check";
import { HEALTH_PARTS } from "./health-checkins";

const parts = HEALTH_PARTS.map((p) => ({
  name: p.name,
  ...(p.allowedSilenceMinutes === undefined ? {} : { allowedSilenceMinutes: p.allowedSilenceMinutes }),
  ...(p.idle ? { idle: p.idle } : {}),
}));
const chainStatus = (nowIso: string) =>
  evaluateHealth({
    parts,
    now: new Date(nowIso),
    latest: new Map([["history chain", { part: "history-chain", state: "OK", at: "2026-11-01T12:00:00Z", message: "STOP_DONE:no range left" }]]),
  }).parts.find((p) => p.name === "history chain")!.status;

test("STOP_DONE idle: quiet for a week is fine, past 8 days it is flagged", () => {
  assert.equal(chainStatus("2026-11-08T12:00:00Z"), "OK");
  assert.equal(chainStatus("2026-11-09T11:00:00Z"), "OK");
  assert.equal(chainStatus("2026-11-09T13:00:00Z"), "no response");
});
