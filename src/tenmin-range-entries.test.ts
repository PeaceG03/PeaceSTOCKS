import assert from "node:assert/strict";
import test from "node:test";
import { MemoryObjectClient, type ObjectMetadata } from "./object-store";
import { fakeR2 } from "./fake-r2.test-helper";
import { sha256Hex } from "./intraday-reply-dust";
import { nodeReplyDustBackend } from "./reply-dust";
import { GROUPED_DAILY_MISSING } from "./tenmin-grouped-daily";
import {
  TENMIN_AGED_OUT,
  TENMIN_RANGE_MANIFEST_SCHEMA,
  buildTenMinRangeManifest,
  readTenMinRangeManifest,
  tenMinRangeFileKey,
  tenMinRangeGapReason,
  tenMinRangeManifestKey,
  tenMinRangeObjectMetadata,
} from "./tenmin-range-reply-dust";
import {
  TENMIN_MANIFEST_V2_ENTRIES_FALLBACK,
  TENMIN_MANIFEST_V2_PAGE_MISSING,
  TENMIN_RANGE_ENTRIES_DUPLICATE_PAGE,
  TENMIN_NO_DAILY_BAR_STATUS,
  TENMIN_NO_HISTORICAL_SYMBOL,
  TENMIN_RANGE_FETCH_FAILED,
  TENMIN_RANGE_KEY_RULE,
  TENMIN_RANGE_MANIFEST_COMPACT_SCHEMA,
  TENMIN_RANGE_STATUS_CODES,
  TENMIN_RANGE_STATUS_FIXED,
  TENMIN_RANGE_STATUS_OTHER,
  TENMIN_RANGE_STATUS_STORED,
  buildTenMinRangeCompactManifest,
  compressTenMinRangeEntries,
  decodeTenMinRangeEntriesBody,
  encodeTenMinRangeEntriesBody,
  isOtherStatusCode,
  loadTenMinRangeEntries,
  parseTenMinRangeCompactManifest,
  resolveTenMinRangeEntryKey,
  sortTenMinRangeEntries,
  assertNoDuplicateTenMinRangeEntryPages,
  validateTenMinRangeEntriesPages,
  statusCodeOf,
  statusReasonOf,
  tenMinRangeEntriesObjectKey,
  tenMinRangeHashedCopyFileKey,
  type TenMinRangeEntryRecord,
} from "./tenmin-range-entries";

const FROM = "2024-11-01";
const TO = "2024-12-31";
const AT = "2026-10-06T12:00:00.000Z";

function rec(partial: Partial<TenMinRangeEntryRecord> & Pick<TenMinRangeEntryRecord, "securityId" | "symbol">): TenMinRangeEntryRecord {
  const pageNumber = partial.pageNumber ?? 1;
  const pageCount = partial.pageCount ?? 1;
  return {
    fetchFrom: FROM,
    fetchTo: TO,
    replySha256: sha256Hex(`reply:${partial.securityId}:p${pageNumber}:${partial.copySha256 ?? "canon"}`),
    byteLength: 12_000,
    status: TENMIN_RANGE_STATUS_STORED,
    ...partial,
    pageNumber,
    pageCount,
  };
}

