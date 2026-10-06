import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { securityId } from "./identity";
import { MemoryObjectClient, type ObjectMetadata } from "./object-store";
import { sha256Hex } from "./intraday-reply-dust";
import { MassiveMarketProvider } from "./massive-provider";
import { nodeReplyDustBackend } from "./reply-dust";
import {
  TENMIN_RANGE_ENTRIES_CONFLICT,
  TENMIN_RANGE_MANIFEST_COMPACT_SCHEMA,
  TENMIN_RANGE_MANIFEST_FAT_SCHEMA,
  buildTenMinRangeCompactManifest,
  compressTenMinRangeEntries,
  encodeTenMinRangeEntriesBody,
  parseTenMinRangeCompactManifest,
  tenMinRangeEntriesObjectKey,
  writeTenMinRangeEntriesObjectVerified,
  type TenMinRangeEntryRecord,
} from "./tenmin-range-entries";
import { GROUPED_DAILY_MISSING } from "./tenmin-grouped-daily";
import {
  TENMIN_DELISTED_COVERAGE_COMPLETE,
  TENMIN_DELISTED_COVERAGE_MISSING,
  TENMIN_RANGE_MANIFEST_SCHEMA,
  buildTenMinRangeManifest,
  readTenMinRangeManifest,
  resolveTenMinDelistedCoverageForSeal,
  tenMinRangeFileKey,
  tenMinRangeManifestKey,
  writeTenMinRangeManifest,
  writeTenMinRangeReplyDust,
  type TenMinRangePlannedFetch,
} from "./tenmin-range-reply-dust";

const FROM = "2026-01-02";
const TO = "2026-01-06";
const PROVIDER = "massive-stocks";
const FETCHED_AT = "2026-01-07T03:00:00.000Z";
const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";
const t = (iso: string) => Date.parse(iso);
const bar = (iso: string, price: number, v = 100) =>
  `{"v":${v},"vw":${price},"o":${price},"c":${price + 0.01},"h":${price + 0.02},"l":${price - 0.01},"t":${t(iso)},"n":3}`;
const base = (symbol: string) =>
  `https://api.massive.com/v2/aggs/ticker/${symbol}/range/10/minute/${FROM}/${TO}`;
const page = (symbol: string, n: number, bars: string[], next?: number) =>
  `{"ticker":"${symbol}","adjusted":false,"results":[${bars.join(",")}],"status":"OK","request_id":"SYNTHETIC-${symbol}-p${n}"${
    next ? `,"next_url":"${base(symbol)}?cursor=p${next}"` : ""
  },"count":${bars.length}}`;

const PAGES: Record<string, string[]> = {
  AAA: [
    page("AAA", 1, [bar("2026-01-02T14:30:00Z", 100), bar("2026-01-05T14:30:00Z", 101)], 2),
    page("AAA", 2, [bar("2026-01-06T14:30:00Z", 102)]),
  ],
  BBB: [page("BBB", 1, [bar("2026-01-06T15:10:00Z", 5.5, 10)])],
  MULTI: [
    page("MULTI", 1, [bar("2026-01-02T14:30:00Z", 1)], 2),
    page("MULTI", 2, [bar("2026-01-05T14:30:00Z", 2)], 3),
    page("MULTI", 3, [bar("2026-01-06T14:30:00Z", 3)]),
  ],
};
const id = (symbol: string) => securityId(PROVIDER, symbol, "STOCK");

