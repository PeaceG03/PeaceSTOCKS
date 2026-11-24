import assert from "node:assert/strict";
import test from "node:test";
import { R2ObjectClient, r2BodyTimeoutMs } from "./object-store";

const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

/** A 200 reply whose body stream fails partway, like a GET whose transfer outlives its timeout. */
function brokenBody(contentLength: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.error(timeoutError());
    },
  });
  return new Response(stream, { status: 200, headers: { "content-length": String(contentLength) } });
}

function client(fetchImpl: typeof fetch): R2ObjectClient {
  return new R2ObjectClient({
    accountId: "acct",
    bucket: "bucket",
    accessKeyId: "id",
    secretAccessKey: "secret",
    fetchImpl,
    now: () => new Date("2026-11-21T17:00:00.000Z"),
    sleep: async () => {},
  });
}

test("R2 GET: a body read that times out is retried, not thrown raw", async () => {
  let calls = 0;
  const r2 = client(async () => {
    calls += 1;
    return calls === 1 ? brokenBody(9) : new Response(new Uint8Array([7, 8, 9]), { status: 200 });
  });
  assert.deepEqual(await r2.get("permanent/daily-bars/2026-11.jsonl"), new Uint8Array([7, 8, 9]));
  assert.equal(calls, 2);
});

test("R2 GET: a body that keeps timing out fails as R2_REQUEST_FAILED:GET with the cause kept", async () => {
  let calls = 0;
  const r2 = client(async () => {
    calls += 1;
    return brokenBody(9);
  });
  await assert.rejects(
    () => r2.get("runs/x.json"),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "R2_REQUEST_FAILED:GET:The operation was aborted due to timeout" &&
      (error.cause as Error).name === "TimeoutError",
  );
  assert.equal(calls, 3);
});

test("R2 LIST: a page body that times out is retried", async () => {
  let calls = 0;
  const page = `<?xml version="1.0"?><ListBucketResult><Contents><Key>runs/a.json</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`;
  const r2 = client(async () => {
    calls += 1;
    return calls === 1 ? brokenBody(page.length) : new Response(page, { status: 200 });
  });
  assert.deepEqual(await r2.list("runs/"), ["runs/a.json"]);
  assert.equal(calls, 2);
});

test("R2 HEAD and 404 still work with the body read inside the retry loop", async () => {
  const r2 = client(async (_url, init) =>
    (init as RequestInit).method === "HEAD"
      ? new Response(null, { status: 200, headers: { "content-length": "42", "x-amz-meta-a": "b" } })
      : new Response("missing", { status: 404 }),
  );
  assert.deepEqual(await r2.head("k"), { size: 42, metadata: { a: "b" } });
  assert.equal(await r2.get("k"), undefined);
});

test("r2BodyTimeoutMs: 30 s floor, grows with size at 256 KiB/s, capped at 15 min", () => {
  assert.equal(r2BodyTimeoutMs(Number.NaN), 30_000);
  assert.equal(r2BodyTimeoutMs(0), 30_000);
  assert.equal(r2BodyTimeoutMs(256 * 1024), 31_000);
  assert.equal(r2BodyTimeoutMs(64 * 1024 * 1024), 30_000 + 256_000);
  assert.equal(r2BodyTimeoutMs(10 * 1024 * 1024 * 1024), 15 * 60_000);
});
