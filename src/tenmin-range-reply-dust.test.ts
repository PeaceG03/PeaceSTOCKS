import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { securityId } from "./identity";
import { readReplyDustSecurityDay, writeReplyDustFile, writeReplyDustManifest } from "./intraday-reply-dust";
import { MassiveMarketProvider } from "./massive-provider";
import { MemoryObjectClient, type ObjectMetadata, OBJECT_METADATA_MAX_BYTES } from "./object-store";
import { REPLY_DUST_FALLBACK_VERSION, REPLY_DUST_VERSION, type ReplyDustBackend, decodeReplyDust, nodeReplyDustBackend } from "./reply-dust";
import {
  TENMIN_RANGE_MANIFEST_SCHEMA,
  TENMIN_RANGE_OBJECT_SCHEMA,
  easternSessionDate,
  loadTenMinRangeProgress,
  readRangeReplies,
  readRangeSecurityDay,
  readTenMinRangeManifest,
  tenMinRangeFileKey,
  tenMinRangeManifestKey,
  tenMinRangeProgressPath,
  writeTenMinRangeReplyDust,
} from "./tenmin-range-reply-dust";

// SYNTHETIC data only: hand-made Massive-shaped range pages, never a real Massive reply.
const FROM = "2026-01-02";
const TO = "2026-01-06";
const PROVIDER = "massive-stocks";
const FETCHED_AT = "2026-01-07T03:00:00.000Z";
const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";
const t = (iso: string) => Date.parse(iso);
const bar = (iso: string, price: number, v = 100) =>
  `{"v":${v},"vw":${price},"o":${price},"c":${price + 0.01},"h":${price + 0.02},"l":${price - 0.01},"t":${t(iso)},"n":3}`;
const base = (symbol: string) => `https://api.massive.com/v2/aggs/ticker/${symbol}/range/10/minute/${FROM}/${TO}`;
const page = (symbol: string, n: number, bars: string[], next?: number) =>
  `{"ticker":"${symbol}","adjusted":false,"results":[${bars.join(",")}],"status":"OK","request_id":"SYNTHETIC-${symbol}-p${n}"${
    next ? `,"next_url":"${base(symbol)}?cursor=p${next}"` : ""
  },"count":${bars.length}}`;

// AAA: two pages, Jan 5 split across both. BBB: one page, bars only on Jan 6. CCC: three pages,
// page 2 holds only an extended-hours bar at 00:50Z on Jan 6, which is 19:50 ET on Jan 5.
const PAGES: Record<string, string[]> = {
  AAA: [
    page("AAA", 1, [bar("2026-01-02T14:30:00Z", 100.12), bar("2026-01-02T14:40:00Z", 100.4), bar("2026-01-02T20:50:00Z", 100.3, 0), bar("2026-01-05T14:30:00Z", 101)], 2),
    page("AAA", 2, [bar("2026-01-05T15:00:00Z", 101.5), bar("2026-01-06T14:30:00Z", 102.25)]),
  ],
  BBB: [page("BBB", 1, [bar("2026-01-06T15:10:00Z", 5.5, 10)])],
  CCC: [
    page("CCC", 1, [bar("2026-01-02T16:00:00Z", 50)], 2),
    page("CCC", 2, [bar("2026-01-06T00:50:00Z", 50.5)], 3),
    page("CCC", 3, [bar("2026-01-06T14:30:00Z", 51), bar("2026-01-06T20:50:00Z", 51.2)]),
  ],
};
const id = (symbol: string) => securityId(PROVIDER, symbol, "STOCK");
const SECURITIES = ["AAA", "BBB", "CCC"].map((symbol) => ({ securityId: id(symbol), symbol }));

