import assert from "node:assert/strict";
import test from "node:test";
import { MemoryObjectClient, R2ObjectClient } from "./object-store";
import { paperLedgerKey, PaperLedgerStore, type PaperDay } from "./paper-ledger";
import { ledgerObjectClient } from "./paper-trading-cli";

const config = {
  accountId: "account",
  bucket: "bucket",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  now: () => new Date("2026-01-02T22:00:00.000Z"),
  sleep: async () => {},
};

/** A fake R2 that implements If-None-Match: * the way R2/S3 does: 412 when the key exists. */
function fakeR2() {
  const objects = new Map<string, Uint8Array>();
  const seen: Array<{ method: string; headers: Headers }> = [];
  const client = new R2ObjectClient({
    ...config,
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      seen.push({ method, headers });
      const key = new URL(String(input)).pathname;
      if (method === "PUT") {
        if (headers.get("if-none-match") === "*" && objects.has(key)) return new Response(null, { status: 412 });
        objects.set(key, new Uint8Array(init?.body as Uint8Array));
        return new Response(null, { status: 200 });
      }
      const found = objects.get(key);
      return found ? new Response(found, { status: 200 }) : new Response(null, { status: 404 });
    },
  });
  return { client, objects, seen };
}

const day = (equityTo: number) => ({ schemaVersion: "paper-day-v1", equityTo }) as unknown as PaperDay;

test("R2 putIfAbsent sends a signed If-None-Match: * and reads 412 as 'already there'", async () => {
  const { client, seen } = fakeR2();
  assert.equal(await client.putIfAbsent("paper/v1/days/2026-12-02.json", new Uint8Array([1])), true);
  assert.equal(await client.putIfAbsent("paper/v1/days/2026-12-02.json", new Uint8Array([2])), false);
  for (const request of seen) {
    assert.equal(request.headers.get("if-none-match"), "*");
    assert.match(request.headers.get("authorization") ?? "", /SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date,/u);
  }
  assert.deepEqual([...(await client.get("paper/v1/days/2026-12-02.json"))!], [1]);
});

test("R2 putIfAbsent: any other failure throws (never reported as written or kept)", async () => {
  const client = new R2ObjectClient({ ...config, fetchImpl: async () => new Response(null, { status: 403 }) });
  await assert.rejects(client.putIfAbsent("paper/v1/days/2026-12-02.json", new Uint8Array([1])), /R2_PUT_403/u);
});

test("ledger putOnce is one conditional put: no read-then-write, and a racing writer cannot overwrite", async () => {
  const { client, objects, seen } = fakeR2();
  const store = new PaperLedgerStore(ledgerObjectClient(client));
  const key = paperLedgerKey("days", "2026-12-02");
  // Another writer (outside the concurrency group) got there first.
  objects.set(`/bucket/${key}`, new TextEncoder().encode(`${JSON.stringify(day(1))}\n`));
  assert.equal(await store.putOnce(key, day(2)), "KEPT_EXISTING");
  assert.deepEqual(seen.map((r) => r.method), ["PUT"]);
  assert.equal((await store.read<PaperDay>(key))!.equityTo, 1);
});

test("ledger client refuses a store without conditional puts; the memory store honours them", async () => {
  const memory = new MemoryObjectClient();
  assert.equal(await memory.putIfAbsent("k", new Uint8Array([1])), true);
  assert.equal(await memory.putIfAbsent("k", new Uint8Array([2])), false);
  assert.deepEqual([...(await memory.get("k"))!], [1]);
  const noConditional = { get: memory.get.bind(memory), put: memory.put.bind(memory), list: memory.list.bind(memory), head: memory.head.bind(memory), delete: memory.delete.bind(memory) };
  assert.throws(() => ledgerObjectClient(noConditional), /PAPER_LEDGER_NEEDS_CONDITIONAL_PUT/u);
});
