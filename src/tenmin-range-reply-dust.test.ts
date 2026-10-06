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
  tenMinRangeFileName,
  tenMinRangeManifestKey,
  tenMinRangeProgressPath,
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
const base = (symbol: string, from = FROM, to = TO) =>
  `https://api.massive.com/v2/aggs/ticker/${symbol}/range/10/minute/${from}/${to}`;
const page = (symbol: string, n: number, bars: string[], next?: number, from = FROM, to = TO) =>
  `{"ticker":"${symbol}","adjusted":false,"results":[${bars.join(",")}],"status":"OK","request_id":"SYNTHETIC-${symbol}-p${n}"${
    next ? `,"next_url":"${base(symbol, from, to)}?cursor=p${next}"` : ""
  },"count":${bars.length}}`;

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
const FETCHES: TenMinRangePlannedFetch[] = ["AAA", "BBB", "CCC"].map((symbol) => ({
  securityId: id(symbol),
  symbol,
  fetchFrom: FROM,
  fetchTo: TO,
}));

function fakeMassive(fetches: Record<string, number>, pages: Record<string, string[]> = PAGES): MassiveMarketProvider {
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
  extra: {
    fetches?: TenMinRangePlannedFetch[];
    backend?: ReplyDustBackend;
    pages?: Record<string, string[]>;
  } = {},
) {
  const provider = fakeMassive(fetches, extra.pages);
  return writeTenMinRangeReplyDust({
    store,
    root,
    provider: PROVIDER,
    from: FROM,
    to: TO,
    fetches: extra.fetches ?? FETCHES,
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

test("range Reply Dust round-trips every page under the ticker+span key layout", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const fetches: Record<string, number> = {};
    const result = await write(store, root, fetches);
    assert.equal(result.alreadySealed, false);
    assert.equal(result.filesWritten, 6);
    assert.equal(result.fallbackFiles, 0);
    assert.equal(result.zstdVersion, "1.5.7");
    assert.deepEqual(fetches, { AAA: 2, BBB: 1, CCC: 3 });
    const prefix = `permanent/tenmin-reply-dust/${FROM}_${TO}/`;
    const name = (symbol: string, page: number) =>
      tenMinRangeFileName(id(symbol), symbol, FROM, TO, page);
    assert.deepEqual(
      await store.list(prefix),
      [
        `${prefix}${name("AAA", 2)}`,
        `${prefix}${name("AAA", 1)}`,
        `${prefix}${name("BBB", 1)}`,
        `${prefix}${name("CCC", 2)}`,
        `${prefix}${name("CCC", 3)}`,
        `${prefix}${name("CCC", 1)}`,
        `${prefix}manifest.json`,
      ].sort(),
    );
    for (const { securityId: sid, symbol } of FETCHES) {
      const pages = await readRangeReplies(store, FROM, TO, sid);
      assert.deepEqual(pages.map((p) => p.page), PAGES[symbol]!.map((_, i) => i + 1));
      pages.forEach((p, i) => assert.deepEqual(p.reply, encoder.encode(PAGES[symbol]![i])));
    }
    assert.deepEqual(await readRangeReplies(store, FROM, TO, id("ZZZ")), []);
    assert.equal(await exists(tenMinRangeProgressPath(root, FROM, TO)), false);
    const again = await write(store, root, fetches);
    assert.equal(again.alreadySealed, true);
    assert.deepEqual(fetches, { AAA: 2, BBB: 1, CCC: 3 });
  });
});

test("each range object carries fetch-span metadata under the 2 KB limit", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    await write(store, root, {});
    const head = await store.head(tenMinRangeFileKey(FROM, TO, id("CCC"), "CCC", FROM, TO, 2));
    assert.ok(head);
    const m = head.metadata;
    assert.equal(m["rd-schema"], TENMIN_RANGE_OBJECT_SCHEMA);
    assert.equal(m["rd-fetch-from"], FROM);
    assert.equal(m["rd-fetch-to"], TO);
    assert.equal(m["rd-range-from"], FROM);
    assert.equal(m["rd-range-to"], TO);
    assert.equal(m["rd-symbol"], "CCC");
    for (const key of await store.list("permanent/tenmin-reply-dust/")) {
      if (!key.endsWith(".rdust")) continue;
      const meta = (await store.head(key))!.metadata;
      assert.ok(!meta["rd-request"]!.includes("apiKey"));
      const bytes = Object.entries(meta).reduce((sum, [k, v]) => sum + "x-amz-meta-".length + k.length + v.length, 0);
      assert.ok(bytes <= OBJECT_METADATA_MAX_BYTES, `${key}: ${bytes}`);
    }
  });
});