function fakeMassive(fetches: Record<string, number>, pages: Record<string, string[]> = PAGES): MassiveMarketProvider {
  return new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    now: () => FETCHED_AT,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      const symbol = /\/v2\/aggs\/ticker\/([^/]+)\/range\/10\/minute\//u.exec(url.pathname)?.[1] ?? "";
      const n = Number(url.searchParams.get("cursor")?.slice(1) ?? "1");
      const body = pages[symbol]?.[n - 1];
      if (!body) return new Response('{"status":"ERROR"}', { status: 500 });
      fetches[symbol] = (fetches[symbol] ?? 0) + 1;
      return new Response(body, { status: 200 });
    },
  });
}

class FailingStore extends MemoryObjectClient {
  failNthRdust = 0;
  override async put(key: string, body: Uint8Array, metadata?: ObjectMetadata): Promise<void> {
    if (key.endsWith(".rdust") && this.failNthRdust > 0 && --this.failNthRdust === 0) throw new Error("STORE_DOWN");
    await super.put(key, body, metadata);
  }
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-tenmin-range-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function write(
  store: MemoryObjectClient,
  root: string,
  fetches: Record<string, number>,
  extra: { securities?: typeof SECURITIES; backend?: ReplyDustBackend; pages?: Record<string, string[]> } = {},
) {
  const provider = fakeMassive(fetches, extra.pages);
  return writeTenMinRangeReplyDust({
    store, root, provider: PROVIDER, from: FROM, to: TO,
    securities: extra.securities ?? SECURITIES,
    fetchPages: (security, from, to) => provider.getTenMinuteRangeReplies(security, from, to),
    zstdVersionProbe: pinnedZstd,
    ...(extra.backend ? { backend: extra.backend } : {}),
  });
}

async function uninterruptedManifest(): Promise<Uint8Array | undefined> {
  return withRoot(async (root) => {
    const store = new MemoryObjectClient();
    await write(store, root, {});
    return store.get(tenMinRangeManifestKey(FROM, TO));
  });
}

const exists = (path: string) => stat(path).then(() => true, () => false);
const encoder = new TextEncoder();

test("range Reply Dust round-trips every page of every security byte-exact under the range layout", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const fetches: Record<string, number> = {};
    const result = await write(store, root, fetches);
    assert.equal(result.alreadySealed, false);
    assert.equal(result.filesWritten, 6);
    assert.equal(result.fallbackFiles, 0);
    assert.equal(result.zstdVersion, "1.5.7");
    assert.equal("warnings" in result, false);
    assert.deepEqual(fetches, { AAA: 2, BBB: 1, CCC: 3 });
    const prefix = `permanent/tenmin-reply-dust/${FROM}_${TO}/`;
    const b64 = (symbol: string) => Buffer.from(id(symbol), "utf8").toString("base64url");
    assert.deepEqual(
      await store.list(prefix),
      [
        `${prefix}${b64("AAA")}.p2.rdust`, `${prefix}${b64("AAA")}.rdust`,
        `${prefix}${b64("BBB")}.rdust`,
        `${prefix}${b64("CCC")}.p2.rdust`, `${prefix}${b64("CCC")}.p3.rdust`, `${prefix}${b64("CCC")}.rdust`,
        `${prefix}manifest.json`,
      ].sort(),
    );
    for (const { securityId: sid, symbol } of SECURITIES) {
      const pages = await readRangeReplies(store, FROM, TO, sid);
      assert.deepEqual(pages.map((p) => p.page), PAGES[symbol]!.map((_, i) => i + 1));
      pages.forEach((p, i) => assert.deepEqual(p.reply, encoder.encode(PAGES[symbol]![i])));
      for (const [i, body] of PAGES[symbol]!.entries()) {
        const stored = (await store.get(tenMinRangeFileKey(FROM, TO, sid, i + 1)))!;
        assert.equal(stored[0], REPLY_DUST_VERSION);
        assert.deepEqual(decodeReplyDust(stored), encoder.encode(body)); // one reply per frame
      }
    }
    assert.deepEqual(await readRangeReplies(store, FROM, TO, id("ZZZ")), []);
    // Progress log is only a speed-up and is removed once the range is sealed.
    assert.equal(await exists(tenMinRangeProgressPath(root, FROM, TO)), false);
    // A sealed range is not fetched or written again.
    const again = await write(store, root, fetches);
    assert.equal(again.alreadySealed, true);
    assert.deepEqual(fetches, { AAA: 2, BBB: 1, CCC: 3 });
  });
});

