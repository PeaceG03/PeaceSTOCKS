// A CLAIMED alert marker left by a run killed between the claim and the alert used to block the alert
// for that session forever. A claim older than 2 hours that never reached the ALERTED state is now taken
// over with one conditional replace (If-Match: <etag>), so exactly one later run re-alerts.
import assert from "node:assert/strict";
import test from "node:test";
import type { PredictionStatus } from "./contracts";
import { MISSED_FREEZE_CLAIM_EXPIRY_MS, runFreezeWatch } from "./freeze-watch";
import { MemoryObjectClient, R2ObjectClient } from "./object-store";
import { MISSED_FREEZE_ALERT_PREFIX } from "./scan-health";

const NOW = new Date("2026-10-06T15:00:00.000Z"); // judged: Oct 5, Oct 2, Oct 1
const MARKER = `${MISSED_FREEZE_ALERT_PREFIX}2026-10-02.json`;
const enc = (v: unknown) => new TextEncoder().encode(`${JSON.stringify(v, null, 2)}\n`);
const dec = (b: Uint8Array | undefined) => (b ? (JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>) : undefined);

function statusLine(sessionDate: string, r: Partial<PredictionStatus>): string {
  return JSON.stringify({
    schemaVersion: "prediction-status-v1", predictionStatusId: `ps-${sessionDate}`, sessionDate, status: "FROZEN",
    reason: "PREDICTIONS_FROZEN", scannerVersion: "t", configFingerprint: "f", recordedAt: `${sessionDate}T23:59:59.999Z`,
    sourceRunId: "scan_x", supersedesPredictionIds: [], nextSessionOpen: "", ...r,
  });
}
/** Oct 5 and Oct 1 frozen on time; Oct 2 has no record (missed). */
async function seed(client: { put(k: string, b: Uint8Array): Promise<void> }) {
  for (const [d, at] of [["2026-10-05", "2026-10-06T05:40:00.000Z"], ["2026-10-01", "2026-10-02T05:40:00.000Z"]] as const)
    await client.put(`permanent/prediction-status/${d}.jsonl`, new TextEncoder().encode(`${statusLine(d, { predictedAt: at })}\n`));
}
/** The claim a killed run left behind (the #132 format: alert "CLAIMED", no state field). */
const leftClaim = (ageMs: number) => enc({ at: new Date(NOW.getTime() - ageMs).toISOString(), sessionDate: "2026-10-02", alert: "CLAIMED" });

function counter() {
  let calls = 0;
  const alert = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return `commented #${calls}`;
  };
  return { alert, calls: () => calls };
}

test("claim expiry is 2 hours", () => assert.equal(MISSED_FREEZE_CLAIM_EXPIRY_MS, 2 * 60 * 60 * 1000));

test("a fresh claim (another run is alerting) blocks: no alert, marker untouched; exactly 2 h still blocks", async () => {
  for (const age of [30 * 60_000, MISSED_FREEZE_CLAIM_EXPIRY_MS]) {
    const client = new MemoryObjectClient();
    await seed(client);
    await client.put(MARKER, leftClaim(age));
    const before = await client.get(MARKER);
    const c = counter();
    const r = await runFreezeWatch({ store: client, env: {}, now: NOW, alert: c.alert as never });
    assert.deepEqual([r.alerted, c.calls()], [[], 0], `age ${age}`);
    assert.deepEqual(await client.get(MARKER), before);
  }
});

test("an expired claim re-alerts once, then the session is ALERTED and stays quiet", async () => {
  const client = new MemoryObjectClient();
  await seed(client);
  await client.put(MARKER, leftClaim(MISSED_FREEZE_CLAIM_EXPIRY_MS + 1));
  const c = counter();
  const first = await runFreezeWatch({ store: client, env: {}, now: NOW, alert: c.alert as never });
  assert.deepEqual([first.alerted, c.calls()], [["2026-10-02"], 1]);
  const marker = dec(await client.get(MARKER))!;
  assert.equal(marker.state, "ALERTED");
  assert.equal(marker.alert, "commented #1");
  // Hours later: ALERTED never expires.
  const later = new Date(NOW.getTime() + 10 * MISSED_FREEZE_CLAIM_EXPIRY_MS);
  const second = await runFreezeWatch({ store: client, env: {}, now: later, alert: c.alert as never });
  assert.deepEqual([second.alerted, c.calls()], [[], 1]);
});

