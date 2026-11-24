// A capped run is behind, not OK and not an error (Peace, Nov 23).
import assert from "node:assert/strict";
import test from "node:test";
import { refillCheckin, refillStopExit } from "./gap-refill";
import { runHealthAlert } from "./health-alert";
import { scanCheckin } from "./health-behind";
import { HEALTHY, evaluateHealth, runHealthCheck } from "./health-check";
import { latestHealthCheckin, reportPart, writeHealthCheckin } from "./health-checkins";
import { MemoryObjectClient } from "./object-store";

const NOW = new Date("2026-11-24T13:40:00Z");

test("behind: a scan that ends CATCH_UP_COMPLETED:BACKLOG_REMAINS checks in BEHIND with the remaining count", () => {
  assert.deepEqual(scanCheckin({ status: "CATCH_UP_COMPLETED", reason: "BACKLOG_REMAINS", backlogRemaining: ["2026-11-02", "2026-11-03", "2026-11-04"] }), {
    state: "BEHIND",
    message: "CATCH_UP_COMPLETED:BACKLOG_REMAINS remaining=3",
    remaining: 3,
  });
  assert.equal(scanCheckin({ status: "CATCH_UP_COMPLETED", reason: "CATCH_UP_EVIDENCE_ONLY" }).state, "OK");
  assert.equal(scanCheckin({ status: "FAILED", reason: "COLLECTION_FAILED" }).state, "ERROR");
});

test("behind: an after-scan refill stopped on BACKLOG_REMAINS stopped=DEADLINE checks in BEHIND, still exit 0", () => {
  const stop = refillStopExit("DEADLINE", true, { fetched: 7, sessions: 28 });
  assert.equal(stop.code, 0);
  assert.deepEqual(stop.behind, { remaining: 21 });
  assert.deepEqual(refillCheckin(["--after-scan"], { code: 0, behind: { remaining: 21 } }), {
    state: "BEHIND",
    message: "BACKLOG_REMAINS stopped=DEADLINE remaining=21 (after-scan)",
    remaining: 21,
  });
  assert.equal(refillStopExit("DEADLINE", false, { fetched: 7, sessions: 28 }).behind, undefined, "the weekly budget stop is still a failure");
});

test("behind: the remaining count is stored with the check-in and read back", async () => {
  const store = new MemoryObjectClient();
  assert.equal(await reportPart({ PEACESTOCKS_R2_BUCKET: "fake" }, "scan", "BEHIND", "CATCH_UP_COMPLETED:BACKLOG_REMAINS remaining=12", { openStore: () => store, now: () => NOW, log: () => undefined }, { remaining: 12 }), "WRITTEN");
  const latest = await latestHealthCheckin(store, "scan");
  assert.equal(latest?.state, "BEHIND");
  assert.equal(latest?.remaining, 12);
});

test("behind: health shows the part as behind (not error, not OK) and opens no issue", async () => {
  const result = evaluateHealth({
    parts: [{ name: "scan", allowedSilenceMinutes: 74 * 60 }],
    latest: new Map([["scan", { part: "scan", state: "BEHIND", at: "2026-11-24T09:40:00Z", message: "CATCH_UP_COMPLETED:BACKLOG_REMAINS remaining=12", remaining: 12 }]]),
    now: NOW,
  });
  assert.equal(result.parts[0]!.status, "behind");
  assert.equal(result.errors, 0);
  assert.equal(result.headline, "behind: scan (12 remaining)");
  assert.notEqual(result.headline, HEALTHY);
  assert.equal(result.attention, false);
  assert.ok(result.lines.includes("scan: behind, 12 remaining (CATCH_UP_COMPLETED:BACKLOG_REMAINS remaining=12)"));
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => { calls.push(String(url)); return new Response("[]"); }) as typeof fetch;
  assert.match(await runHealthAlert({ result, env: { GITHUB_TOKEN: "FAKE-TOKEN", GITHUB_REPOSITORY: "owner/repo" }, now: NOW, fetchImpl }), /^none/u);
  assert.deepEqual(calls, [], "behind alone never opens or comments on the issue");
});

test("behind: the stored health run reports behind, and an error elsewhere still needs attention", async () => {
  const store = new MemoryObjectClient();
  await writeHealthCheckin(store, { part: "scan", state: "BEHIND", at: "2026-11-24T09:40:00.000Z", message: "CATCH_UP_COMPLETED:BACKLOG_REMAINS remaining=4", remaining: 4 });
  await writeHealthCheckin(store, { part: "gap-refill", state: "ERROR", at: "2026-11-24T10:40:00.000Z", message: "GAP_REFILL_EXIT_2" });
  const run = await runHealthCheck(store, NOW);
  assert.equal(run.parts.find((p) => p.name === "scan")!.status, "behind");
  assert.match(run.headline, /^needs attention: .*gap refill \(error\).*; behind: scan \(4 remaining\)$/u);
  assert.equal(run.attention, true);
});