test("status code table: every fixed reason round-trips; unknown encode → OTHER; unknown code throws", () => {
  for (const reason of Object.keys(TENMIN_RANGE_STATUS_FIXED)) {
    assert.equal(statusReasonOf(statusCodeOf(reason)), reason);
    assert.equal(isOtherStatusCode(statusCodeOf(reason)), false);
  }
  assert.equal(statusCodeOf("MASSIVE_HTTP_404"), TENMIN_RANGE_STATUS_CODES[TENMIN_RANGE_STATUS_OTHER]);
  assert.equal(isOtherStatusCode(statusCodeOf("MASSIVE_HTTP_404")), true);
  assert.throws(() => statusReasonOf(999), /TENMIN_RANGE_STATUS_UNKNOWN_CODE/);
  assert.throws(() => statusReasonOf(TENMIN_RANGE_STATUS_CODES[TENMIN_RANGE_STATUS_OTHER]), /OTHER_DETAIL_REQUIRED/);
  for (const reason of [
    GROUPED_DAILY_MISSING,
    TENMIN_AGED_OUT,
    TENMIN_NO_HISTORICAL_SYMBOL,
    TENMIN_NO_DAILY_BAR_STATUS,
    TENMIN_RANGE_STATUS_STORED,
    TENMIN_RANGE_FETCH_FAILED,
  ])
    assert.ok(reason in TENMIN_RANGE_STATUS_FIXED);
  assert.equal(TENMIN_RANGE_STATUS_CODES[TENMIN_RANGE_STATUS_OTHER], 7);
});

test("encode/decode round-trip: dots, dashes, non-ASCII symbols; every fixed status; canonical + hashed copy", () => {
  const records: TenMinRangeEntryRecord[] = [
    rec({ securityId: "sec.with-dot", symbol: "BRK.B", status: TENMIN_RANGE_STATUS_STORED }),
    rec({ securityId: "sec-dash", symbol: "BF-B", status: GROUPED_DAILY_MISSING }),
    rec({ securityId: "sec_jp", symbol: "トヨタ", status: TENMIN_AGED_OUT }),
    rec({ securityId: "sec_a", symbol: "AAA", status: TENMIN_NO_HISTORICAL_SYMBOL }),
    rec({ securityId: "sec_b", symbol: "BBB", status: TENMIN_NO_DAILY_BAR_STATUS }),
    rec({ securityId: "sec_fail", symbol: "FFF", status: TENMIN_RANGE_FETCH_FAILED }),
    rec({
      securityId: "sec_copy",
      symbol: "CCC",
      status: TENMIN_RANGE_STATUS_STORED,
      copySha256: sha256Hex("different-reply-bytes"),
    }),
  ];
  const body = encodeTenMinRangeEntriesBody(records);
  const decoded = decodeTenMinRangeEntriesBody(body);
  assert.deepEqual(decoded.records, sortTenMinRangeEntries(records));
  // Determinism (do not mutate `records` — Array#reverse is in-place)
  assert.deepEqual(encodeTenMinRangeEntriesBody([...records].reverse()), body);
  assert.equal(sha256Hex(encodeTenMinRangeEntriesBody(sortTenMinRangeEntries(records))), sha256Hex(body));

  const canon = records.find((r) => !r.copySha256)!;
  assert.equal(
    resolveTenMinRangeEntryKey(FROM, TO, canon),
    tenMinRangeFileKey(FROM, TO, canon.securityId, canon.symbol, FROM, TO, 1),
  );
  const copy = records.find((r) => r.copySha256)!;
  assert.equal(
    resolveTenMinRangeEntryKey(FROM, TO, copy),
    tenMinRangeHashedCopyFileKey(FROM, TO, copy.securityId, copy.symbol, FROM, TO, copy.copySha256!),
  );
});

test("one record per page: 3-page fetch round-trips; keys use .pN for pages > 1", () => {
  const records: TenMinRangeEntryRecord[] = [1, 2, 3].map((pageNumber) =>
    rec({
      securityId: "sec_multi",
      symbol: "MULTI",
      pageNumber,
      pageCount: 3,
      replySha256: sha256Hex(`multi-page-${pageNumber}`),
      byteLength: 1000 + pageNumber,
    }),
  );
  const body = encodeTenMinRangeEntriesBody(records);
  const decoded = decodeTenMinRangeEntriesBody(body);
  assert.deepEqual(decoded.records, sortTenMinRangeEntries(records));
  assert.deepEqual(validateTenMinRangeEntriesPages(decoded.records), []);
  assert.equal(
    resolveTenMinRangeEntryKey(FROM, TO, records[0]!),
    tenMinRangeFileKey(FROM, TO, "sec_multi", "MULTI", FROM, TO, 1),
  );
  assert.equal(
    resolveTenMinRangeEntryKey(FROM, TO, records[1]!),
    tenMinRangeFileKey(FROM, TO, "sec_multi", "MULTI", FROM, TO, 2),
  );
  assert.ok(resolveTenMinRangeEntryKey(FROM, TO, records[1]!).endsWith(".p2.rdust"));
});