function fakeMassive(pages: Record<string, string[]> = PAGES): MassiveMarketProvider {
  return new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    now: () => FETCHED_AT,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      const symbol = decodeURIComponent(/\/v2\/aggs\/ticker\/([^/]+)\/range\/10\/minute\//u.exec(url.pathname)?.[1] ?? "");
      const n = Number(url.searchParams.get("cursor")?.slice(1) ?? "1");
      const body = pages[symbol]?.[n - 1];
      if (!body) return new Response('{"status":"ERROR"}', { status: 500 });
      return new Response(body, { status: 200 });
    },
  });
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-seal-v2-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function seal(
  store: MemoryObjectClient,
  root: string,
  fetches: TenMinRangePlannedFetch[],
  pages: Record<string, string[]> = PAGES,
  extra: { reopen?: boolean } = {},
) {
  const provider = fakeMassive(pages);
  return writeTenMinRangeReplyDust({
    store,
    root,
    provider: PROVIDER,
    from: FROM,
    to: TO,
    fetches,
    fetchPages: (s, f, t) => provider.getTenMinuteRangeReplies!(s, f, t),
    zstdVersionProbe: pinnedZstd,
    ...(extra.reopen ? { reopen: true } : {}),
  });
}

test("seal produces compact v2 manifest + entries and NO fat schema", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const result = await seal(store, root, [
      { securityId: id("AAA"), symbol: "AAA", fetchFrom: FROM, fetchTo: TO },
    ]);
    assert.equal(result.sealed, true);
    assert.equal(result.manifest?.schemaVersion, TENMIN_RANGE_MANIFEST_COMPACT_SCHEMA);
    assert.notEqual(result.manifest?.schemaVersion, TENMIN_RANGE_MANIFEST_SCHEMA);
    assert.notEqual(result.manifest?.schemaVersion, TENMIN_RANGE_MANIFEST_FAT_SCHEMA);
    const raw = JSON.parse(new TextDecoder().decode((await store.get(tenMinRangeManifestKey(FROM, TO)))!)) as {
      schemaVersion: string;
      entriesKey: string;
    };
    assert.equal(raw.schemaVersion, TENMIN_RANGE_MANIFEST_COMPACT_SCHEMA);
    assert.ok(raw.entriesKey.includes("/entries-"));
    assert.ok(await store.get(raw.entriesKey));
    const read = (await readTenMinRangeManifest(store, FROM, TO))!;
    assert.equal(read.securityCount, 1);
    assert.equal(read.fileCount, 2); // AAA has 2 pages
  });
});

test("readback after seal matches stored pages", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    await seal(store, root, [
      { securityId: id("AAA"), symbol: "AAA", fetchFrom: FROM, fetchTo: TO },
      { securityId: id("BBB"), symbol: "BBB", fetchFrom: FROM, fetchTo: TO },
    ]);
    const read = (await readTenMinRangeManifest(store, FROM, TO))!;
    assert.equal(read.securities.length, 2);
    assert.equal(read.gaps.length, 0);
    assert.ok(await store.get(tenMinRangeFileKey(FROM, TO, id("AAA"), "AAA", FROM, TO, 1)));
    assert.ok(await store.get(tenMinRangeFileKey(FROM, TO, id("AAA"), "AAA", FROM, TO, 2)));
  });
});

test("failed entries write leaves unsealed; retry seals", async () => {
  await withRoot(async (root) => {
    let entriesPuts = 0;
    const base = new MemoryObjectClient();
    const store = {
      get: (k: string) => base.get(k),
      head: (k: string) => base.head(k),
      list: (p: string) => base.list(p),
      put: async (k: string, body: Uint8Array, metadata?: ObjectMetadata) => {
        if (k.includes("/entries-") && k.endsWith(".bin.zst")) {
          entriesPuts += 1;
          if (entriesPuts === 1) throw new Error("STORE_DOWN");
        }
        await base.put(k, body, metadata);
      },
    };
    const fetches = [{ securityId: id("BBB"), symbol: "BBB", fetchFrom: FROM, fetchTo: TO }];
    await assert.rejects(() => seal(store as MemoryObjectClient, root, fetches), /STORE_DOWN/);
    assert.equal(await base.get(tenMinRangeManifestKey(FROM, TO)), undefined);
    const ok = await seal(store as MemoryObjectClient, root, fetches);
    assert.equal(ok.sealed, true);
  });
});

