import assert from "node:assert/strict";
import test from "node:test";
import { MemoryObjectClient, R2ObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";

/** A store that refuses body reads, so measuring storage must not download objects. */
class NoGetClient extends MemoryObjectClient {
  gets = 0;
  lists = 0;
  override async get(): Promise<Uint8Array | undefined> {
    this.gets += 1;
    throw new Error("R2_REQUEST_FAILED:GET:The operation was aborted due to timeout");
  }
  override async listSizes(prefix: string) {
    this.lists += 1;
    return super.listSizes(prefix);
  }
}

async function seeded(): Promise<NoGetClient> {
  const client = new NoGetClient();
  await client.put("permanent/daily-bars/2026-11.jsonl", new Uint8Array(1000));
  await client.put("permanent/tenmin-reply-dust/r/a.rd", new Uint8Array(5000));
  await client.put("cache/x", new Uint8Array(30));
  await client.put("transient/y", new Uint8Array(7));
  await client.put("runs/z.json", new Uint8Array(11));
  return client;
}

test("measureStorage sums sizes from the listing and never GETs object bodies", async () => {
  const client = await seeded();
  const report = await new ObjectMarketStorage(client).measureStorage();
  assert.equal(client.gets, 0);
  assert.equal(report.permanentBytesToday, 6000);
  assert.deepEqual(report.categoryBytes, { permanent: 6000, cache: 30, transient: 7 });
});

test("measureStorage lists the bucket once per storage instance (one host run)", async () => {
  const client = await seeded();
  const storage = new ObjectMarketStorage(client);
  await storage.measureStorage();
  await storage.measureStorage();
  await storage.measureStorage();
  assert.equal(client.lists, 1);
});

test("R2 listSizes reads Key and Size from every page", async () => {
  const pages = [
    `<ListBucketResult><Contents><Key>b</Key><Size>20</Size></Contents><Contents><Key>a&amp;1</Key><Size>10</Size></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken></ListBucketResult>`,
    `<ListBucketResult><Contents><Key>c</Key><LastModified>x</LastModified><Size>30</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`,
  ];
  const seen: string[] = [];
  const r2 = new R2ObjectClient({
    accountId: "acct",
    bucket: "bucket",
    accessKeyId: "id",
    secretAccessKey: "secret",
    fetchImpl: async (url) => {
      seen.push(new URL(String(url)).searchParams.get("continuation-token") ?? "");
      return new Response(pages[seen.length - 1], { status: 200 });
    },
    sleep: async () => {},
  });
  assert.deepEqual(await r2.listSizes(""), [
    { key: "a&1", size: 10 },
    { key: "b", size: 20 },
    { key: "c", size: 30 },
  ]);
  assert.deepEqual(seen, ["", "t1"]);
});
