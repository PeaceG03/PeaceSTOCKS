import assert from "node:assert/strict";
import test from "node:test";
import type { PredictionStatus } from "./contracts";
import { describeMiss, judgedSessions, runFreezeWatch, sessionFreezeOutcome } from "./freeze-watch";
import { MemoryObjectClient } from "./object-store";
import { MISSED_FREEZE_ALERT_PREFIX } from "./scan-health";

const status = (sessionDate: string, patch: Partial<PredictionStatus>): PredictionStatus => ({
  predictionStatusId: `prediction-status_x_${sessionDate}_${patch.status ?? "FROZEN"}_${patch.reason ?? ""}`,
  sessionDate,
  status: "FROZEN",
  reason: "PREDICTIONS_FROZEN",
  scannerVersion: "v",
  configFingerprint: "f",
  recordedAt: `${sessionDate}T23:59:59.999Z`,
  supersedesPredictionIds: [],
  ...patch,
});

test("judged sessions: only sessions whose next open has passed, newest first, skipping weekends and holidays", () => {
  // Tue Oct 6 2026 at 13:30:00 UTC is the 09:30 New York open: Mon Oct 5 is judged from that instant on.
  const at = (iso: string) => judgedSessions(new Date(iso), 3).map((s) => s.sessionDate);
  assert.deepEqual(at("2026-10-06T13:29:59.999Z"), ["2026-10-02", "2026-10-01", "2026-09-30"]);
  assert.deepEqual(at("2026-10-06T13:30:00.000Z"), ["2026-10-05", "2026-10-02", "2026-10-01"]);
  // Thanksgiving (Thu Nov 26) is closed: Wed Nov 25 is judged at Friday's open.
  assert.deepEqual(at("2026-11-27T14:30:00.000Z"), ["2026-11-25", "2026-11-24", "2026-11-23"]);
  assert.equal(judgedSessions(new Date("2026-11-27T14:30:00.000Z"), 1)[0]!.nextSessionOpen.toISOString(), "2026-11-27T14:30:00.000Z");
});

test("freeze outcome: frozen before the open is on time; at/after the open, unavailable, or no record is a miss", () => {
  const open = new Date("2026-10-05T13:30:00.000Z");
  const D = "2026-10-02";
  const one = (s: PredictionStatus[]) => sessionFreezeOutcome(D, open, s).outcome;
  assert.equal(one([status(D, { predictedAt: "2026-10-05T13:29:59.999Z" })]), "ON_TIME");
  assert.equal(one([status(D, { predictedAt: "2026-10-05T13:30:00.000Z" })]), "LATE");
  assert.equal(one([status(D, {})]), "ON_TIME"); // pre-S4 records without predictedAt
  assert.equal(one([status(D, { status: "UNAVAILABLE", reason: "FREEZE_AFTER_OPEN", attemptedAt: "2026-10-05T14:00:00.000Z" })]), "LATE");
  assert.equal(one([status(D, { status: "UNAVAILABLE", reason: "SOURCE_COLLECTION_FAILED", attemptedAt: "2026-10-03T06:00:00.000Z" })]), "UNAVAILABLE");
  assert.equal(one([]), "NO_RECORD");
  assert.equal(one([status("2026-10-01", { predictedAt: "2026-10-02T05:00:00.000Z" })]), "NO_RECORD"); // another session's record
  // A retry that froze in time wins over an earlier unavailable attempt.
  assert.equal(
    one([
      status(D, { status: "UNAVAILABLE", reason: "SOURCE_COLLECTION_FAILED", attemptedAt: "2026-10-03T05:40:00.000Z" }),
      status(D, { predictedAt: "2026-10-03T09:40:00.000Z", attemptedAt: "2026-10-03T09:40:00.000Z" }),
    ]),
    "ON_TIME",
  );
  const text = describeMiss(sessionFreezeOutcome(D, open, []));
  assert.match(text, /^session 2026-10-02: missed the freeze/u);
});

function store(records: Record<string, PredictionStatus[]>): MemoryObjectClient {
  const client = new MemoryObjectClient();
  for (const [d, list] of Object.entries(records))
    void client.put(`permanent/prediction-status/${d}.jsonl`, new TextEncoder().encode(list.map((r) => JSON.stringify(r)).join("\n") + "\n"));
  return client;
}