test("failed manifest write leaves unsealed; retry reuses identical entries object", async () => {
  await withRoot(async (root) => {
    let manifestPuts = 0;
    const base = new MemoryObjectClient();
    const store = {
      get: (k: string) => base.get(k),
      head: (k: string) => base.head(k),
      list: (p: string) => base.list(p),
      put: async (k: string, body: Uint8Array, metadata?: ObjectMetadata) => {
        if (k.endsWith("/manifest.json")) {
          manifestPuts += 1;
          if (manifestPuts === 1) throw new Error("STORE_DOWN");
        }
        await base.put(k, body, metadata);
      },
    };
    const fetches = [{ securityId: id("BBB"), symbol: "BBB", fetchFrom: FROM, fetchTo: TO }];
    await assert.rejects(() => seal(store as MemoryObjectClient, root, fetches), /STORE_DOWN/);
    const entriesKeys = (await base.list(`permanent/tenmin-reply-dust/${FROM}_${TO}/`)).filter((k) =>
      k.includes("/entries-"),
    );
    assert.equal(entriesKeys.length, 1);
    const bytes = await base.get(entriesKeys[0]!);
    const ok = await seal(store as MemoryObjectClient, root, fetches);
    assert.equal(ok.sealed, true);
    const entriesKeys2 = (await base.list(`permanent/tenmin-reply-dust/${FROM}_${TO}/`)).filter((k) =>
      k.includes("/entries-"),
    );
    assert.deepEqual(entriesKeys2, entriesKeys);
    assert.deepEqual(await base.get(entriesKeys[0]!), bytes);
  });
});

test("entries object conflict when key exists with different bytes", async () => {
  const store = new MemoryObjectClient();
  const records: TenMinRangeEntryRecord[] = [
    {
      securityId: id("AAA"),
      symbol: "AAA",
      fetchFrom: FROM,
      fetchTo: TO,
      pageNumber: 1,
      pageCount: 1,
      replySha256: sha256Hex("reply"),
      byteLength: 10,
      status: "STORED",
    },
  ];
  const body = encodeTenMinRangeEntriesBody(records);
  const { bodySha256, compressed } = compressTenMinRangeEntries(body);
  const key = tenMinRangeEntriesObjectKey(FROM, TO, bodySha256);
  const wrong = new Uint8Array(compressed);
  wrong[0] = (wrong[0] ?? 0) ^ 0xff;
  await store.put(key, wrong);
  await assert.rejects(
    () => writeTenMinRangeEntriesObjectVerified(store, FROM, TO, records, nodeReplyDustBackend),
    new RegExp(TENMIN_RANGE_ENTRIES_CONFLICT),
  );
});

test("reopen of v1-sealed range then reseal writes v2", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    // First produce real objects via v2 seal, then overwrite manifest with a fat v1 pointer
    // that still lists the same securities — dual reader reads fat; reopen reseals as v2.
    await seal(store, root, [{ securityId: id("BBB"), symbol: "BBB", fetchFrom: FROM, fetchTo: TO }]);
    const live = (await readTenMinRangeManifest(store, FROM, TO))!;
    const fat = buildTenMinRangeManifest({
      provider: PROVIDER,
      from: FROM,
      to: TO,
      securities: live.securities,
      gaps: live.gaps,
    });
    assert.equal(fat.schemaVersion, TENMIN_RANGE_MANIFEST_SCHEMA);
    await writeTenMinRangeManifest(store, fat);
    assert.equal((await readTenMinRangeManifest(store, FROM, TO))!.schemaVersion, TENMIN_RANGE_MANIFEST_SCHEMA);

    const resealed = await seal(
      store,
      root,
      [{ securityId: id("BBB"), symbol: "BBB", fetchFrom: FROM, fetchTo: TO }],
      PAGES,
      { reopen: true },
    );
    assert.equal(resealed.sealed, true);
    assert.equal(resealed.manifest?.schemaVersion, TENMIN_RANGE_MANIFEST_COMPACT_SCHEMA);
    const raw = JSON.parse(new TextDecoder().decode((await store.get(tenMinRangeManifestKey(FROM, TO)))!)) as {
      schemaVersion: string;
    };
    assert.equal(raw.schemaVersion, TENMIN_RANGE_MANIFEST_COMPACT_SCHEMA);
  });
});