test("each range object carries its metadata under the 2 KB limit", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    await write(store, root, {});
    const head = await store.head(tenMinRangeFileKey(FROM, TO, id("CCC"), 2));
    assert.ok(head);
    const m = head.metadata;
    assert.deepEqual(Object.keys(m).sort(), [
      "rd-fetched-at", "rd-observed-at", "rd-page", "rd-page-count", "rd-provider", "rd-range-from", "rd-range-to",
      "rd-reply-length", "rd-reply-sha256", "rd-request", "rd-schema", "rd-security-id", "rd-symbol", "rd-version",
    ]);
    assert.equal(m["rd-schema"], TENMIN_RANGE_OBJECT_SCHEMA);
    assert.equal(m["rd-provider"], PROVIDER);
    assert.equal(m["rd-security-id"], id("CCC"));
    assert.equal(m["rd-symbol"], "CCC");
    assert.equal(m["rd-request"], `/v2/aggs/ticker/CCC/range/10/minute/${FROM}/${TO}?cursor=p2`);
    assert.equal(m["rd-fetched-at"], FETCHED_AT);
    assert.equal(m["rd-observed-at"], FETCHED_AT);
    assert.equal(m["rd-version"], String(REPLY_DUST_VERSION));
    assert.equal(m["rd-reply-length"], String(PAGES.CCC![1]!.length));
    assert.equal(m["rd-range-from"], FROM);
    assert.equal(m["rd-range-to"], TO);
    assert.equal(m["rd-page"], "2");
    assert.equal(m["rd-page-count"], "3");
    for (const key of await store.list("permanent/tenmin-reply-dust/")) {
      if (!key.endsWith(".rdust")) continue;
      const meta = (await store.head(key))!.metadata;
      assert.ok(!meta["rd-request"]!.includes("apiKey") && !meta["rd-request"]!.includes("test-key"));
      const bytes = Object.entries(meta).reduce((sum, [k, v]) => sum + "x-amz-meta-".length + k.length + v.length, 0);
      assert.ok(bytes <= OBJECT_METADATA_MAX_BYTES, `${key}: ${bytes}`);
    }
  });
});

