// Retention edge cases (Auditor, early review e): the 2000 cap, foreign keys, bad dates, and a delete
// failure that must not stop the health check.
import assert from "node:assert/strict";
import test from "node:test";
import { HEALTH_CHECK_LATEST_KEY, HEALTH_CHECK_STATE_KEY, runHealthCheck } from "./health-check";
import { HEALTH_CHECKIN_PREFIX, HEALTH_PRUNE_MAX_PER_RUN, pruneHealthCheckins, writeHealthCheckin } from "./health-checkins";
import { MemoryObjectClient } from "./object-store";

const NOW = new Date("2026-11-23T19:40:00Z");
const body = new TextEncoder().encode("{}\n");

test("prune: at most 2000 deletions per run; the rest go on the next run", async () => {
  const store = new MemoryObjectClient();
  for (let i = 0; i < HEALTH_PRUNE_MAX_PER_RUN + 5; i += 1)
    await store.put(`${HEALTH_CHECKIN_PREFIX}scan/2026-09-01/20260901000000000-${i}-n.json`, body);
  assert.equal(await pruneHealthCheckins(store, NOW), 2000);
  assert.equal((await store.list(HEALTH_CHECKIN_PREFIX)).length, 5);
  assert.equal(await pruneHealthCheckins(store, NOW), 5);
});

test("prune: only exact check-in keys; foreign keys and bad dates are kept", async () => {
  const store = new MemoryObjectClient();
  const kept = [
    `${HEALTH_CHECKIN_PREFIX}scan/2026-09-01/nested/x.json`, // nested path
    `${HEALTH_CHECKIN_PREFIX}scan/2026-09-01/x.json.bak`, // not .json
    `${HEALTH_CHECKIN_PREFIX}SCAN/2026-09-01/x.json`, // uppercase part
    `${HEALTH_CHECKIN_PREFIX}../2026-09-01/x.json`, // traversal
    `${HEALTH_CHECKIN_PREFIX}scan/2026-13-01/x.json`, // month 13
    `${HEALTH_CHECKIN_PREFIX}scan/0000-00-00/x.json`, // no such day
    `${HEALTH_CHECKIN_PREFIX}scan/2099-01-01/x.json`, // future
    `${HEALTH_CHECKIN_PREFIX}scan/2026-10-24/x.json`, // 30 days old
    "permanent/health/check/latest.json",
    "permanent/health/weekly/2026-09-01.json",
  ];
  for (const key of kept) await store.put(key, body);
  await store.put(`${HEALTH_CHECKIN_PREFIX}scan/2026-10-23/x.json`, body); // 31 days old: pruned
  assert.equal(await pruneHealthCheckins(store, NOW), 1);
  for (const key of kept) assert.ok(await store.get(key), `kept ${key}`);
});

test("prune: a delete failure does not stop the check; latest.json and the state are still written", async () => {
  const store = new MemoryObjectClient();
  await writeHealthCheckin(store, { part: "scan", state: "OK", at: "2026-10-01T09:31:00.000Z" });
  await writeHealthCheckin(store, { part: "scan", state: "OK", at: "2026-11-23T09:31:00.000Z" });
  const failing = Object.assign(Object.create(store) as MemoryObjectClient, {
    delete: async () => {
      throw new Error("R2_DELETE_HTTP_500");
    },
  });
  const run = await runHealthCheck(failing, NOW);
  assert.equal(run.prunedCheckins, 0);
  assert.equal(run.pruneError, "R2_DELETE_HTTP_500");
  assert.ok(run.lines.includes("pruning old check-ins failed (kept for the next check): R2_DELETE_HTTP_500"));
  const latest = JSON.parse(new TextDecoder().decode((await store.get(HEALTH_CHECK_LATEST_KEY))!)) as { pruneError?: string; headline: string };
  assert.equal(latest.pruneError, "R2_DELETE_HTTP_500");
  assert.equal(latest.headline, run.headline);
  assert.ok(await store.get(HEALTH_CHECK_STATE_KEY), "no-response counters kept");
});