test("reopen of v2-sealed range: already sealed makes 0 requests", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const fetches = [{ securityId: id("BBB"), symbol: "BBB", fetchFrom: FROM, fetchTo: TO }];
    await seal(store, root, fetches);
    let calls = 0;
    const provider = fakeMassive();
    const again = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: FROM,
      to: TO,
      fetches,
      fetchPages: async (s, f, t) => {
        calls += 1;
        return provider.getTenMinuteRangeReplies!(s, f, t);
      },
      zstdVersionProbe: pinnedZstd,
    });
    assert.equal(again.alreadySealed, true);
    assert.equal(calls, 0);
  });
});

test("multi-page fetch round-trips through v2 seal", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const result = await seal(store, root, [
      { securityId: id("MULTI"), symbol: "MULTI", fetchFrom: FROM, fetchTo: TO },
    ]);
    assert.equal(result.sealed, true);
    assert.equal(result.filesWritten, 3);
    const read = (await readTenMinRangeManifest(store, FROM, TO))!;
    assert.equal(read.fileCount, 3);
    assert.equal(read.securities[0]?.fetches[0]?.pageCount, 3);
    for (const page of [1, 2, 3]) {
      assert.ok(await store.get(tenMinRangeFileKey(FROM, TO, id("MULTI"), "MULTI", FROM, TO, page)));
    }
  });
});

test("delistedCoverage never COMPLETE while GROUPED_DAILY_MISSING gap is open", () => {
  assert.equal(
    resolveTenMinDelistedCoverageForSeal(TENMIN_DELISTED_COVERAGE_COMPLETE, [
      { securityId: "", symbol: "", reason: GROUPED_DAILY_MISSING, at: "x", fetchFrom: FROM, fetchTo: FROM },
    ]),
    TENMIN_DELISTED_COVERAGE_MISSING,
  );
  assert.equal(
    resolveTenMinDelistedCoverageForSeal(TENMIN_DELISTED_COVERAGE_COMPLETE, []),
    TENMIN_DELISTED_COVERAGE_COMPLETE,
  );
});

test("size: 7363 single-page seal artifacts — manifest.json + entries total bytes", () => {
  const records: TenMinRangeEntryRecord[] = [];
  for (let i = 0; i < 7363; i++) {
    records.push({
      securityId: `sec_${String(i).padStart(5, "0")}`,
      symbol: `T${String(i).padStart(5, "0")}`,
      fetchFrom: FROM,
      fetchTo: TO,
      pageNumber: 1,
      pageCount: 1,
      replySha256: sha256Hex(`r${i}`),
      byteLength: 10000 + (i % 97),
      status: "STORED",
    });
  }
  const body = encodeTenMinRangeEntriesBody(records);
  const { bodySha256, compressed } = compressTenMinRangeEntries(body, nodeReplyDustBackend);
  const manifest = buildTenMinRangeCompactManifest({
    provider: PROVIDER,
    rangeFrom: FROM,
    rangeTo: TO,
    records,
    entriesSha256: bodySha256,
    entriesByteLength: compressed.length,
  });
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const total = manifestBytes.length + compressed.length;
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      fetches: 7363,
      entriesRaw: body.length,
      entriesZstd: compressed.length,
      manifestJson: manifestBytes.length,
      totalManifestPlusEntries: total,
    }),
  );
  assert.ok(total < 2_000_000);
  assert.equal(manifest.schemaVersion, TENMIN_RANGE_MANIFEST_COMPACT_SCHEMA);
  parseTenMinRangeCompactManifest(manifestBytes);
});
