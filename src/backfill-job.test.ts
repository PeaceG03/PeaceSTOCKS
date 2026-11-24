import assert from "node:assert/strict";
import test from "node:test";
import { classifyStop, runBackfillJob, type BackfillJobOptions } from "./backfill-job";
import { dailyBarsSidecarFileKey } from "./daily-bars-sidecar";
import { dailyReplyDustFileKey } from "./daily-reply-dust";
import { FAKE_MASSIVE_BASE_URL, fakeMassive, syntheticMarket, type FakeMassiveOptions } from "./fake-massive";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";

// No real network anywhere here: every request goes to the in-process fake at massive.invalid.
const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";
const market = syntheticMarket(6);

function rig(interval = 1_000) {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  let now = Date.parse("2026-11-24T12:00:00Z");
  const base = (fake: ReturnType<typeof fakeMassive>, from: string, to: string, extra: Partial<BackfillJobOptions> = {}): BackfillJobOptions => ({
    from, to, storage, store: client, fetchImpl: fake.fetchImpl, apiKey: "fake-key-not-real", baseUrl: FAKE_MASSIVE_BASE_URL,
    minRequestIntervalMs: interval, clock: () => now, sleep: async (ms) => { await new Promise((r) => setImmediate(r)); now += ms; }, now: () => new Date(now).toISOString(),
    zstdVersionProbe: pinnedZstd, ...extra,
  });
  const fake = (over: Partial<FakeMassiveOptions> = {}) => fakeMassive({ tickers: market.tickers, grouped: market.grouped, ...over });
  return { client, storage, base, fake, tick: (ms: number) => { now += ms; } };
}

// Session data only (the security master and membership files are refreshed by every run).
const SESSION_DATA = ["permanent/daily-bars/", "permanent/daily-reply-dust/", "permanent/daily-bars-sidecar/"];
const snapshot = async (client: MemoryObjectClient) => {
  const out = new Map<string, string>();
  for (const prefix of SESSION_DATA)
    for (const key of await client.list(prefix)) out.set(key, Buffer.from((await client.get(key))!).toString("base64"));
  assert.ok(out.size > 0);
  return out;
};

test("a complete run stores, packs and sha-verifies every session, with no duplicate rows", async () => {
  const { base, fake } = rig();
  const f = fake();
  const report = await runBackfillJob(base(f, "2026-01-20", "2026-01-23"));
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.checkpointSessions, 4);
  assert.equal(report.packsWritten, 4);
  assert.equal(report.sessionsVerified, 4);
  assert.equal(report.barRows, 24);
  assert.equal(report.distinctBarKeys, 24);
  assert.deepEqual(f.calls.grouped, ["2026-01-20", "2026-01-21", "2026-01-22", "2026-01-23"]);
  assert.equal(report.requests, 2 + 4 * 3); // two ticker passes, then grouped + splits + dividends per session
});

test("a restart partway resumes after the last completed session; nothing is fetched or written twice", async () => {
  const { client, base, fake } = rig();
  let fail = true;
  const first = fake({ onRequest: (url) => (fail && url.pathname.endsWith("/2026-01-22") ? new Response('{"status":"ERROR"}', { status: 500 }) : undefined) });
  const stopped = await runBackfillJob(base(first, "2026-01-20", "2026-01-23"));
  assert.equal(stopped.status, "STOPPED_RESUMABLE");
  assert.equal(stopped.stopReason, "SESSION_FAILED");
  assert.equal(stopped.checkpointSessions, 2);
  assert.deepEqual(Object.keys(stopped.failedSessions), ["2026-01-22"]);
  const before = await snapshot(client);
  fail = false;
  const second = fake();
  const resumed = await runBackfillJob(base(second, "2026-01-20", "2026-01-23"));
  assert.equal(resumed.status, "COMPLETE");
  assert.deepEqual(second.calls.grouped, ["2026-01-22", "2026-01-23"]);
  assert.equal(resumed.packsWritten, 2);
  assert.equal(resumed.packsAlreadySealed, 2);
  assert.equal(resumed.sessionsVerified, 4);
  assert.equal(resumed.barRows, resumed.distinctBarKeys);
  const after = await snapshot(client);
  for (const [key, bytes] of before) if (/2026-01-2[01]/u.test(key)) assert.equal(after.get(key), bytes, key);
});

test("losing the checkpoint does not re-fetch or overwrite a stored session", async () => {
  const { client, base, fake } = rig();
  await runBackfillJob(base(fake(), "2026-01-20", "2026-01-21"));
  const before = await snapshot(client);
  await client.delete("backfill-state.json");
  const again = fake();
  const report = await runBackfillJob(base(again, "2026-01-20", "2026-01-21"));
  assert.equal(report.status, "COMPLETE");
  assert.deepEqual(again.calls.grouped, []);
  assert.equal(report.packsWritten, 0);
  assert.equal(report.packsAlreadySealed, 2);
  assert.deepEqual(await snapshot(client), before);
});