test("an old marker from a run that did alert (no state field, alert != CLAIMED) never re-alerts", async () => {
  const client = new MemoryObjectClient();
  await seed(client);
  await client.put(MARKER, enc({ at: "2026-10-03T15:00:00.000Z", sessionDate: "2026-10-02", alert: "commented #9" }));
  const c = counter();
  const r = await runFreezeWatch({ store: client, env: {}, now: NOW, alert: c.alert as never });
  assert.deepEqual([r.alerted, c.calls()], [[], 0]);
});

test("race: two runs both see the same expired claim; only one takes it over and alerts", async () => {
  const client = new MemoryObjectClient();
  await seed(client);
  await client.put(MARKER, leftClaim(3 * 60 * 60_000));
  const c = counter();
  const [a, b] = await Promise.all([
    runFreezeWatch({ store: client, env: {}, now: NOW, alert: c.alert as never }),
    runFreezeWatch({ store: client, env: {}, now: NOW, alert: c.alert as never }),
  ]);
  assert.equal(c.calls(), 1);
  assert.deepEqual([...a.alerted, ...b.alerted], ["2026-10-02"]);
});

test("a re-claimed expired claim whose alert fails is released, so the next run retries", async () => {
  const client = new MemoryObjectClient();
  await seed(client);
  await client.put(MARKER, leftClaim(3 * 60 * 60_000));
  await assert.rejects(runFreezeWatch({ store: client, env: {}, now: NOW, alert: (async () => { throw new Error("HEALTH_ALERT_GITHUB_500:POST"); }) as never }), /500/u);
  assert.equal(await client.get(MARKER), undefined);
  const c = counter();
  assert.deepEqual((await runFreezeWatch({ store: client, env: {}, now: NOW, alert: c.alert as never })).alerted, ["2026-10-02"]);
});

/** Fake R2: ETag on GET/HEAD, If-None-Match: * and If-Match: <etag> on PUT (412 on mismatch). */
function fakeR2() {
  const objects = new Map<string, { body: Uint8Array; meta: Record<string, string>; etag: string }>();
  const seen: Array<{ method: string; key: string; headers: Headers }> = [];
  let version = 0;
  const client = new R2ObjectClient({
    accountId: "account", bucket: "bucket", accessKeyId: "test-access-key", secretAccessKey: "test-secret-key",
    now: () => NOW, sleep: async () => {},
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      const key = decodeURIComponent(new URL(String(input)).pathname.replace(/^\/bucket\//u, ""));
      seen.push({ method, key, headers });
      const found = objects.get(key);
      if (method === "PUT") {
        if (headers.get("if-none-match") === "*" && found) return new Response(null, { status: 412 });
        const ifMatch = headers.get("if-match");
        if (ifMatch !== null && (!found || found.etag !== ifMatch)) return new Response(null, { status: 412 });
        const meta: Record<string, string> = {};
        headers.forEach((v, n) => { if (n.startsWith("x-amz-meta-")) meta[n] = v; });
        objects.set(key, { body: new Uint8Array(init?.body as Uint8Array), meta, etag: `"e${++version}"` });
        return new Response(null, { status: 200 });
      }
      if (method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
      if (!found) return new Response(null, { status: 404 });
      if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(found.body.length), etag: found.etag, ...found.meta } });
      return new Response(found.body, { status: 200, headers: { etag: found.etag } });
    },
  });
  return { client, objects, seen };
}