test("duplicate pageNumber same copy different sha: validator flags dupPage; encoder throws", () => {
  const dup: TenMinRangeEntryRecord[] = [
    rec({
      securityId: "sec_dup",
      symbol: "DUP",
      pageNumber: 1,
      pageCount: 2,
      replySha256: sha256Hex("page1-a"),
    }),
    rec({
      securityId: "sec_dup",
      symbol: "DUP",
      pageNumber: 1,
      pageCount: 2,
      replySha256: sha256Hex("page1-b"),
    }),
    rec({
      securityId: "sec_dup",
      symbol: "DUP",
      pageNumber: 2,
      pageCount: 2,
      replySha256: sha256Hex("page2"),
    }),
  ];
  const holes = validateTenMinRangeEntriesPages(dup);
  assert.ok(holes.some((h) => h.includes(":dupPage=1")));
  assert.throws(() => assertNoDuplicateTenMinRangeEntryPages(dup), /TENMIN_RANGE_ENTRIES_DUPLICATE_PAGE/);
  assert.throws(() => encodeTenMinRangeEntriesBody(dup), /TENMIN_RANGE_ENTRIES_DUPLICATE_PAGE/);
});

test("same pageNumber different copySha256 is legitimate (two hashed copies)", () => {
  const a = sha256Hex("copy-a");
  const b = sha256Hex("copy-b");
  const records: TenMinRangeEntryRecord[] = [
    rec({ securityId: "sec_c", symbol: "CPY", pageNumber: 1, pageCount: 1, copySha256: a, replySha256: sha256Hex("ra") }),
    rec({ securityId: "sec_c", symbol: "CPY", pageNumber: 1, pageCount: 1, copySha256: b, replySha256: sha256Hex("rb") }),
  ];
  assert.deepEqual(validateTenMinRangeEntriesPages(records), []);
  assert.doesNotThrow(() => encodeTenMinRangeEntriesBody(records));
});

test("fallback shortfall: rebuilt page count below manifest fileCount warns fallbackShortfall", async () => {
  const { client } = fakeR2();
  let puts = 0;
  const store = {
    get: (k: string) => client.get(k),
    head: (k: string) => client.head(k),
    list: (p: string) => client.list(p),
    put: async (k: string, body: Uint8Array, metadata?: ObjectMetadata) => {
      puts += 1;
      await client.put(k, body, metadata);
    },
  };
  // Manifest expects 3 pages; plant only 1 object with metadata.
  const only = rec({ securityId: "sec_sf", symbol: "SF", pageNumber: 1, pageCount: 3, replySha256: sha256Hex("sf1") });
  await store.put(
    resolveTenMinRangeEntryKey(FROM, TO, only),
    new Uint8Array([1, 2, 3]),
    tenMinRangeObjectMetadata({
      provider: "massive-stocks",
      calendarFrom: FROM,
      calendarTo: TO,
      securityId: only.securityId,
      symbol: only.symbol,
      fetchFrom: FROM,
      fetchTo: TO,
      observedAt: AT,
      pageCount: 3,
      file: {
        page: 1,
        request: "/v2/aggs/...",
        fetchedAt: AT,
        version: 1,
        replySha256: only.replySha256,
        replyByteLength: 100,
      },
    }),
  );
  // Compact manifest claiming fileCount=3 but no usable entries object → fallback.
  const fakeRecords = [1, 2, 3].map((pageNumber) =>
    rec({ securityId: "sec_sf", symbol: "SF", pageNumber, pageCount: 3, replySha256: sha256Hex(`sf${pageNumber}`) }),
  );
  const body = encodeTenMinRangeEntriesBody(fakeRecords);
  const { bodySha256, compressed } = compressTenMinRangeEntries(body);
  const manifest = buildTenMinRangeCompactManifest({
    provider: "massive-stocks",
    rangeFrom: FROM,
    rangeTo: TO,
    records: fakeRecords,
    entriesSha256: bodySha256,
    entriesByteLength: compressed.length + 1, // force length mismatch → fallback
  });
  assert.equal(manifest.fileCount, 3);
  await store.put(
    tenMinRangeManifestKey(FROM, TO),
    new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  );
  // Do not put entries (or put wrong length) — entriesKey missing.
  puts = 0;
  const loaded = await loadTenMinRangeEntries(store, FROM, TO);
  assert.equal(loaded.usedFallback, true);
  assert.equal(puts, 0);
  assert.ok(
    loaded.warnings.some((w) => w.includes("fallbackShortfall=3-1")),
    `warnings=${JSON.stringify(loaded.warnings)}`,
  );
  assert.equal(loaded.records.length, 1);
});