test("a sha mismatch in a stored pack or Reply Dust file refuses the run", async () => {
  const { client, base, fake } = rig();
  await runBackfillJob(base(fake(), "2026-01-20", "2026-01-22"));
  const packKey = dailyBarsSidecarFileKey("2026-01-21");
  const pack = (await client.get(packKey))!;
  const bad = Uint8Array.from(pack);
  bad.set([bad.at(-1)! ^ 0xff], bad.length - 1);
  await client.put(packKey, bad);
  const refused = await runBackfillJob(base(fake(), "2026-01-20", "2026-01-22"));
  assert.equal(refused.status, "REFUSED_SHA_MISMATCH");
  assert.deepEqual(refused.shaMismatches, ["2026-01-21"]);
  await client.put(packKey, pack);
  const dustKey = dailyReplyDustFileKey("2026-01-22");
  const dust = Uint8Array.from((await client.get(dustKey))!);
  dust.set([dust.at(-1)! ^ 0xff], dust.length - 1);
  await client.put(dustKey, dust);
  const refusedDust = await runBackfillJob(base(fake(), "2026-01-20", "2026-01-22"));
  assert.equal(refusedDust.status, "REFUSED_SHA_MISMATCH");
  assert.deepEqual(refusedDust.shaMismatches, ["2026-01-22"]);
});

test("the rate limit is respected: no two provider requests closer than the configured spacing", async () => {
  const { base, fake } = rig(12_500);
  const report = await runBackfillJob(base(fake(), "2026-01-20", "2026-01-22"));
  assert.equal(report.status, "COMPLETE");
  assert.ok(report.minRequestGapMs !== null && report.minRequestGapMs >= 12_500, String(report.minRequestGapMs));
  assert.ok(report.elapsedMs >= (report.requests - 1) * 12_500);
});

test("a 403 plan-window reply stops cleanly at the session boundary; after an upgrade the same range resumes", async () => {
  const { base, fake } = rig();
  // Plan reaches back to 2021-11-01 (like a 5-year tier on 2026-11-01); the range starts before it.
  const stopped = await runBackfillJob(base(fake({ planFrom: "2021-11-01" }), "2021-10-28", "2021-11-03"));
  assert.equal(stopped.status, "STOPPED_RESUMABLE");
  assert.equal(stopped.stopReason, "PLAN_WINDOW");
  assert.equal(stopped.checkpointSessions, 0);
  assert.match(stopped.failedSessions["2021-10-28"] ?? "", /MASSIVE_HTTP_403/);
  const upgraded = fake({ planFrom: "2021-10-01" });
  const resumed = await runBackfillJob(base(upgraded, "2021-10-28", "2021-11-03"));
  assert.equal(resumed.status, "COMPLETE");
  assert.equal(resumed.checkpointSessions, 5);
  assert.equal(resumed.sessionsVerified, 5);
});

test("a 403 in the middle keeps every earlier session; the mocked paid-tier window completes", async () => {
  const { base, fake } = rig();
  const plan = fake({ onRequest: (url) => (url.pathname.endsWith("/2021-11-10") ? new Response('{"status":"NOT_AUTHORIZED","message":"Your plan doesn\'t include this data timeframe."}', { status: 403 }) : undefined) });
  const stopped = await runBackfillJob(base(plan, "2021-11-08", "2021-11-12"));
  assert.equal(stopped.stopReason, "PLAN_WINDOW");
  assert.equal(stopped.checkpointSessions, 2);
  assert.equal(stopped.sessionsVerified, 2);
  const paid = await runBackfillJob(base(fake({ planFrom: "2021-11-01" }), "2021-11-08", "2021-11-12"));
  assert.equal(paid.status, "COMPLETE");
  assert.equal(paid.checkpointSessions, 5);
});

test("stop classification", () => {
  assert.equal(classifyStop("MASSIVE_HTTP_403:requestId=x:body=Your plan doesn't include this data timeframe"), "PLAN_WINDOW");
  assert.equal(classifyStop("MASSIVE_HTTP_403:requestId=x:body=NOT_AUTHORIZED"), "NOT_AUTHORIZED");
  assert.equal(classifyStop("MASSIVE_CREDENTIAL_REJECTED:x"), "CREDENTIAL_REJECTED");
  assert.equal(classifyStop("PROVIDER_NOT_READY:/x"), "PROVIDER_NOT_READY");
  assert.equal(classifyStop("MASSIVE_HTTP_500"), "SESSION_FAILED");
});