test("range manifest is deterministic and its day index uses America/New_York dates", async () => {
  // Bars at 00:50Z on Jan 6 are 19:50 ET on Jan 5.
  assert.equal(easternSessionDate(t("2026-01-06T00:50:00Z")), "2026-01-05");
  assert.equal(easternSessionDate(t("2026-01-06T05:00:00Z")), "2026-01-06");
  const first = await uninterruptedManifest();
  const reordered = await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    await write(store, root, {}, { securities: [...SECURITIES].reverse() });
    return store.get(tenMinRangeManifestKey(FROM, TO));
  });
  assert.ok(first);
  assert.deepEqual(reordered, first);
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    await write(store, root, {});
    const manifest = (await readTenMinRangeManifest(store, FROM, TO))!;
    assert.equal(manifest.schemaVersion, TENMIN_RANGE_MANIFEST_SCHEMA);
    assert.equal(manifest.securityCount, 3);
    assert.equal(manifest.fileCount, 6);
    assert.equal(manifest.fallbackFileCount, 0);
    const sec = (symbol: string) => manifest.securities.find((s) => s.securityId === id(symbol))!;
    const name = (symbol: string, n: number) => tenMinRangeFileKey(FROM, TO, id(symbol), n).split("/").pop()!;
    assert.deepEqual(sec("AAA").sessionDates, ["2026-01-02", "2026-01-05", "2026-01-06"]);
    assert.deepEqual(sec("AAA").files.map((f) => f.sessionDates), [["2026-01-02", "2026-01-05"], ["2026-01-05", "2026-01-06"]]);
    assert.deepEqual(sec("BBB").sessionDates, ["2026-01-06"]);
    assert.deepEqual(sec("CCC").files.map((f) => f.sessionDates), [["2026-01-02"], ["2026-01-05"], ["2026-01-06"]]);
    for (const s of manifest.securities)
      for (const f of s.files) {
        assert.equal(f.relativePath, name(s.symbol, f.page));
        assert.equal(f.version, REPLY_DUST_VERSION);
        assert.match(f.fileSha256, /^[0-9a-f]{64}$/u);
        assert.match(f.replySha256, /^[0-9a-f]{64}$/u);
      }
    const expectedDays = [
      { sessionDate: "2026-01-02", securities: [["AAA", [1]], ["CCC", [1]]] },
      { sessionDate: "2026-01-05", securities: [["AAA", [1, 2]], ["CCC", [2]]] },
      { sessionDate: "2026-01-06", securities: [["AAA", [2]], ["BBB", [1]], ["CCC", [3]]] },
    ] as const;
    const sortIds = (rows: ReadonlyArray<readonly [string, readonly number[]]>) =>
      rows.map(([symbol, pages]) => ({ securityId: id(symbol), files: pages.map((n) => name(symbol, n)) }))
        .sort((a, b) => (a.securityId < b.securityId ? -1 : 1));
    assert.deepEqual(manifest.days, expectedDays.map((day) => ({ sessionDate: day.sessionDate, securities: sortIds(day.securities) })));
  });
});

test("SYNTHETIC: range-split bars equal the one-day Reply Dust path for the same bars", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    await write(store, root, {});
    for (const { securityId: sid, symbol } of SECURITIES)
      for (const sessionDate of ["2026-01-02", "2026-01-05", "2026-01-06"]) {
        // Build the one-day reply from the same raw bars (same ET date), with the request_id of
        // the first range page that has bars that day, and store it through the one-day writer.
        const parsed = PAGES[symbol]!.map((body) => JSON.parse(body) as { results: Array<{ t: number }>; request_id: string });
        const dayBars = parsed.flatMap((p) => p.results.filter((r) => easternSessionDate(r.t) === sessionDate));
        const requestId = (parsed.find((p) => p.results.some((r) => easternSessionDate(r.t) === sessionDate)) ?? parsed[0]!).request_id;
        const oneDayStore = new MemoryObjectClient();
        const entry = await writeReplyDustFile(
          oneDayStore,
          {
            dataset: "stocks-aggregates-10m", sessionDate, securityId: sid, symbol,
            request: `/v2/aggs/ticker/${symbol}/range/10/minute/${sessionDate}/${sessionDate}`, fetchedAt: FETCHED_AT,
            body: encoder.encode(JSON.stringify({ ticker: symbol, results: dayBars, status: "OK", request_id: requestId })),
          },
          { provider: PROVIDER, observedAt: FETCHED_AT },
        );
        await writeReplyDustManifest(oneDayStore, { provider: PROVIDER, sessionDate, files: [entry] });
        const oneDay = await readReplyDustSecurityDay(oneDayStore, sessionDate, sid);
        const fromRange = await readRangeSecurityDay(store, FROM, TO, sid, sessionDate);
        assert.equal(fromRange.length, 39);
        assert.deepEqual(fromRange, oneDay, `${symbol} ${sessionDate}`);
      }
    // The 19:50 ET bar on Jan 5 is outside the regular session: the normalizer drops it on both paths.
    const ccc = await readRangeSecurityDay(store, FROM, TO, id("CCC"), "2026-01-05");
    assert.ok(ccc.every((b) => b.state === "PROVIDER_MISSING"));
    const aaa = await readRangeSecurityDay(store, FROM, TO, id("AAA"), "2026-01-05");
    assert.deepEqual(aaa.filter((b) => b.state === "VALID_TRADED").map((b) => b.intervalIndex), [0, 3]);
    assert.deepEqual(await readRangeSecurityDay(store, FROM, TO, id("ZZZ"), "2026-01-05"), []);
    await assert.rejects(readRangeSecurityDay(store, FROM, TO, id("AAA"), "2026-01-07"), /TENMIN_RANGE_DATE_OUTSIDE/u);
  });
});

