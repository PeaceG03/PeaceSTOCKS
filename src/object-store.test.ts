import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileReplyDustStore } from "./intraday-reply-dust";
import {
  MemoryObjectClient,
  OBJECT_METADATA_MAX_BYTES,
  R2ObjectClient,
  assertObjectMetadata,
  decodeRfc2047Value,
} from "./object-store";

const config = {
  accountId: "account",
  bucket: "bucket",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  now: () => new Date("2026-01-02T22:00:00.000Z"),
};
const metadata = {
  "rd-request": "/v2/aggs/ticker/AAA/range/10/minute/2026-01-02/2026-01-02?adjusted=false&sort=asc&limit=50000",
  "rd-reply-sha256": "ab".repeat(32),
};

test("R2 put sends custom metadata as signed x-amz-meta-* headers", async () => {
  const seen: Array<{ url: string; method: string; headers: Headers; body?: unknown }> = [];
  const client = new R2ObjectClient({
    ...config,
    fetchImpl: async (input, init) => {
      seen.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body });
      return new Response(null, { status: 200 });
    },
  });
  await client.put("permanent/x/a.rdust", new Uint8Array([1, 2, 3]), metadata);
  const request = seen[0]!;
  assert.equal(request.method, "PUT");
  assert.equal(request.url, "https://account.r2.cloudflarestorage.com/bucket/permanent/x/a.rdust");
  assert.equal(request.headers.get("x-amz-meta-rd-request"), metadata["rd-request"]);
  assert.equal(request.headers.get("x-amz-meta-rd-reply-sha256"), metadata["rd-reply-sha256"]);
  const auth = request.headers.get("authorization") ?? "";
  assert.match(
    auth,
    /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-meta-rd-reply-sha256;x-amz-meta-rd-request,/u,
  );
  assert.ok(!auth.includes("test-secret-key"));
  // Without metadata the signature covers only the original three headers, as before.
  await client.put("permanent/x/b", new Uint8Array([1]));
  assert.match(seen[1]!.headers.get("authorization") ?? "", /SignedHeaders=host;x-amz-content-sha256;x-amz-date,/u);
  assert.equal([...seen[1]!.headers.keys()].some((name) => name.startsWith("x-amz-meta-")), false);
});

test("R2 head reads x-amz-meta-* back and 404 means missing", async () => {
  const client = new R2ObjectClient({
    ...config,
    fetchImpl: async (input, init) => {
      assert.equal(init?.method, "HEAD");
      assert.equal(init?.body, undefined);
      if (String(input).endsWith("/missing")) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200,
        headers: { "content-length": "826", "x-amz-meta-rd-request": metadata["rd-request"], "X-Amz-Meta-Rd-Version": "1", etag: '"x"' },
      });
    },
  });
  assert.deepEqual(await client.head("permanent/x/a.rdust"), {
    size: 826,
    metadata: { "rd-request": metadata["rd-request"], "rd-version": "1" },
  });
  assert.equal(await client.head("permanent/x/missing"), undefined);
});

test("R2 list follows continuation tokens past the 1000-key page", async () => {
  const pages: string[] = [];
  const client = new R2ObjectClient({
    ...config,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      pages.push(url.searchParams.get("continuation-token") ?? "");
      if (!url.searchParams.get("continuation-token"))
        return new Response("<ListBucketResult><Contents><Key>p/b</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;2</NextContinuationToken></ListBucketResult>");
      return new Response("<ListBucketResult><Contents><Key>p/a&amp;c</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>");
    },
  });
  assert.deepEqual(await client.list("p/"), ["p/a&c", "p/b"]);
  assert.deepEqual(pages, ["", "t&2"]);
});

