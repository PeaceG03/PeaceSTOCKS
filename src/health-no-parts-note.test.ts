// "no parts reporting" before the first check-ins is expected once: the result says so plainly.
import assert from "node:assert/strict";
import test from "node:test";
import { NO_PARTS_REPORTING, NO_PARTS_REPORTING_NOTE, evaluateHealth } from "./health-check";
import { redactHealthMessage } from "./health-checkins";

test("no parts reporting: the result explains it is expected before the first check-ins", () => {
  const r = evaluateHealth({ parts: [{ name: "scan", allowedSilenceMinutes: 60 }], latest: new Map(), now: new Date("2026-11-24T00:00:00Z") });
  assert.equal(r.headline, NO_PARTS_REPORTING);
  assert.ok(r.lines.includes(NO_PARTS_REPORTING_NOTE));
  assert.match(NO_PARTS_REPORTING_NOTE, /expected once, before the first scheduled runs/);
  assert.equal(redactHealthMessage(NO_PARTS_REPORTING_NOTE), NO_PARTS_REPORTING_NOTE); // reaches the issue body whole
  const seen = evaluateHealth({ parts: [{ name: "scan", allowedSilenceMinutes: 60 }], latest: new Map([["scan", { part: "scan", state: "OK", at: "2026-11-23T23:30:00Z" }]]), now: new Date("2026-11-24T00:00:00Z") });
  assert.ok(!seen.lines.includes(NO_PARTS_REPORTING_NOTE));
});