for (const keepLog of [true, false]) {
  test(`resume after a failed page write redoes only the incomplete security (${keepLog ? "with" : "fresh runner, no"} progress log)`, async () => {
    await withRoot(async (root) => {
      const store = new FailingStore();
      store.failNthRdust = 5; // AAA p1, AAA p2, BBB p1, CCC p1 stored; CCC p2 fails
      const fetches: Record<string, number> = {};
      await assert.rejects(write(store, root, fetches), /STORE_DOWN/u);
      assert.deepEqual(fetches, { AAA: 2, BBB: 1, CCC: 3 }); // all of CCC's pages are fetched before any is written
      assert.equal(await store.get(tenMinRangeManifestKey(FROM, TO)), undefined);
      assert.deepEqual((await loadTenMinRangeProgress(root, FROM, TO)).map((e) => e.securityId), [id("AAA"), id("BBB")]);
      if (!keepLog) await rm(join(root, "transient"), { recursive: true, force: true });
      const resumed = await write(store, root, fetches);
      assert.deepEqual(resumed.securitiesResumed, [id("AAA"), id("BBB")]);
      assert.deepEqual(resumed.securitiesWritten, [id("CCC")]);
      assert.equal(resumed.filesWritten, 3);
      assert.deepEqual(fetches, { AAA: 2, BBB: 1, CCC: 6 });
      assert.deepEqual(await store.get(tenMinRangeManifestKey(FROM, TO)), await uninterruptedManifest());
    });
  });
}

for (const [label, damage] of [
  ["a corrupted page", async (store: MemoryObjectClient, key: string) => {
    const good = (await store.get(key))!;
    const bad = new Uint8Array(good);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
    await store.put(key, bad, (await store.head(key))!.metadata);
  }],
  ["a missing page", async (store: MemoryObjectClient, key: string) => store.delete(key)],
  ["a page with no metadata", async (store: MemoryObjectClient, key: string) => store.put(key, (await store.get(key))!)],
] as const) {
  for (const keepLog of [true, false]) {
    test(`${label} triggers a redo of that security's range (${keepLog ? "with" : "no"} progress log)`, async () => {
      await withRoot(async (root) => {
        const store = new FailingStore();
        store.failNthRdust = 5;
        const fetches: Record<string, number> = {};
        await assert.rejects(write(store, root, fetches), /STORE_DOWN/u);
        await damage(store, tenMinRangeFileKey(FROM, TO, id("AAA"), 2));
        if (!keepLog) await rm(join(root, "transient"), { recursive: true, force: true });
        const resumed = await write(store, root, fetches);
        if (label === "a page with no metadata" && keepLog) {
          // The log hint still matches the bytes; the page set is verified and kept.
          assert.deepEqual(resumed.securitiesResumed, [id("AAA"), id("BBB")]);
          return;
        }
        assert.deepEqual(resumed.securitiesResumed, [id("BBB")]);
        assert.deepEqual(resumed.securitiesWritten, [id("AAA"), id("CCC")]);
        assert.deepEqual(fetches, { AAA: 4, BBB: 1, CCC: 6 });
        assert.deepEqual(await store.get(tenMinRangeManifestKey(FROM, TO)), await uninterruptedManifest());
      });
    });
  }
}