test("metadata over 2 KB or with non-ASCII values is rejected by every store, nothing written", async () => {
  const big = { "rd-request": "x".repeat(OBJECT_METADATA_MAX_BYTES) };
  assert.throws(() => assertObjectMetadata(big), /OBJECT_METADATA_TOO_LARGE:\d+/u);
  assert.throws(() => assertObjectMetadata({ "rd-symbol": "Ä" }), /OBJECT_METADATA_VALUE_NOT_ASCII/u);
  assert.throws(() => assertObjectMetadata({ "Bad Name": "x" }), /OBJECT_METADATA_NAME_INVALID/u);
  const memory = new MemoryObjectClient();
  await assert.rejects(memory.put("k", new Uint8Array([1]), big), /OBJECT_METADATA_TOO_LARGE/u);
  assert.deepEqual(await memory.list(""), []);
  let calls = 0;
  const r2 = new R2ObjectClient({ ...config, fetchImpl: async () => { calls += 1; return new Response(null); } });
  await assert.rejects(r2.put("k", new Uint8Array([1]), big), /OBJECT_METADATA_TOO_LARGE/u);
  assert.equal(calls, 0);
  const root = await mkdtemp(join(tmpdir(), "peacestocks-object-meta-"));
  try {
    const file = new FileReplyDustStore(root);
    await assert.rejects(file.put("permanent/x/a.rdust", new Uint8Array([1]), big), /OBJECT_METADATA_TOO_LARGE/u);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the local file store keeps metadata in a hidden sidecar and lists only objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-object-meta-"));
  try {
    const file = new FileReplyDustStore(root);
    await file.put("permanent/x/2026-01-02/a.rdust", new Uint8Array([1, 2, 3]), metadata);
    await file.put("permanent/x/2026-01-02/manifest.json", new Uint8Array([4]));
    await file.put("permanent/x/2026-01-03/b.rdust", new Uint8Array([5]));
    assert.deepEqual(await file.head("permanent/x/2026-01-02/a.rdust"), { size: 3, metadata });
    assert.deepEqual(await file.head("permanent/x/2026-01-03/b.rdust"), { size: 1, metadata: {} });
    assert.equal(await file.head("permanent/x/2026-01-02/none.rdust"), undefined);
    assert.deepEqual(await file.list("permanent/x/2026-01-02/"), [
      "permanent/x/2026-01-02/a.rdust",
      "permanent/x/2026-01-02/manifest.json",
    ]);
    assert.deepEqual(await file.list("permanent/x/"), [
      "permanent/x/2026-01-02/a.rdust",
      "permanent/x/2026-01-02/manifest.json",
      "permanent/x/2026-01-03/b.rdust",
    ]);
    const memory = new MemoryObjectClient();
    await memory.put("a", new Uint8Array([1, 2]), metadata);
    assert.deepEqual(await memory.head("a"), { size: 2, metadata });
    await memory.put("a", new Uint8Array([1]));
    assert.deepEqual(await memory.head("a"), { size: 1, metadata: {} });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- RFC 2047 metadata values (R2 encodes values containing / ? = & on HEAD) ----

const PRODUCTION_ENCODED =
  "=?utf-8?Q?=2Fv2=2Faggs?= =?utf-8?Q?=2Fticker=2F?= =?utf-8?Q?IBTP=2Fran?= =?utf-8?Q?ge=2F10=2Fmi?= =?utf-8?Q?nute=2F202?= =?utf-8?Q?4-11-01=2F?= =?utf-8?Q?2024-12-?= =?utf-8?Q?31=3Fadjus?=ted=false&sort=asc&limit=50000";

test("decodeRfc2047Value decodes R2's encoded words and leaves plain values alone", () => {
  assert.equal(
    decodeRfc2047Value(PRODUCTION_ENCODED),
    "/v2/aggs/ticker/IBTP/range/10/minute/2024-11-01/2024-12-31?adjusted=false&sort=asc&limit=50000",
  );
  // B encoding, case-insensitive charset and encoding letter.
  assert.equal(decodeRfc2047Value(`=?UTF-8?b?${Buffer.from("/a?b=c&d").toString("base64")}?=`), "/a?b=c&d");
  // Mixed plain and encoded: plain text before/after is kept; whitespace only between words dropped.
  assert.equal(decodeRfc2047Value("pre =?utf-8?Q?=2Fx?=  =?us-ascii?q?=3Fy?= post"), "pre /x?y post");
  // Underscore is a space in Q encoding; UTF-8 bytes decode.
  assert.equal(decodeRfc2047Value("=?utf-8?Q?a_b=C3=A9?="), "a bé");
  // Not encoded (has = but no encoded word): unchanged. ISO timestamps unchanged.
  for (const plain of ["adjusted=false&sort=asc", "2026-10-06T08:00:00.000Z", "a=?b", "=?bad", ""])
    assert.equal(decodeRfc2047Value(plain), plain);
  // Unknown charset or broken word is left as is.
  assert.equal(decodeRfc2047Value("=?iso-2022-jp?Q?abc?="), "=?iso-2022-jp?Q?abc?=");
  assert.equal(decodeRfc2047Value("=?utf-8?Q?=ZZ?="), "=?utf-8?Q?=ZZ?=");
});

test("R2 head decodes an RFC 2047 encoded x-amz-meta value", async () => {
  const client = new R2ObjectClient({
    ...config,
    fetchImpl: async () =>
      new Response(null, {
        status: 200,
        headers: { "content-length": "5", "x-amz-meta-rd-request": PRODUCTION_ENCODED, "x-amz-meta-rd-fetched-at": "2026-10-06T08:00:00.000Z" },
      }),
  });
  assert.deepEqual((await client.head("k"))!.metadata, {
    "rd-request": "/v2/aggs/ticker/IBTP/range/10/minute/2024-11-01/2024-12-31?adjusted=false&sort=asc&limit=50000",
    "rd-fetched-at": "2026-10-06T08:00:00.000Z",
  });
});