test("R2: an expired claim is taken over with a signed If-Match: <etag> PUT; a changed object is 412 (no alert)", async () => {
  const { client, objects, seen } = fakeR2();
  await seed(client);
  await client.put(MARKER, leftClaim(3 * 60 * 60_000));
  const etag = objects.get(MARKER)!.etag;
  const c = counter();
  const r = await runFreezeWatch({ store: client, env: {}, now: NOW, alert: c.alert as never });
  assert.deepEqual([r.alerted, c.calls()], [["2026-10-02"], 1]);
  const takeover = seen.find((s) => s.key === MARKER && s.method === "PUT" && s.headers.get("if-match") !== null);
  assert.equal(takeover?.headers.get("if-match"), etag);
  assert.match(takeover?.headers.get("authorization") ?? "", /SignedHeaders=host;if-match;/u);
  // putIfMatch directly: stale etag or missing key -> false, current etag -> true; other statuses throw.
  assert.equal(await client.putIfMatch(MARKER, enc({ x: 1 }), etag), false);
  const current = (await client.getWithEtag(MARKER))!;
  assert.equal(current.etag, objects.get(MARKER)!.etag);
  assert.equal(await client.putIfMatch(MARKER, enc({ x: 2 }), current.etag), true);
  assert.equal(await client.putIfMatch("none.json", enc({}), current.etag), false);
  assert.equal(await client.getWithEtag("none.json"), undefined);
  const denied = new R2ObjectClient({ accountId: "a", bucket: "bucket", accessKeyId: "k", secretAccessKey: "s", sleep: async () => {}, fetchImpl: async () => new Response(null, { status: 403 }) });
  await assert.rejects(denied.putIfMatch("k.json", enc({}), '"e1"'), /R2_PUT_403/u);
});

test("memory store: putIfMatch replaces only the version it read", async () => {
  const m = new MemoryObjectClient();
  await m.put("k", enc({ v: 1 }));
  const first = (await m.getWithEtag("k"))!;
  await m.put("k", enc({ v: 2 }));
  assert.equal(await m.putIfMatch("k", enc({ v: 3 }), first.etag), false);
  const second = (await m.getWithEtag("k"))!;
  assert.notEqual(second.etag, first.etag);
  assert.equal(await m.putIfMatch("k", enc({ v: 3 }), second.etag), true);
  assert.equal(dec(await m.get("k"))!.v, 3);
  assert.equal(await m.putIfMatch("missing", enc({}), second.etag), false);
});

test("state ALERTED is authoritative: even an old marker that says ALERTED with alert CLAIMED never re-alerts", async () => {
  const client = new MemoryObjectClient();
  await seed(client);
  await client.put(MARKER, enc({ at: "2026-10-03T15:00:00.000Z", sessionDate: "2026-10-02", alert: "CLAIMED", state: "ALERTED" }));
  const c = counter();
  const r = await runFreezeWatch({ store: client, env: {}, now: NOW, alert: c.alert as never });
  assert.deepEqual([r.alerted, c.calls()], [[], 0]);
});

test("an unreadable marker blocks (never treated as an expired claim)", async () => {
  const client = new MemoryObjectClient();
  await seed(client);
  await client.put(MARKER, new TextEncoder().encode("not json"));
  const c = counter();
  const r = await runFreezeWatch({ store: client, env: {}, now: NOW, alert: c.alert as never });
  assert.deepEqual([r.alerted, c.calls()], [[], 0]);
  assert.equal(new TextDecoder().decode((await client.get(MARKER))!), "not json");
});

test("R2 getWithEtag: a GET without an ETag throws (a replace must name the version it read)", async () => {
  const noEtag = new R2ObjectClient({ accountId: "a", bucket: "bucket", accessKeyId: "k", secretAccessKey: "s", sleep: async () => {}, fetchImpl: async () => new Response(new Uint8Array([1]), { status: 200 }) });
  await assert.rejects(noEtag.getWithEtag("k.json"), /R2_GET_NO_ETAG/u);
});