for (const [method, error] of [["head", "R2_HEAD_500"], ["list", "R2_LIST_500"], ["get", "R2_GET_500"]] as const) {
  test(`a store whose ${method} throws ${error} on resume fails instead of refetching`, async () => {
    await withRoot(async (root) => {
      const store = new FailingStore();
      store.failNthRdust = 5;
      const fetches: Record<string, number> = {};
      await assert.rejects(write(store, root, fetches), /STORE_DOWN/u);
      await rm(join(root, "transient"), { recursive: true, force: true });
      const before = { ...fetches };
      const original = store.get.bind(store);
      if (method === "get")
        store.get = async (key) => (key.endsWith(".rdust") ? Promise.reject(new Error(error)) : original(key));
      else
        store[method] = async () => {
          throw new Error(error);
        };
      await assert.rejects(write(store, root, fetches), new RegExp(error, "u"));
      assert.deepEqual(fetches, before); // zero new Massive fetches
      assert.equal(await original(tenMinRangeManifestKey(FROM, TO)), undefined);
    });
  });
}

test("a range over the page cap gaps that security and still seals the range", async () => {
  await withRoot(async (root) => {
    const cycle: Record<string, string[]> = {
      ...PAGES,
      BBB: [page("BBB", 1, [], 2), page("BBB", 2, [], 1)], // p1 -> p2 -> p1 ...
    };
    const store = new MemoryObjectClient();
    const fetches: Record<string, number> = {};
    const result = await write(store, root, fetches, { pages: cycle });
    assert.equal(result.sealed, true);
    assert.equal(fetches.BBB, 8);
    assert.equal(fetches.AAA, 2);
    assert.equal(fetches.CCC, 3);
    assert.equal(await store.get(tenMinRangeFileKey(FROM, TO, id("BBB"), 1)), undefined);
    const manifest = (await readTenMinRangeManifest(store, FROM, TO))!;
    assert.equal(manifest.securityCount, 2);
    assert.equal(manifest.gaps?.length, 1);
    assert.equal(manifest.gaps?.[0]?.securityId, id("BBB"));
    assert.equal(manifest.gaps?.[0]?.reason, "MASSIVE_RANGE_PAGE_CAP");
  });
});

test("a range page that falls back to raw zstd is stored and counted, not failed", async () => {
  await withRoot(async (root) => {
    const brokenTransform: ReplyDustBackend = {
      ...nodeReplyDustBackend,
      compress: (raw, dictionary) =>
        dictionary
          ? nodeReplyDustBackend.compress(encoder.encode("not the reply"), dictionary)
          : nodeReplyDustBackend.compress(raw, null),
    };
    const store = new MemoryObjectClient();
    const result = await write(store, root, {}, { backend: brokenTransform });
    assert.equal(result.filesWritten, 6);
    assert.equal(result.fallbackFiles, 6);
    assert.deepEqual(result.warnings, ["REPLY_DUST_FALLBACK_FILES:6"]);
    const manifest = (await readTenMinRangeManifest(store, FROM, TO))!;
    assert.equal(manifest.fallbackFileCount, 6);
    const stored = (await store.get(tenMinRangeFileKey(FROM, TO, id("AAA"), 2)))!;
    assert.equal(stored[0], REPLY_DUST_FALLBACK_VERSION);
    const pages = await readRangeReplies(store, FROM, TO, id("AAA"));
    assert.deepEqual(pages.map((p) => p.reply), PAGES.AAA!.map((body) => encoder.encode(body)));
  });
});

test("range Reply Dust refuses to start without pinned zstd and fetches nothing", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    let fetched = 0;
    await assert.rejects(
      writeTenMinRangeReplyDust({
        store, root, provider: PROVIDER, from: FROM, to: TO, securities: SECURITIES,
        fetchPages: async () => {
          fetched += 1;
          return [];
        },
        zstdVersionProbe: () => "*** Zstandard CLI (64-bit) v1.5.6, by Yann Collet ***",
      }),
      /REPLY_DUST_ZSTD_VERSION:1\.5\.6/u,
    );
    assert.equal(fetched, 0);
    assert.deepEqual(await store.list(""), []);
  });
});