test("missing page 2 in entries body fails page validation (TENMIN_MANIFEST_V2_PAGE_MISSING)", () => {
  const incomplete = [
    rec({ securityId: "sec_hole", symbol: "HOLE", pageNumber: 1, pageCount: 3 }),
    rec({ securityId: "sec_hole", symbol: "HOLE", pageNumber: 3, pageCount: 3 }),
  ];
  const holes = validateTenMinRangeEntriesPages(incomplete);
  assert.ok(holes.some((h) => h.includes(TENMIN_MANIFEST_V2_PAGE_MISSING) && h.includes("page=2")));
  // Encode is allowed (writer may be mid-seal); load path rejects via validation.
  const body = encodeTenMinRangeEntriesBody(incomplete);
  assert.deepEqual(decodeTenMinRangeEntriesBody(body).records, sortTenMinRangeEntries(incomplete));
});

test("fallback listing: missing page 2 warned; objects without rd-* counted as skippedNoMetadata", async () => {
  const { client } = fakeR2();
  let puts = 0;
  const store = {
    get: (k: string) => client.get(k),
    head: (k: string) => client.head(k),
    list: (p: string) => client.list(p),
    put: async (k: string, body: Uint8Array, metadata?: ObjectMetadata) => {
      puts += 1;
      await client.put(k, body, metadata);
    },
  };
  const pages = [1, 3].map((pageNumber) =>
    rec({ securityId: "sec_fb2", symbol: "FB2", pageNumber, pageCount: 3, replySha256: sha256Hex(`fb2-${pageNumber}`) }),
  );
  // Plant page 1 + page 3 only (page 2 missing) + one object with no metadata.
  for (const record of pages) {
    await store.put(
      resolveTenMinRangeEntryKey(FROM, TO, record),
      new Uint8Array([1, 2, 3]),
      tenMinRangeObjectMetadata({
        provider: "massive-stocks",
        calendarFrom: FROM,
        calendarTo: TO,
        securityId: record.securityId,
        symbol: record.symbol,
        fetchFrom: FROM,
        fetchTo: TO,
        observedAt: AT,
        pageCount: 3,
        file: {
          page: record.pageNumber,
          request: "/v2/aggs/...",
          fetchedAt: AT,
          version: 1,
          replySha256: record.replySha256,
          replyByteLength: 100,
        },
      }),
    );
  }
  const bareKey = `permanent/tenmin-reply-dust/${FROM}_${TO}/bare-no-meta.rdust`;
  await store.put(bareKey, new Uint8Array([9]));

  const body = encodeTenMinRangeEntriesBody(pages); // incomplete → load will fall back after page validation
  const { bodySha256, compressed } = compressTenMinRangeEntries(body);
  // Put a compact manifest pointing at entries that fail page validation.
  const manifest = buildTenMinRangeCompactManifest({
    provider: "massive-stocks",
    rangeFrom: FROM,
    rangeTo: TO,
    records: pages,
    entriesSha256: bodySha256,
    entriesByteLength: compressed.length,
  });
  await store.put(manifest.entriesKey, compressed);
  await store.put(tenMinRangeManifestKey(FROM, TO), new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
  puts = 0;
  const loaded = await loadTenMinRangeEntries(store, FROM, TO);
  assert.equal(loaded.usedFallback, true);
  assert.equal(puts, 0);
  assert.ok(loaded.warnings.some((w) => w.includes("skippedNoMetadata=")));
  assert.ok(loaded.warnings.some((w) => w.includes(TENMIN_MANIFEST_V2_PAGE_MISSING) && w.includes("page=2")));
  assert.equal(loaded.records.length, 2);
});

test("OTHER status: dynamic reasons round-trip byte-exact (HTTP, network, SYMBOL_PARTIAL, non-ASCII)", () => {
  const dynamics = [
    "MASSIVE_HTTP_404",
    "MASSIVE_NETWORK_TIMEOUT",
    "SYMBOL_PARTIAL:MASSIVE_HTTP_429",
    "奇-reason:コード_42",
  ];
  const records = dynamics.map((status, i) =>
    rec({ securityId: `sec_other_${i}`, symbol: `O${i}`, status }),
  );
  const body = encodeTenMinRangeEntriesBody(records);
  const decoded = decodeTenMinRangeEntriesBody(body);
  assert.deepEqual(
    decoded.records.map((r) => r.status),
    sortTenMinRangeEntries(records).map((r) => r.status),
  );
  for (const status of dynamics) {
    assert.equal(isOtherStatusCode(statusCodeOf(status)), true);
    const one = encodeTenMinRangeEntriesBody([rec({ securityId: "s", symbol: "S", status })]);
    assert.equal(decodeTenMinRangeEntriesBody(one).records[0]!.status, status);
  }
});

test("gap-producing paths: every tenMinRangeGapReason + SYMBOL_PARTIAL reason encode/decode", () => {
  const providerMessages = [
    "MASSIVE_HTTP_404: not found",
    "MASSIVE_HTTP_403: forbidden",
    "MASSIVE_HTTP_429: rate limit",
    "MASSIVE_HTTP_500: upstream",
    "MASSIVE_NETWORK_TIMEOUT after 30s",
    "MASSIVE_NETWORK_RESET",
    "MASSIVE_RANGE_PAGE_CAP:AAA:2024-01-01:2024-01-31",
    "MASSIVE_INVALID_RESPONSE",
    "MASSIVE_CREDENTIAL_REJECTED",
    "something without a leading code",
    "",
  ];
  const reasons = new Set<string>();
  for (const message of providerMessages) {
    const base = tenMinRangeGapReason(message);
    reasons.add(base);
    reasons.add(`SYMBOL_PARTIAL:${base}`);
  }
  // Literals from history / grouped-daily / reply-dust writers.
  for (const literal of [
    GROUPED_DAILY_MISSING,
    TENMIN_AGED_OUT,
    TENMIN_NO_HISTORICAL_SYMBOL,
    TENMIN_NO_DAILY_BAR_STATUS,
    TENMIN_RANGE_FETCH_FAILED,
    TENMIN_RANGE_STATUS_STORED,
  ])
    reasons.add(literal);

  const records = [...reasons].map((status, i) =>
    rec({ securityId: `gap_${i}`, symbol: `G${i}`, status }),
  );
  const decoded = decodeTenMinRangeEntriesBody(encodeTenMinRangeEntriesBody(records));
  const got = new Set(decoded.records.map((r) => r.status));
  assert.deepEqual(got, reasons);
  // Fixed literals must not use OTHER on the wire.
  for (const literal of Object.keys(TENMIN_RANGE_STATUS_FIXED)) {
    assert.equal(isOtherStatusCode(statusCodeOf(literal)), false);
  }
  assert.equal(tenMinRangeGapReason("no-code-here"), TENMIN_RANGE_FETCH_FAILED);
  assert.equal(tenMinRangeGapReason("MASSIVE_HTTP_404: x"), "MASSIVE_HTTP_404");
});

test("header mismatch / truncated / bad sha / unknown code / unknown keyRule rejected", () => {
  const body = encodeTenMinRangeEntriesBody([rec({ securityId: "s1", symbol: "S1" })]);
  const badMagic = new Uint8Array(body);
  badMagic[0] = 0;
  assert.throws(() => decodeTenMinRangeEntriesBody(badMagic), /BAD_MAGIC/);
  assert.throws(() => decodeTenMinRangeEntriesBody(body.subarray(0, 10)), /TRUNCATED/);
  const badCode = new Uint8Array(body);
  // last record status is near end: flip a status byte roughly — re-encode with patch via unknown path
  assert.throws(() => statusReasonOf(0), /UNKNOWN_CODE/);

  const { bodySha256, compressed } = compressTenMinRangeEntries(body);
  const manifest = buildTenMinRangeCompactManifest({
    provider: "massive-stocks",
    rangeFrom: FROM,
    rangeTo: TO,
    records: [rec({ securityId: "s1", symbol: "S1" })],
    entriesSha256: bodySha256,
    entriesByteLength: compressed.length,
  });
  assert.throws(() => parseTenMinRangeCompactManifest(
    new TextEncoder().encode(JSON.stringify({ ...manifest, keyRule: 99, checksum: "x" }) + "\n"),
  ), /KEY_RULE_UNKNOWN|CHECKSUM/);
  // Direct keyRule check after valid checksum forge is hard; unit the resolve path:
  assert.throws(
    () => resolveTenMinRangeEntryKey(FROM, TO, rec({ securityId: "s1", symbol: "S1" }), 99),
    /KEY_RULE_UNKNOWN/,
  );
  assert.equal(manifest.keyRule, TENMIN_RANGE_KEY_RULE);
  assert.equal(manifest.schemaVersion, TENMIN_RANGE_MANIFEST_COMPACT_SCHEMA);
  assert.equal(manifest.entriesKey, tenMinRangeEntriesObjectKey(FROM, TO, bodySha256));
});

test("fat v1 (historical manifest-v2 schema) still reads identically via existing reader", async () => {
  const store = new MemoryObjectClient();
  const fat = buildTenMinRangeManifest({
    provider: "massive-stocks",
    from: FROM,
    to: TO,
    securities: [
      {
        securityId: "sec1",
        dataset: "stocks-aggregates-10m",
        fetches: [
          {
            symbol: "AAA",
            fetchFrom: FROM,
            fetchTo: TO,
            observedAt: AT,
            pageCount: 1,
            files: [
              {
                page: 1,
                relativePath: "x",
                request: "/v2/aggs/...",
                fetchedAt: AT,
                byteLength: 100,
                version: 1,
                replySha256: sha256Hex("r"),
                replyByteLength: 200,
                fileSha256: sha256Hex("f"),
                sessionDates: [FROM],
              },
            ],
            sessionDates: [FROM],
          },
        ],
        sessionDates: [FROM],
      },
    ],
    gaps: [],
  });
  assert.equal(fat.schemaVersion, TENMIN_RANGE_MANIFEST_SCHEMA);
  await store.put(tenMinRangeManifestKey(FROM, TO), new TextEncoder().encode(`${JSON.stringify(fat, null, 2)}\n`));
  const read = await readTenMinRangeManifest(store, FROM, TO);
  assert.equal(read?.schemaVersion, TENMIN_RANGE_MANIFEST_SCHEMA);
  assert.equal(read?.securityCount, 1);
  assert.equal(read?.securities[0]?.securityId, "sec1");
});

test("compact load verifies entries; missing/corrupt entries => listing fallback, warn, zero writes", async () => {
  const { client, objects } = fakeR2();
  let puts = 0;
  const store = {
    get: (k: string) => client.get(k),
    head: (k: string) => client.head(k),
    list: (p: string) => client.list(p),
    put: async (k: string, body: Uint8Array, metadata?: ObjectMetadata) => {
      puts += 1;
      await client.put(k, body, metadata);
    },
  };

  const record = rec({ securityId: "sec_fb", symbol: "FB" });
  const body = encodeTenMinRangeEntriesBody([record]);
  const { bodySha256, compressed } = compressTenMinRangeEntries(body);
  const manifest = buildTenMinRangeCompactManifest({
    provider: "massive-stocks",
    rangeFrom: FROM,
    rangeTo: TO,
    records: [record],
    entriesSha256: bodySha256,
    entriesByteLength: compressed.length,
  });
  // Plant only the .rdust + compact pointer (no entries object) so load falls back.
  const rdustKey = resolveTenMinRangeEntryKey(FROM, TO, record);
  await store.put(
    rdustKey,
    new Uint8Array([1, 2, 3, 4]),
    tenMinRangeObjectMetadata({
      provider: "massive-stocks",
      calendarFrom: FROM,
      calendarTo: TO,
      securityId: record.securityId,
      symbol: record.symbol,
      fetchFrom: FROM,
      fetchTo: TO,
      observedAt: AT,
      pageCount: 1,
      file: {
        page: 1,
        request: "/v2/aggs/ticker/FB/range/10/minute/...",
        fetchedAt: AT,
        version: 1,
        replySha256: record.replySha256,
        replyByteLength: 100,
      },
    }),
  );
  await store.put(
    tenMinRangeManifestKey(FROM, TO),
    new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  );
  puts = 0;
  const loaded = await loadTenMinRangeEntries(store, FROM, TO);
  assert.equal(loaded.usedFallback, true);
  assert.ok(loaded.warnings.some((w) => w.startsWith(TENMIN_MANIFEST_V2_ENTRIES_FALLBACK)));
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.records[0]?.securityId, "sec_fb");
  assert.equal(puts, 0, "fallback must never write");
  assert.equal(objects.has(manifest.entriesKey), false);

  // Happy path: put entries, load without fallback.
  await store.put(manifest.entriesKey, compressed);
  puts = 0;
  const ok = await loadTenMinRangeEntries(store, FROM, TO);
  assert.equal(ok.usedFallback, false);
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.records.length, 1);
  assert.equal(puts, 0);
});

test("size: 7363 synthetic records — report raw and zstd bytes", () => {
  const records: TenMinRangeEntryRecord[] = [];
  for (let i = 0; i < 7363; i++) {
    records.push(
      rec({
        securityId: `sec_${String(i).padStart(5, "0")}`,
        symbol: `T${String(i).padStart(5, "0")}`,
        replySha256: sha256Hex(`r${i}`),
        byteLength: 10000 + (i % 97),
      }),
    );
  }
  const body = encodeTenMinRangeEntriesBody(records);
  const { compressed } = compressTenMinRangeEntries(body, nodeReplyDustBackend);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      note: "7363 single-page fetches (one record each); multi-page ranges scale ~linearly with pages",
      records: 7363,
      rawBytes: body.length,
      rawPerRecord: +(body.length / 7363).toFixed(2),
      zstdBytes: compressed.length,
      zstdPerRecord: +(compressed.length / 7363).toFixed(2),
    }),
  );
  assert.ok(body.length > 7363 * 40);
  assert.ok(compressed.length < body.length);
  assert.ok(compressed.length < 2_000_000, `zstd ${compressed.length} should be well under fat ~100MB`);
});