test("missed freeze raises the existing alert once per session; on-time sessions raise nothing", async () => {
  const now = new Date("2026-10-06T15:00:00.000Z"); // judged: Oct 5, Oct 2, Oct 1
  const client = store({
    "2026-10-05": [status("2026-10-05", { status: "UNAVAILABLE", reason: "FREEZE_AFTER_OPEN", attemptedAt: "2026-10-06T14:00:00.000Z" })],
    "2026-10-02": [status("2026-10-02", { predictedAt: "2026-10-03T05:40:00.000Z" })],
    // Oct 1: no record at all (the scan never finished)
  });
  const calls: Array<{ headline: string; lines: readonly string[]; attention?: boolean }> = [];
  const alert = async (o: { result: { headline: string; lines: readonly string[]; attention?: boolean } | undefined }) => {
    calls.push(o.result!);
    return "opened #1";
  };
  const first = await runFreezeWatch({ store: client, env: {}, now, alert: alert as never });
  assert.deepEqual(first.alerted, ["2026-10-05", "2026-10-01"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.attention, true);
  assert.equal(calls[0]!.headline, "missed freeze: 2 sessions");
  assert.equal(calls[0]!.lines[0], calls[0]!.headline); // the alert body drops line 0 (the headline)
  assert.match(calls[0]!.lines[1]!, /session 2026-10-05: missed the freeze, picks were not frozen before the open/u);
  assert.match(calls[0]!.lines[2]!, /session 2026-10-01: missed the freeze, no freeze decision was stored/u);
  assert.ok(await client.head(`${MISSED_FREEZE_ALERT_PREFIX}2026-10-05.json`));
  assert.equal(await client.head(`${MISSED_FREEZE_ALERT_PREFIX}2026-10-02.json`), undefined);
  // Next run: same misses, already alerted -> no new alert.
  const second = await runFreezeWatch({ store: client, env: {}, now: new Date("2026-10-06T16:00:00.000Z"), alert: alert as never });
  assert.deepEqual(second.alerted, []);
  assert.equal(calls.length, 1);
  assert.match(second.line, /2 missed in the last 3 sessions, none new/u);
  // All on time: nothing at all.
  const clean = store({
    "2026-10-05": [status("2026-10-05", { predictedAt: "2026-10-06T05:40:00.000Z" })],
    "2026-10-02": [status("2026-10-02", { predictedAt: "2026-10-03T05:40:00.000Z" })],
    "2026-10-01": [status("2026-10-01", { predictedAt: "2026-10-02T05:40:00.000Z" })],
  });
  const quiet = await runFreezeWatch({ store: clean, env: {}, now, alert: alert as never });
  assert.deepEqual([quiet.missed.length, quiet.alerted.length, calls.length], [0, 0, 1]);
});

test("missed freeze goes through the health issue (label scanner-alert); a failed alert leaves no marker so the next run retries", async () => {
  const now = new Date("2026-10-06T15:00:00.000Z");
  const ok = {
    "2026-10-05": [status("2026-10-05", { predictedAt: "2026-10-06T05:40:00.000Z" })],
    "2026-10-01": [status("2026-10-01", { predictedAt: "2026-10-02T05:40:00.000Z" })],
  };
  const env = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "1" };
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") posts.push({ url, body: JSON.parse(init.body!) });
    return new Response(init?.method === "POST" ? JSON.stringify({ number: 7 }) : "[]", { status: 200 });
  }) as unknown as typeof fetch;
  const client = store(ok);
  const done = await runFreezeWatch({ store: client, env, now, fetchImpl });
  assert.deepEqual(done.alerted, ["2026-10-02"]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.body.title, "PeaceSTOCKS health needs attention");
  assert.deepEqual(posts[0]!.body.labels, ["scanner-alert"]);
  assert.match(String(posts[0]!.body.body), /missed freeze: 1 session/u);
  const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
  const client2 = store(ok);
  await assert.rejects(runFreezeWatch({ store: client2, env, now, fetchImpl: failing }), /HEALTH_ALERT_GITHUB_500/u);
  assert.equal(await client2.head(`${MISSED_FREEZE_ALERT_PREFIX}2026-10-02.json`), undefined);
});