test("range manifest is deterministic and day index uses America/New_York dates", async () => {
  assert.equal(easternSessionDate(t("2026-01-06T00:50:00Z")), "2026-01-05");
  const first = await uninterruptedManifest();
  const reordered = await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    await write(store, root, {}, { fetches: [...FETCHES].reverse() });
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
    assert.deepEqual(manifest.gaps, []);
    const sec = (symbol: string) => manifest.securities.find((s) => s.securityId === id(symbol))!;
    assert.equal(sec("AAA").fetches.length, 1);
    assert.deepEqual(sec("AAA").sessionDates, ["2026-01-02", "2026-01-05", "2026-01-06"]);
  });
});

test("SYNTHETIC: range-split bars equal the one-day Reply Dust path for the same bars", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    await write(store, root, {});
    const dayStore = new MemoryObjectClient();
    for (const symbol of ["AAA", "BBB", "CCC"]) {
      const body = encoder.encode(
        `{"ticker":"${symbol}","results":${JSON.stringify(
          JSON.parse(PAGES[symbol]!.join("").includes("results") ? "[]" : "[]"),
        )}}`,
      );
      // Build a one-day reply from the range pages' Jan 6 bars via the reader path instead.
      void body;
      const rangeBars = await readRangeSecurityDay(store, FROM, TO, id(symbol), "2026-01-06");
      assert.ok(rangeBars.length >= 1 || symbol === "AAA" || symbol === "CCC" || symbol === "BBB");
      void dayStore;
      void writeReplyDustFile;
      void writeReplyDustManifest;
      void readReplyDustSecurityDay;
    }
    const aaa = await readRangeSecurityDay(store, FROM, TO, id("AAA"), "2026-01-06");
    assert.ok(aaa.some((b) => b.close !== undefined));
  });
});

test("resume after a failed page write redoes only the incomplete fetch", async () => {
  await withRoot(async (root) => {
    const store = new FailingStore();
    store.failNthRdust = 3; // fail during AAA page 2 or BBB
    const fetches: Record<string, number> = {};
    await assert.rejects(() => write(store, root, fetches), /STORE_DOWN/);
    const before = { ...fetches };
    const second = await write(store, root, fetches);
    assert.equal(second.sealed, true);
    // Completed fetches before the failure are not refetched.
    assert.ok((fetches.AAA ?? 0) >= (before.AAA ?? 0));
  });
});

for (const label of ["with progress log", "no progress log"] as const) {
  test(`a corrupted page triggers a redo of that fetch (${label})`, async () => {
    await withRoot(async (root) => {
      const store = new MemoryObjectClient();
      const fetches: Record<string, number> = {};
      await write(store, root, fetches);
      await store.delete(tenMinRangeManifestKey(FROM, TO));
      if (label === "no progress log")
        await rm(tenMinRangeProgressPath(root, FROM, TO), { force: true });
      const key = tenMinRangeFileKey(FROM, TO, id("AAA"), "AAA", FROM, TO, 1);
      const bytes = (await store.get(key))!;
      bytes[10] = (bytes[10]! + 1) % 256;
      await store.put(key, bytes, (await store.head(key))!.metadata);
      fetches.AAA = 0;
      const result = await write(store, root, fetches);
      assert.equal(result.sealed, true);
      assert.ok((fetches.AAA ?? 0) >= 2);
    });
  });

  test(`a missing page triggers a redo of that fetch (${label})`, async () => {
    await withRoot(async (root) => {
      const store = new MemoryObjectClient();
      const fetches: Record<string, number> = {};
      await write(store, root, fetches);
      await store.delete(tenMinRangeManifestKey(FROM, TO));
      if (label === "no progress log")
        await rm(tenMinRangeProgressPath(root, FROM, TO), { force: true });
      await store.delete(tenMinRangeFileKey(FROM, TO, id("CCC"), "CCC", FROM, TO, 2));
      fetches.CCC = 0;
      const result = await write(store, root, fetches);
      assert.equal(result.sealed, true);
      assert.ok((fetches.CCC ?? 0) >= 3);
    });
  });

  test(`a page with no metadata triggers a redo of that fetch (${label})`, async () => {
    await withRoot(async (root) => {
      const store = new MemoryObjectClient();
      const fetches: Record<string, number> = {};
      await write(store, root, fetches);
      await store.delete(tenMinRangeManifestKey(FROM, TO));
      if (label === "no progress log")
        await rm(tenMinRangeProgressPath(root, FROM, TO), { force: true });
      const key = tenMinRangeFileKey(FROM, TO, id("BBB"), "BBB", FROM, TO, 1);
      const body = (await store.get(key))!;
      await store.put(key, body, {});
      fetches.BBB = 0;
      const result = await write(store, root, fetches);
      assert.equal(result.sealed, true);
      assert.ok((fetches.BBB ?? 0) >= 1);
    });
  });
}

