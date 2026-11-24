import assert from "node:assert/strict";
import test from "node:test";
import { HEALTHY, NO_PARTS_REPORTING, evaluateHealth } from "./health-check";
import { partStatus } from "./health-part-state";

const NOW = new Date("2026-10-27T12:00:00Z");
const PARTS = [
  { name: "scan", allowedSilenceMinutes: 60 },
  { name: "daily 10-minute step", allowedSilenceMinutes: 60 },
  { name: "history chain", allowedSilenceMinutes: 60 },
  { name: "backfill" },
  { name: "gap refill", allowedSilenceMinutes: 60 },
];
const fresh = (part: string, state = "OK", message?: string) => ({ part, state, at: "2026-10-27T11:30:00Z", ...(message ? { message } : {}) });
const stale = (part: string, state = "OK") => ({ part, state, at: "2026-10-26T11:30:00Z" });
const latest = (entries: Array<[string, ReturnType<typeof fresh> | undefined]>) => new Map(entries);

test("health: a silent part is not an error; it is tracked as missing with the static 'time/s' wording", () => {
  const first = evaluateHealth({ parts: PARTS, latest: latest([["scan", stale("scan")], ["history chain", fresh("history chain")]]), now: NOW });
  const scan = first.parts.find((p) => p.name === "scan")!;
  assert.equal(scan.status, "no response");
  assert.equal(scan.line, "no response from scan, requested health check 1 time/s");
  assert.equal(first.errors, 0, "silence never counts as an error");
  const second = evaluateHealth({ parts: PARTS, latest: latest([["scan", stale("scan")]]), priorRequests: first.requests, now: NOW });
  assert.equal(second.parts.find((p) => p.name === "scan")!.line, "no response from scan, requested health check 2 time/s");
  const back = evaluateHealth({ parts: PARTS, latest: latest([["scan", fresh("scan")]]), priorRequests: second.requests, now: NOW });
  assert.equal(back.requests.scan, 0, "answering resets the count");
});

test("health: unknown state words never count against a part", () => {
  const r = evaluateHealth({
    parts: PARTS,
    latest: latest(PARTS.map((p) => [p.name, fresh(p.name, p.name === "scan" ? "GREENISH" : "OK")])),
    now: NOW,
  });
  const scan = r.parts.find((p) => p.name === "scan")!;
  assert.equal(scan.status, "unrecognized word");
  assert.equal(scan.line, 'scan: unrecognized word "GREENISH"');
  assert.equal(r.errors, 0);
  assert.equal(r.headline, HEALTHY);
});

test("health: winner order error > no response > unrecognized word > OK", () => {
  assert.equal(partStatus({ error: true, silent: true, unrecognized: true }), "error");
  assert.equal(partStatus({ error: false, silent: true, unrecognized: true }), "no response");
  assert.equal(partStatus({ error: false, silent: false, unrecognized: true }), "unrecognized word");
  assert.equal(partStatus({ error: false, silent: false, unrecognized: false }), "OK");
  const staleError = evaluateHealth({ parts: PARTS, latest: latest([["scan", { ...stale("scan", "ERROR"), message: "MASSIVE_HTTP_500" }]]), now: NOW });
  assert.equal(staleError.parts.find((p) => p.name === "scan")!.status, "error");
  assert.equal(staleError.parts.find((p) => p.name === "scan")!.line, "scan: error: MASSIVE_HTTP_500");
});

test("health: 3 or more silent parts flag the health check's own likely fault and still name each one", () => {
  const r = evaluateHealth({ parts: PARTS, latest: latest([["gap refill", fresh("gap refill")], ["scan", stale("scan")]]), now: NOW });
  assert.equal(r.likelyCheckFault, true);
  assert.deepEqual(r.silentParts, ["scan", "daily 10-minute step", "history chain"]);
  assert.ok(r.lines.includes("health check likely at fault: 3 parts silent at once (scan, daily 10-minute step, history chain)"));
  for (const name of r.silentParts) assert.ok(r.lines.some((l) => l.startsWith(`no response from ${name}, `)));
  const two = evaluateHealth({ parts: PARTS, latest: latest([["gap refill", fresh("gap refill")], ["scan", fresh("scan")]]), now: NOW });
  assert.equal(two.likelyCheckFault, false);
});

test("health: no parts reporting is never 'Healthy'", () => {
  assert.equal(evaluateHealth({ parts: [], latest: new Map(), now: NOW }).headline, NO_PARTS_REPORTING);
  const none = evaluateHealth({ parts: PARTS, latest: new Map(), now: NOW });
  assert.equal(none.headline, NO_PARTS_REPORTING);
  assert.notEqual(none.headline, HEALTHY);
});

test("health: all parts answering OK is Healthy; a part that runs only by hand is never silent", () => {
  const r = evaluateHealth({ parts: PARTS, latest: latest(PARTS.filter((p) => p.name !== "backfill").map((p) => [p.name, fresh(p.name)])), now: NOW });
  assert.equal(r.headline, HEALTHY);
  assert.equal(r.parts.find((p) => p.name === "backfill")!.status, "OK");
});

test("health: days stuck short of 39 bars are flagged", () => {
  const r = evaluateHealth({
    parts: PARTS,
    latest: latest(PARTS.map((p) => [p.name, fresh(p.name)])),
    now: NOW,
    stuckDays: [{ sessionDate: "2026-10-23", expectedBars: 39, shortNames: 4, missingDailyBars: 0, reRuns: 6, bars: "152/156", dailyBars: "4/4", shortStocks: [{ securityId: "s1", bars: "38/39" }, { securityId: "s2", bars: "38/39" }, { securityId: "s3", bars: "38/39" }, { securityId: "s4", bars: "38/39" }] }],
  });
  assert.match(r.headline, /^needs attention: daily 10-minute step \(1 stuck day\/s\)$/u);
  assert.ok(r.lines.includes("daily 10-minute step: 2026-10-23 STUCK_SHORT, short of 39 bars: 152/156 bars, 4 stock/s short (4 at 38/39), daily bars 4/4, after 6 re-run/s (not done, still retried)"));
});
