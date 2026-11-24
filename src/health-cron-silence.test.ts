// Scheduled parts are silent after the next declared slot following the last check-in + 12 h
// (Auditor, final review), not after a flat 80 h.
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHealth, nextCronSlot } from "./health-check";
import { HEALTH_PARTS } from "./health-checkins";

const parts = HEALTH_PARTS.map((p) => ({
  name: p.name,
  ...(p.allowedSilenceMinutes === undefined ? {} : { allowedSilenceMinutes: p.allowedSilenceMinutes }),
  ...(p.idle ? { idle: p.idle } : {}),
  ...(p.cronTimes ? { cron: { utcDays: p.schedule.utcDays, times: p.cronTimes } } : {}),
}));
const scanStatus = (lastAt: string, nowIso: string) =>
  evaluateHealth({ parts, now: new Date(nowIso), latest: new Map([["scan", { part: "scan", state: "OK", at: lastAt }]]) }).parts.find((p) => p.name === "scan")!.status;

test("cron silence: the next slot comes from the declared Tue-Sat 05:30/09:30 UTC schedule", () => {
  const scan = { utcDays: [2, 3, 4, 5, 6], times: ["05:30", "09:30"] };
  assert.equal(nextCronSlot("2026-11-24T06:40:00Z", scan)?.toISOString(), "2026-11-24T09:30:00.000Z"); // Tue
  assert.equal(nextCronSlot("2026-11-24T10:40:00Z", scan)?.toISOString(), "2026-11-25T05:30:00.000Z"); // -> Wed
  assert.equal(nextCronSlot("2026-11-28T10:40:00Z", scan)?.toISOString(), "2026-12-01T05:30:00.000Z"); // Sat -> Tue
});

test("cron silence: mid-week, a missed run is flagged after the next slot + 12 h (not 80 h)", () => {
  // Last scan Tue 10:40Z; next slot Wed 05:30Z; flagged after Wed 17:30Z.
  assert.equal(scanStatus("2026-11-24T10:40:00Z", "2026-11-25T17:00:00Z"), "OK");
  assert.equal(scanStatus("2026-11-24T10:40:00Z", "2026-11-25T18:00:00Z"), "no response");
  // Over the weekend the next slot is Tue 05:30Z: Sat 10:40Z -> still OK on Mon, flagged Tue 18:00Z.
  assert.equal(scanStatus("2026-11-28T10:40:00Z", "2026-11-30T20:00:00Z"), "OK");
  assert.equal(scanStatus("2026-11-28T10:40:00Z", "2026-12-01T18:00:00Z"), "no response");
});

test("cron silence: the daily step uses its own 06:20/10:20 slots", () => {
  const status = (nowIso: string) =>
    evaluateHealth({ parts, now: new Date(nowIso), latest: new Map([["daily 10-minute step", { part: "tenmin-daily", state: "OK", at: "2026-11-25T11:00:00Z" }]]) }).parts.find((p) => p.name === "daily 10-minute step")!.status;
  assert.equal(status("2026-11-26T18:00:00Z"), "OK"); // next Thu 06:20Z + 12 h = 18:20Z
  assert.equal(status("2026-11-26T18:30:00Z"), "no response");
});