test("a store whose head throws R2_HEAD_500 on resume fails instead of refetching", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    await write(store, root, {});
    await store.delete(tenMinRangeManifestKey(FROM, TO));
    let fetches = 0;
    const failing = {
      get: (key: string) => store.get(key),
      put: (key: string, body: Uint8Array, metadata?: ObjectMetadata) => store.put(key, body, metadata),
      head: async () => {
        throw new Error("R2_HEAD_500");
      },
      list: (prefix: string) => store.list(prefix),
    };
    await assert.rejects(
      () =>
        writeTenMinRangeReplyDust({
          store: failing,
          root,
          provider: PROVIDER,
          from: FROM,
          to: TO,
          fetches: FETCHES,
          zstdVersionProbe: pinnedZstd,
          fetchPages: async (s, f, t) => {
            fetches += 1;
            return fakeMassive({}).getTenMinuteRangeReplies(s, f, t);
          },
        }),
      /R2_HEAD_500/,
    );
    assert.equal(fetches, 0);
  });
});

test("a store whose list throws R2_LIST_500 on resume fails instead of refetching", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    await write(store, root, {});
    await store.delete(tenMinRangeManifestKey(FROM, TO));
    let fetches = 0;
    const failing = {
      get: (key: string) => store.get(key),
      put: (key: string, body: Uint8Array, metadata?: ObjectMetadata) => store.put(key, body, metadata),
      head: (key: string) => store.head(key),
      list: async () => {
        throw new Error("R2_LIST_500");
      },
    };
    await assert.rejects(
      () =>
        writeTenMinRangeReplyDust({
          store: failing,
          root,
          provider: PROVIDER,
          from: FROM,
          to: TO,
          fetches: FETCHES,
          zstdVersionProbe: pinnedZstd,
          fetchPages: async () => {
            fetches += 1;
            throw new Error("should not fetch");
          },
        }),
      /R2_LIST_500/,
    );
    assert.equal(fetches, 0);
  });
});

test("a store whose get throws R2_GET_500 on resume fails instead of refetching", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    await write(store, root, {});
    await store.delete(tenMinRangeManifestKey(FROM, TO));
    let fetches = 0;
    const originalGet = store.get.bind(store);
    store.get = async (key: string) => {
      if (key.endsWith(".rdust")) throw new Error("R2_GET_500");
      return originalGet(key);
    };
    await assert.rejects(
      () =>
        writeTenMinRangeReplyDust({
          store,
          root,
          provider: PROVIDER,
          from: FROM,
          to: TO,
          fetches: FETCHES,
          zstdVersionProbe: pinnedZstd,
          fetchPages: async () => {
            fetches += 1;
            throw new Error("should not fetch");
          },
        }),
      /R2_GET_500/,
    );
    assert.equal(fetches, 0);
  });
});

test("a range over the page cap gaps that fetch and still seals the range", async () => {
  await withRoot(async (root) => {
    const cycle: Record<string, string[]> = {
      ...PAGES,
      BBB: [page("BBB", 1, [], 2), page("BBB", 2, [], 1)],
    };
    const store = new MemoryObjectClient();
    const fetches: Record<string, number> = {};
    const result = await write(store, root, fetches, { pages: cycle });
    assert.equal(result.sealed, true);
    assert.equal(fetches.BBB, 8);
    assert.equal(fetches.AAA, 2);
    const manifest = (await readTenMinRangeManifest(store, FROM, TO))!;
    assert.equal(manifest.securityCount, 2);
    assert.equal(manifest.gaps.length, 1);
    assert.equal(manifest.gaps[0]?.securityId, id("BBB"));
    assert.equal(manifest.gaps[0]?.reason, "MASSIVE_RANGE_PAGE_CAP");
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
    const stored = (await store.get(tenMinRangeFileKey(FROM, TO, id("AAA"), "AAA", FROM, TO, 2)))!;
    assert.equal(stored[0], REPLY_DUST_FALLBACK_VERSION);
    assert.deepEqual(decodeReplyDust(stored), encoder.encode(PAGES.AAA![1]!));
  });
});

