import assert from "node:assert/strict";
import test from "node:test";
import { R2ObjectClient } from "./object-store";
import { READ_ONLY_ERROR, ReadOnlyR2Client, readOnlyFetch } from "./r2-read-client";

const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>
<Contents><Key>runs/a.json</Key><Size>12</Size><LastModified>2026-11-24T06:43:12.000Z</LastModified></Contents>
<Contents><Key>runs/b.json</Key><Size>7</Size><LastModified>2026-11-20T01:00:00.000Z</LastModified></Contents></ListBucketResult>`;

function fakeR2() {
  const calls: Array<{ method: string; url: string; auth: string }> = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    calls.push({ method, url: String(input), auth: headers.get("authorization") ?? "" });
    const url = new URL(String(input));
    if (url.searchParams.get("list-type") === "2") return new Response(LIST_XML, { status: 200 });
    if (url.pathname.endsWith("/runs/a.json")) return new Response('{"ok":true}', { status: 200 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const CONFIG = { accountId: "acct", bucket: "bucket", accessKeyId: "READKEYID", secretAccessKey: "read-secret" };

test("read-only R2 client: gets and lists with the read key, listing carries LastModified", async () => {
  const r2 = fakeR2();
  const client = new ReadOnlyR2Client({ ...CONFIG, fetchImpl: r2.fetchImpl, sleep: async () => {} });
  assert.equal(new TextDecoder().decode(await client.get("runs/a.json")), '{"ok":true}');
  assert.equal(await client.get("runs/missing.json"), undefined);
  assert.deepEqual(await client.listSizes("runs/"), [
    { key: "runs/a.json", size: 12, lastModified: "2026-11-24T06:43:12.000Z" },
    { key: "runs/b.json", size: 7, lastModified: "2026-11-20T01:00:00.000Z" },
  ]);
  assert.deepEqual(await client.list("runs/"), ["runs/a.json", "runs/b.json"]);
  assert.ok(r2.calls.length >= 4);
  for (const call of r2.calls) {
    assert.equal(call.method, "GET");
    assert.match(call.url, /^https:\/\/acct\.r2\.cloudflarestorage\.com\/bucket\//u);
    assert.match(call.auth, /Credential=READKEYID\//u);
  }
});

test("read-only R2 client: put and delete throw without any network call; the fetch refuses writes", async () => {
  const r2 = fakeR2();
  const client = new ReadOnlyR2Client({ ...CONFIG, fetchImpl: r2.fetchImpl, sleep: async () => {} });
  await assert.rejects(client.put(), new Error(READ_ONLY_ERROR));
  await assert.rejects(client.delete(), new Error(READ_ONLY_ERROR));
  assert.equal(r2.calls.length, 0);
  const guarded = readOnlyFetch(r2.fetchImpl);
  for (const method of ["PUT", "POST", "DELETE", "PATCH", "put"]) {
    await assert.rejects(guarded("https://acct.r2.cloudflarestorage.com/bucket/x", { method }), new RegExp(`^Error: ${READ_ONLY_ERROR}:`, "u"));
    await assert.rejects(guarded(new Request("https://acct.r2.cloudflarestorage.com/bucket/x", { method: method.toUpperCase(), body: "x" })), /READ_ONLY/u);
  }
  assert.equal(r2.calls.length, 0);
  // Even the full write client, given the guarded fetch, cannot send a PUT.
  const writer = new R2ObjectClient({ ...CONFIG, fetchImpl: guarded, sleep: async () => {} });
  await assert.rejects(writer.put("x", new Uint8Array([1])), /R2_REQUEST_FAILED/u);
  assert.equal(r2.calls.length, 0);
  assert.equal((await guarded("https://acct.r2.cloudflarestorage.com/bucket/runs/a.json")).status, 200);
});

test("read-only R2 client: missing config refuses to start", () => {
  assert.throws(() => new ReadOnlyR2Client({ ...CONFIG, secretAccessKey: undefined }), /R2_CONFIG_REQUIRED/u);
});
