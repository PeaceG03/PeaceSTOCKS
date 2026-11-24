// The missed-freeze alert marker is claimed with one conditional put (If-None-Match: *) before the alert
// goes out; 412 means another run already alerted. Head-then-put let the scan job's last step and the :47
// tick (different concurrency groups) both see no marker and both comment.
import assert from "node:assert/strict";
import test from "node:test";
import type { PredictionStatus } from "./contracts";
import { runFreezeWatch } from "./freeze-watch";
import { MemoryObjectClient, R2ObjectClient } from "./object-store";
import { MISSED_FREEZE_ALERT_PREFIX } from "./scan-health";

const NOW = new Date("2026-10-06T15:00:00.000Z"); // judged: Oct 5, Oct 2, Oct 1
const MISSED: Record<string, Partial<PredictionStatus>[]> = {
  "2026-10-05": [{ status: "FROZEN", predictedAt: "2026-10-06T05:40:00.000Z" }],
  "2026-10-01": [{ status: "FROZEN", predictedAt: "2026-10-02T05:40:00.000Z" }],
  // Oct 2: no record -> missed
};
const MARKER = `${MISSED_FREEZE_ALERT_PREFIX}2026-10-02.json`;

function statusLine(sessionDate: string, r: Partial<PredictionStatus>): string {
  return JSON.stringify({
    schemaVersion: "prediction-status-v1", predictionStatusId: `ps-${sessionDate}`, sessionDate, status: "FROZEN",
    reason: "PREDICTIONS_FROZEN", scannerVersion: "t", configFingerprint: "f", recordedAt: `${sessionDate}T23:59:59.999Z`,
    sourceRunId: "scan_x", supersedesPredictionIds: [], nextSessionOpen: "", ...r,
  });
}

function seed(client: { put(k: string, b: Uint8Array): Promise<void> }) {
  return Promise.all(Object.entries(MISSED).map(([d, list]) =>
    client.put(`permanent/prediction-status/${d}.jsonl`, new TextEncoder().encode(list.map((r) => statusLine(d, r)).join("\n") + "\n"))));
}

test("two racing runs (scan job end and the :47 tick) alert once: the marker is a conditional put", async () => {
  const client = new MemoryObjectClient();
  await seed(client);
  let calls = 0;
  const slowAlert = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return "commented #1";
  };
  const [a, b] = await Promise.all([
    runFreezeWatch({ store: client, env: {}, now: NOW, alert: slowAlert as never }),
    runFreezeWatch({ store: client, env: {}, now: NOW, alert: slowAlert as never }),
  ]);
  assert.equal(calls, 1, "one alert for one missed session");
  assert.deepEqual([...a.alerted, ...b.alerted], ["2026-10-02"]);
  const marker = JSON.parse(new TextDecoder().decode((await client.get(MARKER))!)) as { alert: string };
  assert.equal(marker.alert, "commented #1");
});

/** Fake R2 with If-None-Match: * (412 when the key exists), HEAD metadata and DELETE. */
function fakeR2() {
  const objects = new Map<string, { body: Uint8Array; meta: Record<string, string> }>();
  const seen: Array<{ method: string; key: string; headers: Headers }> = [];
  const client = new R2ObjectClient({
    accountId: "account", bucket: "bucket", accessKeyId: "test-access-key", secretAccessKey: "test-secret-key",
    now: () => new Date("2026-10-06T15:00:00.000Z"), sleep: async () => {},
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      const key = decodeURIComponent(new URL(String(input)).pathname.replace(/^\/bucket\//u, ""));
      seen.push({ method, key, headers });
      if (method === "PUT") {
        if (headers.get("if-none-match") === "*" && objects.has(key)) return new Response(null, { status: 412 });
        const meta: Record<string, string> = {};
        headers.forEach((v, n) => { if (n.startsWith("x-amz-meta-")) meta[n] = v; });
        objects.set(key, { body: new Uint8Array(init?.body as Uint8Array), meta });
        return new Response(null, { status: 200 });
      }
      if (method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
      const found = objects.get(key);
      if (!found) return new Response(null, { status: 404 });
      if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(found.body.length), ...found.meta } });
      return new Response(found.body, { status: 200, headers: { etag: `"${found.body.length}"` } });
    },
  });
  return { client, objects, seen };
}

test("R2: the marker claim is a signed If-None-Match: * PUT; 412 is already alerted (no alert, no overwrite)", async () => {
  const { client, objects, seen } = fakeR2();
  await seed(client);
  let calls = 0;
  const alert = async () => { calls += 1; return "commented #1"; };
  const first = await runFreezeWatch({ store: client, env: {}, now: NOW, alert: alert as never });
  assert.deepEqual(first.alerted, ["2026-10-02"]);
  const claim = seen.find((r) => r.key === MARKER && r.method === "PUT");
  assert.equal(claim?.headers.get("if-none-match"), "*");
  assert.match(claim?.headers.get("authorization") ?? "", /SignedHeaders=host;if-none-match;/u);
  assert.equal(seen.some((r) => r.key === MARKER && r.method === "HEAD" && seen.indexOf(r) < seen.indexOf(claim!)), false, "no head-then-put");
  const written = new TextDecoder().decode(objects.get(MARKER)!.body);
  seen.length = 0;
  const second = await runFreezeWatch({ store: client, env: {}, now: NOW, alert: alert as never });
  assert.deepEqual(second.alerted, []);
  assert.equal(calls, 1);
  assert.equal(new TextDecoder().decode(objects.get(MARKER)!.body), written, "412: the marker is kept as it was");
  assert.deepEqual(seen.filter((r) => r.key === MARKER).map((r) => `${r.method}:${r.headers.get("if-none-match")}`), ["PUT:*", "GET:null"]); // 412, then one read: the marker is ALERTED, not an expired claim
});

test("a failed alert releases the claim, so the next run retries", async () => {
  const { client, objects } = fakeR2();
  await seed(client);
  const failing = async () => { throw new Error("HEALTH_ALERT_GITHUB_500:POST"); };
  await assert.rejects(runFreezeWatch({ store: client, env: {}, now: NOW, alert: failing as never }), /HEALTH_ALERT_GITHUB_500/u);
  assert.equal(objects.has(MARKER), false);
  let calls = 0;
  const ok = async () => { calls += 1; return "commented #2"; };
  const retry = await runFreezeWatch({ store: client, env: {}, now: NOW, alert: ok as never });
  assert.deepEqual([retry.alerted, calls], [["2026-10-02"], 1]);
});

test("R2 putIfAbsent: true when written, false on 412, throws on any other status", async () => {
  const { client } = fakeR2();
  assert.equal(await client.putIfAbsent("k/x.json", new Uint8Array([1])), true);
  assert.equal(await client.putIfAbsent("k/x.json", new Uint8Array([2])), false);
  assert.deepEqual([...(await client.get("k/x.json"))!], [1]);
  const denied = new R2ObjectClient({ accountId: "a", bucket: "bucket", accessKeyId: "k", secretAccessKey: "s", sleep: async () => {}, fetchImpl: async () => new Response(null, { status: 403 }) });
  await assert.rejects(denied.putIfAbsent("k/x.json", new Uint8Array([1])), /R2_PUT_403/u);
});