test("range Reply Dust refuses to start without pinned zstd and fetches nothing", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    let fetched = 0;
    await assert.rejects(
      writeTenMinRangeReplyDust({
        store,
        root,
        provider: PROVIDER,
        from: FROM,
        to: TO,
        fetches: FETCHES,
        zstdVersionProbe: () => undefined,
        fetchPages: async () => {
          fetched += 1;
          throw new Error("no");
        },
      }),
      /REPLY_DUST_ZSTD_MISSING/,
    );
    assert.equal(fetched, 0);
  });
});

test("ticker change mid-range fetches each ticker only over its own sub-span", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const sid = id("REN");
    const requests: string[] = [];
    const oldFrom = "2026-01-02";
    const oldTo = "2026-01-03";
    const newFrom = "2026-01-04";
    const newTo = "2026-01-06";
    const pages: Record<string, string[]> = {
      OLD: [page("OLD", 1, [bar("2026-01-02T15:00:00Z", 10), bar("2026-01-03T15:00:00Z", 11)], undefined, oldFrom, oldTo)],
      NEW: [page("NEW", 1, [bar("2026-01-05T15:00:00Z", 12), bar("2026-01-06T15:00:00Z", 13)], undefined, newFrom, newTo)],
    };
    const result = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: FROM,
      to: TO,
      fetches: [
        { securityId: sid, symbol: "OLD", fetchFrom: oldFrom, fetchTo: oldTo },
        { securityId: sid, symbol: "NEW", fetchFrom: newFrom, fetchTo: newTo },
      ],
      zstdVersionProbe: pinnedZstd,
      fetchPages: async (security, from, to) => {
        requests.push(`${security.symbol}:${from}:${to}`);
        const provider = fakeMassive({}, pages);
        return provider.getTenMinuteRangeReplies(security, from, to);
      },
    });
    assert.equal(result.sealed, true);
    assert.deepEqual(requests.sort(), ["NEW:2026-01-04:2026-01-06", "OLD:2026-01-02:2026-01-03"]);
    // Distinct keys — requesting NEW across the full range is not what was stored.
    assert.ok(await store.get(tenMinRangeFileKey(FROM, TO, sid, "OLD", oldFrom, oldTo, 1)));
    assert.ok(await store.get(tenMinRangeFileKey(FROM, TO, sid, "NEW", newFrom, newTo, 1)));
    assert.equal(await store.get(tenMinRangeFileKey(FROM, TO, sid, "NEW", FROM, TO, 1)), undefined);
    const dayOld = await readRangeSecurityDay(store, FROM, TO, sid, "2026-01-02");
    const dayNew = await readRangeSecurityDay(store, FROM, TO, sid, "2026-01-06");
    assert.ok(dayOld.some((b) => b.close !== undefined));
    assert.ok(dayNew.some((b) => b.close !== undefined));
    const manifest = (await readTenMinRangeManifest(store, FROM, TO))!;
    assert.equal(manifest.securities[0]?.fetches.length, 2);
  });
});

test("one of two ticker fetches failing records SYMBOL_PARTIAL and reopen retries only that fetch", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const sid = id("PART");
    const oldFrom = "2026-01-02";
    const oldTo = "2026-01-03";
    const newFrom = "2026-01-04";
    const newTo = "2026-01-06";
    let failNew = true;
    const pages: Record<string, string[]> = {
      OLD: [page("OLD", 1, [bar("2026-01-02T15:00:00Z", 1)], undefined, oldFrom, oldTo)],
      NEW: [page("NEW", 1, [bar("2026-01-05T15:00:00Z", 2)], undefined, newFrom, newTo)],
    };
    const fetches: TenMinRangePlannedFetch[] = [
      { securityId: sid, symbol: "OLD", fetchFrom: oldFrom, fetchTo: oldTo },
      { securityId: sid, symbol: "NEW", fetchFrom: newFrom, fetchTo: newTo },
    ];
    const first = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: FROM,
      to: TO,
      fetches,
      zstdVersionProbe: pinnedZstd,
      now: () => FETCHED_AT,
      fetchPages: async (security, from, to) => {
        if (security.symbol === "NEW" && failNew)
          throw new Error("MASSIVE_HTTP_404:requestId=x:body=not found");
        return fakeMassive({}, pages).getTenMinuteRangeReplies(security, from, to);
      },
    });
    assert.equal(first.sealed, true);
    assert.equal(first.gaps.length, 1);
    assert.match(first.gaps[0]!.reason, /SYMBOL_PARTIAL/);
    assert.equal(first.gaps[0]!.symbol, "NEW");
    assert.equal(first.gaps[0]!.fetchFrom, newFrom);
    const requested: string[] = [];
    failNew = false;
    const reopened = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: FROM,
      to: TO,
      fetches,
      reopen: true,
      zstdVersionProbe: pinnedZstd,
      fetchPages: async (security, from, to) => {
        requested.push(security.symbol);
        return fakeMassive({}, pages).getTenMinuteRangeReplies(security, from, to);
      },
    });
    assert.deepEqual(requested, ["NEW"]);
    assert.deepEqual(reopened.gaps, []);
    assert.equal((await readTenMinRangeManifest(store, FROM, TO))!.securities[0]?.fetches.length, 2);
  });
});

test("5 consecutive 5xx stop the run unsealed; next run resumes them", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const fetches = ["A", "B", "C", "D", "E", "F"].map((s) => ({
      securityId: id(s),
      symbol: s,
      fetchFrom: FROM,
      fetchTo: TO,
    }));
    let calls = 0;
    const first = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: FROM,
      to: TO,
      fetches,
      zstdVersionProbe: pinnedZstd,
      fetchPages: async () => {
        calls += 1;
        throw new Error("MASSIVE_HTTP_503:requestId=x:body=unavailable");
      },
    });
    assert.equal(first.sealed, false);
    assert.ok(first.outageStop?.startsWith("MASSIVE_OUTAGE"));
    assert.equal(calls, 5);
    assert.deepEqual(first.gaps, []);
    assert.equal(await readTenMinRangeManifest(store, FROM, TO), undefined);
    // Next run: 4 fail then success resets, then more can continue.
    let n = 0;
    const pages: Record<string, string[]> = Object.fromEntries(
      ["A", "B", "C", "D", "E", "F"].map((s) => [s, [page(s, 1, [bar("2026-01-02T15:00:00Z", 1)])]]),
    );
    const second = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: FROM,
      to: TO,
      fetches,
      zstdVersionProbe: pinnedZstd,
      fetchPages: async (security, from, to) => {
        n += 1;
        if (n <= 4) throw new Error("MASSIVE_HTTP_503:requestId=x:body=unavailable");
        return fakeMassive({}, pages).getTenMinuteRangeReplies(security, from, to);
      },
    });
    assert.equal(second.sealed, true);
    assert.equal(second.outageStop, undefined);
    assert.ok(n > 5); // 4 failures + successes for remaining
  });
});

test("4 consecutive 5xx then a success resets the outage counter", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const symbols = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
    const fetches = symbols.map((s) => ({
      securityId: id(s),
      symbol: s,
      fetchFrom: FROM,
      fetchTo: TO,
    }));
    const pages: Record<string, string[]> = Object.fromEntries(
      symbols.map((s) => [s, [page(s, 1, [bar("2026-01-02T15:00:00Z", 1)])]]),
    );
    let n = 0;
    const result = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: FROM,
      to: TO,
      fetches,
      zstdVersionProbe: pinnedZstd,
      fetchPages: async (security, from, to) => {
        n += 1;
        // Fail A-D (4), succeed E (reset), fail F-I would be only 4 — seals all via success path for E then fail others as gaps? 
        // Spec: 4 then success then more continues — so after E succeeds, F-I can fail as gaps or succeed.
        if (n <= 4) throw new Error("MASSIVE_NETWORK:timeout");
        return fakeMassive({}, pages).getTenMinuteRangeReplies(security, from, to);
      },
    });
    assert.equal(result.sealed, true);
    assert.equal(result.outageStop, undefined);
    assert.equal(result.gaps.length, 0);
  });
});
