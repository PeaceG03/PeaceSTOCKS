import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MarketProvider, ProviderSecurityRecord, ScannerRunReport } from "./contracts";
import {
  dailyBarsFromReply,
  dailyReplyDustFileKey,
  dailyReplyDustHashedFileKey,
  dailyReplyDustManifestKey,
  readDailyReplyDustManifest,
  readDailyReplyDustReply,
} from "./daily-reply-dust";
import { fakeR2 } from "./fake-r2.test-helper";
import { sha256Hex } from "./intraday-reply-dust";
import { MassiveMarketProvider, groupedDailySymbolIndex, symbolBySecurityIdFor } from "./massive-provider";
import { MemoryObjectClient, type ObjectMetadata } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { MarketsScanner, US_EQUITY_CALENDAR } from "./scanner";
import { beforeNextSessionOpen } from "./session-open";
import {
  SCAN_GROUPED_REPLY_DUST_HASH_CONFLICT,
  SCAN_GROUPED_REPLY_DUST_WRITE_FAILED,
  compareGroupedResultsIgnoringRequestId,
  maybeStoreScanGroupedReplyDust,
  scanGroupedReplyDustEnabled,
  storeScanGroupedReplyDust,
} from "./scan-grouped-reply-dust";
import { storeRangeGroupedDaily } from "./tenmin-grouped-daily";

const DAY = "2026-01-20"; // Tuesday
const AT = "2026-01-20T23:00:00.000Z";
const PROVIDER = "massive-stocks";
const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";
const encoder = new TextEncoder();

const universe: ProviderSecurityRecord[] = [
  {
    provider: PROVIDER,
    providerSecurityId: "AAA",
    symbol: "AAA",
    assetType: "STOCK",
    country: "US",
    exchange: "XNYS",
    active: true,
    tradable: true,
  },
  {
    provider: PROVIDER,
    providerSecurityId: "SPY",
    symbol: "SPY",
    assetType: "ETF",
    country: "US",
    exchange: "ARCX",
    active: true,
    tradable: true,
  },
];

function groupedBody(requestId: string, resultsExtra = ""): Uint8Array {
  const t = Date.parse(`${DAY}T21:00:00.000Z`);
  return encoder.encode(
    `{"queryCount":2,"resultsCount":2,"adjusted":false,"results":[{"T":"AAA","v":1,"o":1,"c":1,"h":1,"l":1,"t":${t},"n":1},{"T":"SPY","v":2,"o":2,"c":2,"h":2,"l":2,"t":${t},"n":2}${resultsExtra}],"status":"OK","request_id":"${requestId}","count":2}`,
  );
}

function reply(body: Uint8Array, requestId = "req-1") {
  return {
    dataset: "stocks-grouped-daily" as const,
    sessionDate: DAY,
    request: `/v2/aggs/grouped/locale/us/market/stocks/${DAY}?adjusted=false&include_otc=false`,
    fetchedAt: AT,
    body: body ?? groupedBody(requestId),
  };
}

function harness(bodies: Uint8Array[], now: () => string = () => AT) {
  let i = 0;
  let requests = 0;
  const massive = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    keepRawReplies: true,
    now,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/v3/reference/tickers")) {
        return new Response(
          JSON.stringify({
            results: universe.map((u) => ({
              ticker: u.symbol,
              name: u.symbol,
              market: "stocks",
              locale: "us",
              primary_exchange: u.exchange,
              type: u.assetType === "ETF" ? "ETF" : "CS",
              active: true,
              currency_name: "usd",
              cik: "1",
            })),
            status: "OK",
            request_id: "tickers",
            count: universe.length,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v2/aggs/grouped/")) {
        requests += 1;
        const body = bodies[Math.min(i, bodies.length - 1)]!;
        i += 1;
        return new Response(body, { status: 200 });
      }
      return new Response("{}", { status: 404 });
    },
  });
  const provider: MarketProvider & {
    bindUniverse(records: ProviderSecurityRecord[]): void;
    takeRawReplies(): ReturnType<MassiveMarketProvider["takeRawReplies"]>;
  } = {
    providerName: massive.providerName,
    listApprovedSecurities: async () => universe,
    getDailyBars: (day, ids) => massive.getDailyBars(day, ids),
    getCorporateActions: async () => [],
    takeRawReplies: () => massive.takeRawReplies(),
    bindUniverse: (records) => massive.bindUniverse(records),
  };
  return { provider, requests: () => requests, massive };
}

function coreReport(report: ScannerRunReport) {
  const { groupedReplyDust: _g, dailyBarsSidecar: _d, completedAt: _c, storage: _s, ...rest } = report;
  return rest;
}

test("kill switch: only exactly true enables; other values leave scan unchanged", () => {
  assert.equal(scanGroupedReplyDustEnabled({ SCAN_GROUPED_REPLY_DUST: "true" }), true);
  for (const value of [undefined, "", "TRUE", "1", "false", "yes"]) {
    assert.equal(scanGroupedReplyDustEnabled({ SCAN_GROUPED_REPLY_DUST: value as string }), false, String(value));
  }
});

test("compareGroupedResultsIgnoringRequestId: same results different request_id match", () => {
  const a = groupedBody("aaa");
  const b = groupedBody("bbb");
  assert.deepEqual(compareGroupedResultsIgnoringRequestId(a, b), { match: true });
  const changed = groupedBody("ccc", `,{"T":"ZZZ","v":9,"o":9,"c":9,"h":9,"l":9,"t":1,"n":1}`);
  const cmp = compareGroupedResultsIgnoringRequestId(a, changed);
  assert.equal(cmp.match, false);
  assert.match(cmp.summary ?? "", /counts differ|tickers changed/u);
});

test("first write stores canonical grouped-daily.rdust; identical reuse; different bytes -> hashed copy", async () => {
  const store = new MemoryObjectClient();
  const first = reply(groupedBody("req-1"));
  const r1 = await storeScanGroupedReplyDust({
    store,
    reply: first,
    provider: PROVIDER,
    zstdVersionProbe: pinnedZstd,
  });
  assert.equal(r1.extraMassiveRequests, 0);
  assert.equal(r1.copies.length, 1);
  assert.equal(r1.copies[0]?.status, "stored");
  assert.equal(r1.copies[0]?.key, dailyReplyDustFileKey(DAY));
  const manifest1 = await readDailyReplyDustManifest(store, DAY);
  assert.ok(manifest1);
  assert.equal(manifest1!.relativePath, "grouped-daily.rdust");
  assert.equal(manifest1!.copies, undefined);

  const r2 = await storeScanGroupedReplyDust({
    store,
    reply: reply(groupedBody("req-1")), // identical bytes
    provider: PROVIDER,
    zstdVersionProbe: pinnedZstd,
  });
  assert.equal(r2.copies[0]?.status, "reused");
  assert.equal(r2.extraMassiveRequests, 0);

  const different = reply(groupedBody("req-2")); // only request_id differs
  const sha = sha256Hex(different.body);
  const r3 = await storeScanGroupedReplyDust({
    store,
    reply: different,
    provider: PROVIDER,
    zstdVersionProbe: pinnedZstd,
  });
  assert.equal(r3.copies.length, 2);
  const hashed = r3.copies.find((c) => c.key === dailyReplyDustHashedFileKey(DAY, sha));
  assert.ok(hashed);
  assert.equal(hashed!.status, "stored");
  assert.equal(hashed!.resultsMatchFirst, true);
  const manifest3 = await readDailyReplyDustManifest(store, DAY);
  assert.equal(manifest3!.copies?.length, 1);
  assert.equal(manifest3!.replySha256, sha256Hex(first.body)); // canonical unchanged
  // Hashed object exists; canonical still verifies.
  await readDailyReplyDustReply(store, manifest3!);
  assert.ok(await store.get(dailyReplyDustHashedFileKey(DAY, sha)));

  // Existing hashed copy identical reuse.
  const r4 = await storeScanGroupedReplyDust({
    store,
    reply: different,
    provider: PROVIDER,
    zstdVersionProbe: pinnedZstd,
  });
  const hashedAgain = r4.copies.find((c) => c.sha256 === sha);
  assert.equal(hashedAgain?.status, "reused");
  assert.equal(hashedAgain?.resultsMatchFirst, true);
});

test("results changed -> resultsMatchFirst false with summary", async () => {
  const store = new MemoryObjectClient();
  await storeScanGroupedReplyDust({
    store,
    reply: reply(groupedBody("a")),
    provider: PROVIDER,
    zstdVersionProbe: pinnedZstd,
  });
  const changed = reply(
    groupedBody("b", `,{"T":"ZZZ","v":9,"o":9,"c":9,"h":9,"l":9,"t":1,"n":1}`),
  );
  const report = await storeScanGroupedReplyDust({
    store,
    reply: changed,
    provider: PROVIDER,
    zstdVersionProbe: pinnedZstd,
  });
  const extra = report.copies.find((c) => c.key.includes("grouped-daily-") && !c.key.endsWith("grouped-daily.rdust"));
  assert.ok(extra);
  assert.equal(extra!.resultsMatchFirst, false);
  assert.match(extra!.resultsDiffSummary ?? "", /counts differ|tickers changed/u);
});

test("write failure is a warning; scan core report byte-identical to feature-off", async () => {
  class FailPut extends MemoryObjectClient {
    override async put(key: string, body: Uint8Array, metadata?: ObjectMetadata): Promise<void> {
      if (key.includes("grouped-daily")) throw new Error("STORE_DOWN");
      await super.put(key, body, metadata);
    }
  }
  const root = await mkdtemp(join(tmpdir(), "scan-dust-"));
  try {
    const body = groupedBody("x");
    const offH = harness([body]);
    const offStorage = new ObjectMarketStorage(new MemoryObjectClient());
    const off = await new MarketsScanner(offH.provider, offStorage, US_EQUITY_CALENDAR, undefined, () => beforeNextSessionOpen(DAY)).run(DAY);

    const onH = harness([body]);
    const onStorage = new ObjectMarketStorage(new MemoryObjectClient());
    const on = await new MarketsScanner(onH.provider, onStorage, US_EQUITY_CALENDAR, {
      enabled: true,
      store: new FailPut(),
      zstdVersionProbe: pinnedZstd,
    }, () => beforeNextSessionOpen(DAY)).run(DAY);

    assert.deepEqual(coreReport(on), coreReport(off));
    assert.equal(on.groupedReplyDust?.enabled, true);
    assert.ok(
      on.groupedReplyDust?.warnings.some((w) => w.startsWith(SCAN_GROUPED_REPLY_DUST_WRITE_FAILED)),
    );
    assert.equal(on.status, off.status);
    assert.deepEqual(on.unresolvedFailures, off.unresolvedFailures);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("feature on: zero extra Massive requests vs feature off", async () => {
  const body = groupedBody("same");
  const offH = harness([body]);
  const offStorage = new ObjectMarketStorage(new MemoryObjectClient());
  await new MarketsScanner(offH.provider, offStorage, US_EQUITY_CALENDAR, undefined, () => beforeNextSessionOpen(DAY)).run(DAY);
  const offRequests = offH.requests();

  const onH = harness([body]);
  const store = new MemoryObjectClient();
  const onStorage = new ObjectMarketStorage(new MemoryObjectClient());
  const report = await new MarketsScanner(onH.provider, onStorage, US_EQUITY_CALENDAR, {
    enabled: true,
    store,
    zstdVersionProbe: pinnedZstd,
  }, () => beforeNextSessionOpen(DAY)).run(DAY);
  assert.equal(onH.requests(), offRequests);
  assert.equal(report.groupedReplyDust?.extraMassiveRequests, 0);
  assert.equal(report.groupedReplyDust?.copies[0]?.status, "stored");
});

test("history step afterwards still sees the day as stored and makes 0 requests", async () => {
  const store = new MemoryObjectClient();
  const body = groupedBody("hist");
  await storeScanGroupedReplyDust({
    store,
    reply: reply(body),
    provider: PROVIDER,
    zstdVersionProbe: pinnedZstd,
  });
  let fetches = 0;
  const step = await storeRangeGroupedDaily({
    store,
    provider: PROVIDER,
    sessions: [DAY],
    fetchGroupedDaily: async () => {
      fetches += 1;
      throw new Error("SHOULD_NOT_FETCH");
    },
  });
  assert.equal(step.resumed, 1);
  assert.equal(step.stored, 0);
  assert.equal(step.requests, 0);
  assert.equal(fetches, 0);
});

test("fake R2: first write and hashed second copy land under permanent/daily-reply-dust", async () => {
  const { client, objects } = fakeR2();
  const first = reply(groupedBody("r1"));
  await storeScanGroupedReplyDust({
    store: client,
    reply: first,
    provider: PROVIDER,
    zstdVersionProbe: pinnedZstd,
  });
  assert.ok(objects.has(dailyReplyDustFileKey(DAY)));
  assert.ok(objects.has(dailyReplyDustManifestKey(DAY)));
  const second = reply(groupedBody("r2"));
  await storeScanGroupedReplyDust({
    store: client,
    reply: second,
    provider: PROVIDER,
    zstdVersionProbe: pinnedZstd,
  });
  assert.ok(objects.has(dailyReplyDustHashedFileKey(DAY, sha256Hex(second.body))));
  // Canonical untouched.
  const manifest = await readDailyReplyDustManifest(client, DAY);
  assert.equal(manifest!.replySha256, sha256Hex(first.body));
});

test("maybeStore: kill switch off / no held reply", async () => {
  const off = await maybeStoreScanGroupedReplyDust({
    enabled: false,
    provider: { providerName: PROVIDER },
    sessionDate: DAY,
  });
  assert.equal(off.enabled, false);
  assert.equal(off.reason, "SCAN_GROUPED_REPLY_DUST_OFF");

  const noHeld = await maybeStoreScanGroupedReplyDust({
    enabled: true,
    store: new MemoryObjectClient(),
    provider: { providerName: PROVIDER, takeRawReplies: () => [] },
    sessionDate: DAY,
  });
  assert.equal(noHeld.reason, "NO_GROUPED_REPLY_HELD");
  assert.equal(noHeld.copies.length, 0);
});

test("hash conflict warning when existing hashed object has different bytes", async () => {
  const store = new MemoryObjectClient();
  await storeScanGroupedReplyDust({
    store,
    reply: reply(groupedBody("first")),
    provider: PROVIDER,
    zstdVersionProbe: pinnedZstd,
  });
  const second = reply(groupedBody("second"));
  const key = dailyReplyDustHashedFileKey(DAY, sha256Hex(second.body));
  // Plant a conflicting object at the hashed key (wrong bytes, valid enough to decode as raw? use garbage encoded).
  // Put raw garbage so decode fails or bytes differ — put a different valid reply dust for another body.
  const other = reply(groupedBody("other-planted"));
  // Force-write under the would-be key by first computing sha of second then putting wrong content via storeVerified path for a different body is hard.
  // Simpler: write second normally, then mutate the stored object bytes.
  await storeScanGroupedReplyDust({
    store,
    reply: second,
    provider: PROVIDER,
    zstdVersionProbe: pinnedZstd,
  });
  const encoded = await store.get(key);
  assert.ok(encoded);
  const mangled = new Uint8Array(encoded!);
  mangled[mangled.length - 1]! ^= 0xff;
  await store.put(key, mangled);
  const again = await storeScanGroupedReplyDust({
    store,
    reply: second,
    provider: PROVIDER,
    zstdVersionProbe: pinnedZstd,
  });
  assert.ok(
    again.warnings.some(
      (w) => w.startsWith(SCAN_GROUPED_REPLY_DUST_HASH_CONFLICT) || w.startsWith(SCAN_GROUPED_REPLY_DUST_WRITE_FAILED) || w.includes("DECODE"),
    ),
  );
  const highlighted = again.copies.find((c) => c.key === key);
  assert.equal(highlighted?.status, "warning");
});


test("corporate-actions failure: grouped reply still stored; core report matches feature-off failure", async () => {
  const body = groupedBody("ca-fail");
  let actionsCalls = 0;
  function makeProvider(): MarketProvider & {
    bindUniverse(records: ProviderSecurityRecord[]): void;
    takeRawReplies(): ReturnType<MassiveMarketProvider["takeRawReplies"]>;
  } {
    const massive = new MassiveMarketProvider({
      apiKey: "test-key",
      minRequestIntervalMs: 0,
      retryBackoffMs: 0,
      keepRawReplies: true,
      now: () => AT,
      fetchImpl: async (input) => {
        if (String(input).includes("/v2/aggs/grouped/")) {
          return new Response(body, { status: 200 });
        }
        return new Response("{}", { status: 404 });
      },
    });
    return {
      providerName: massive.providerName,
      listApprovedSecurities: async () => universe,
      getDailyBars: (day, ids) => massive.getDailyBars(day, ids),
      getCorporateActions: async () => {
        actionsCalls += 1;
        throw new Error("MASSIVE_HTTP_500:corporate");
      },
      takeRawReplies: () => massive.takeRawReplies(),
      bindUniverse: (records) => massive.bindUniverse(records),
    };
  }

  const offProvider = makeProvider();
  const offStorage = new ObjectMarketStorage(new MemoryObjectClient());
  const off = await new MarketsScanner(offProvider, offStorage, US_EQUITY_CALENDAR, undefined, () => beforeNextSessionOpen(DAY)).run(DAY);

  actionsCalls = 0;
  const onProvider = makeProvider();
  const dustStore = new MemoryObjectClient();
  const onStorage = new ObjectMarketStorage(new MemoryObjectClient());
  const on = await new MarketsScanner(onProvider, onStorage, US_EQUITY_CALENDAR, {
    enabled: true,
    store: dustStore,
    zstdVersionProbe: pinnedZstd,
  }, () => beforeNextSessionOpen(DAY)).run(DAY);

  assert.deepEqual(coreReport(on), coreReport(off));
  assert.equal(on.groupedReplyDust?.copies[0]?.status, "stored");
  assert.equal(on.groupedReplyDust?.extraMassiveRequests, 0);
  assert.ok(await readDailyReplyDustManifest(dustStore, DAY));
  assert.ok(actionsCalls >= 1);
});

test("A,B,C,B,A: every non-first copy always has resultsMatchFirst; C stays false with ticker summary", async () => {
  const store = new MemoryObjectClient();
  const A = reply(groupedBody("A"));
  const B = reply(groupedBody("B")); // same results, different request_id
  const C = reply(groupedBody("C", `,{"T":"ZZZ","v":9,"o":9,"c":9,"h":9,"l":9,"t":1,"n":1}`));
  const sequence = [A, B, C, B, A];
  const shaB = sha256Hex(B.body);
  const shaC = sha256Hex(C.body);

  for (let i = 0; i < sequence.length; i += 1) {
    const report = await storeScanGroupedReplyDust({
      store,
      reply: sequence[i]!,
      provider: PROVIDER,
      zstdVersionProbe: pinnedZstd,
    });
    const nonFirst = report.copies.slice(1);
    for (const copy of nonFirst) {
      assert.equal(typeof copy.resultsMatchFirst, "boolean", `run ${i} ${copy.key}`);
      if (copy.resultsMatchFirst === false) {
        assert.ok(copy.resultsDiffSummary, `run ${i} ${copy.key} needs summary`);
      }
    }
    const cCopy = report.copies.find((c) => c.sha256 === shaC);
    if (cCopy) {
      assert.equal(cCopy.resultsMatchFirst, false, `run ${i} C must not match first`);
      assert.match(cCopy.resultsDiffSummary ?? "", /1 tickers changed|counts differ/u);
    }
    const bCopy = report.copies.find((c) => c.sha256 === shaB);
    if (bCopy) {
      assert.equal(bCopy.resultsMatchFirst, true, `run ${i} B matches first ignoring request_id`);
    }
  }
  const finalManifest = await readDailyReplyDustManifest(store, DAY);
  assert.equal(finalManifest!.replySha256, sha256Hex(A.body));
  assert.equal(finalManifest!.copies?.length, 2); // B and C
});

test("scan: grouped Dust manifest carries the daily-bars observedAt/retrievalId; rows rebuild exactly from Dust", async () => {
  // A ticking clock: the provider stamps bars (observedAt) and the reply (fetchedAt) at different
  // instants, as in production. Before the fix the manifest kept fetchedAt and rebuilt rows differed.
  let tick = 0;
  const now = () => new Date(Date.parse(AT) + 1000 * tick++).toISOString();
  const h = harness([groupedBody("req-scan")], now);
  const store = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  const report = await new MarketsScanner(h.provider, storage, US_EQUITY_CALENDAR, {
    enabled: true,
    store,
    zstdVersionProbe: pinnedZstd,
  }, () => beforeNextSessionOpen(DAY)).run(DAY);
  assert.equal(report.groupedReplyDust?.copies[0]?.status, "stored");
  const rows = await storage.loadBars(DAY);
  assert.ok(rows.length > 0);
  const manifest = (await readDailyReplyDustManifest(store, DAY))!;
  assert.equal(manifest.observedAt, rows[0]!.observedAt);
  assert.notEqual(manifest.observedAt, AT, "clock ticked: fetchedAt alone would differ");
  assert.equal(manifest.retrievalId, "req-scan");
  for (const row of rows) assert.equal(row.provenance.retrievalId, manifest.retrievalId);
  const bySymbol = groupedDailySymbolIndex(symbolBySecurityIdFor(universe), rows.map((row) => row.securityId));
  const rebuilt = dailyBarsFromReply({
    provider: manifest.provider,
    sessionDate: DAY,
    observedAt: manifest.observedAt,
    reply: await readDailyReplyDustReply(store, manifest),
    bySymbol,
  });
  assert.deepEqual(rebuilt, rows);
});

test("maybeStore: observedAt given → manifest uses it; absent → fetchedAt (backfill rule)", async () => {
  const held = (body: Uint8Array) => ({ providerName: PROVIDER, takeRawReplies: () => [reply(body)] });
  const a = new MemoryObjectClient();
  await maybeStoreScanGroupedReplyDust({
    enabled: true, store: a, provider: held(groupedBody("x")), sessionDate: DAY,
    observedAt: "2026-01-20T23:00:05.000Z", zstdVersionProbe: pinnedZstd,
  });
  assert.equal((await readDailyReplyDustManifest(a, DAY))!.observedAt, "2026-01-20T23:00:05.000Z");
  const b = new MemoryObjectClient();
  await maybeStoreScanGroupedReplyDust({
    enabled: true, store: b, provider: held(groupedBody("x")), sessionDate: DAY, zstdVersionProbe: pinnedZstd,
  });
  assert.equal((await readDailyReplyDustManifest(b, DAY))!.observedAt, AT);
});

test("daily-bars sidecar: the scan writes it beside the JSONL rows, bound to the day's Dust; decoder rebuilds the lines", async () => {
  const { decodeDailyBarsPack } = await import("./daily-bars-pack-decode");
  const { dailyBarsSidecarFileKey, dailyBarsSidecarManifestKey } = await import("./daily-bars-sidecar");
  const body = groupedBody("sidecar");
  const h = harness([body]);
  const barsClient = new MemoryObjectClient();
  const store = new MemoryObjectClient();
  const report = await new MarketsScanner(h.provider, new ObjectMarketStorage(barsClient), US_EQUITY_CALENDAR, {
    enabled: true,
    store,
    zstdVersionProbe: pinnedZstd,
  }, () => beforeNextSessionOpen(DAY)).run(DAY);
  assert.equal(report.dailyBarsSidecar?.status, "stored");
  assert.equal(report.dailyBarsSidecar?.source, "dust");
  const jsonl = new TextDecoder().decode((await barsClient.get(`permanent/daily-bars/${DAY.slice(0, 7)}.jsonl`))!);
  const lines = jsonl.split("\n").filter((line) => line.includes(`"sessionDate":"${DAY}"`));
  assert.ok(lines.length > 0);
  const manifest = await readDailyReplyDustManifest(store, DAY);
  const decoded = decodeDailyBarsPack({
    file: (await store.get(dailyBarsSidecarFileKey(DAY)))!,
    manifest: (await store.get(dailyBarsSidecarManifestKey(DAY)))!,
    dustReply: await readDailyReplyDustReply(store, manifest!),
  });
  assert.deepEqual(decoded.lines, lines);
  // A second scan of the same day never overwrites the sealed sidecar.
  const again = await new MarketsScanner(harness([body]).provider, new ObjectMarketStorage(barsClient), US_EQUITY_CALENDAR, {
    enabled: true,
    store,
    zstdVersionProbe: pinnedZstd,
  }, () => beforeNextSessionOpen(DAY)).run(DAY);
  assert.notEqual(again.dailyBarsSidecar?.status, "stored");
});

test("daily-bars sidecar: feature off writes nothing", async () => {
  const report = await new MarketsScanner(harness([groupedBody("off")]).provider, new ObjectMarketStorage(new MemoryObjectClient()), US_EQUITY_CALENDAR, undefined, () => beforeNextSessionOpen(DAY)).run(DAY);
  assert.equal(report.dailyBarsSidecar, undefined);
});

test("daily-bars pack: written even with grouped Reply Dust OFF (pure pack); JSONL unchanged", async () => {
  const { decodeDailyBarsPack } = await import("./daily-bars-pack-decode");
  const { dailyBarsSidecarFileKey, dailyBarsSidecarManifestKey } = await import("./daily-bars-sidecar");
  const barsOff = new MemoryObjectClient();
  const off = await new MarketsScanner(harness([groupedBody("u")]).provider, new ObjectMarketStorage(barsOff), US_EQUITY_CALENDAR, undefined, () => beforeNextSessionOpen(DAY)).run(DAY);
  const barsClient = new MemoryObjectClient();
  const packStore = new MemoryObjectClient();
  const report = await new MarketsScanner(harness([groupedBody("u")]).provider, new ObjectMarketStorage(barsClient), US_EQUITY_CALENDAR, undefined,
    () => beforeNextSessionOpen(DAY), { store: packStore, zstdVersionProbe: pinnedZstd }).run(DAY);
  assert.equal(report.groupedReplyDust, undefined);
  assert.equal(report.dailyBarsSidecar?.status, "stored");
  assert.equal(report.dailyBarsSidecar?.source, "pack");
  assert.equal(report.status, off.status);
  const key = `permanent/daily-bars/${DAY.slice(0, 7)}.jsonl`;
  assert.deepEqual(await barsClient.get(key), await barsOff.get(key));
  const lines = new TextDecoder().decode((await barsClient.get(key))!).split("\n").filter((l) => l.includes(`"sessionDate":"${DAY}"`));
  assert.deepEqual(decodeDailyBarsPack({ file: (await packStore.get(dailyBarsSidecarFileKey(DAY)))!, manifest: (await packStore.get(dailyBarsSidecarManifestKey(DAY)))! }).lines, lines);
});

test("daily-bars pack: a different existing pack FAILS the run with DAILY_BARS_PACK_EXISTS_DIFFERENT:<date> (no values)", async () => {
  const { writeDailyBarsSidecar, dailyBarsSidecarFileKey } = await import("./daily-bars-sidecar");
  const packStore = new MemoryObjectClient();
  const other = { securityId: "sec_other", sessionDate: DAY, open: 1, high: 1, low: 1, close: 1, volume: 1, observedAt: AT, ingestedAt: AT,
    dataQuality: "GOOD", corporateActionIds: [], flags: [], schemaVersion: "x", revision: 1,
    provenance: { provider: PROVIDER, dataset: "stocks-grouped-daily", retrievalId: "r", ingestionVersion: "v", normalizerVersion: "n" } } as any;
  await writeDailyBarsSidecar({ store: packStore, sessionDate: DAY, rows: [other], dust: null });
  const before = await packStore.get(dailyBarsSidecarFileKey(DAY));
  const barsClient = new MemoryObjectClient();
  const report = await new MarketsScanner(harness([groupedBody("d")]).provider, new ObjectMarketStorage(barsClient), US_EQUITY_CALENDAR, undefined,
    () => beforeNextSessionOpen(DAY), { store: packStore, zstdVersionProbe: pinnedZstd }).run(DAY);
  assert.equal(report.status, "FAILED");
  assert.equal(report.dailyBarsSidecar?.status, "exists-different");
  assert.ok(report.unresolvedFailures.includes(`DAILY_BARS_PACK_EXISTS_DIFFERENT:${DAY}`));
  assert.deepEqual(await packStore.get(dailyBarsSidecarFileKey(DAY)), before); // never overwritten
  assert.ok((await barsClient.get(`permanent/daily-bars/${DAY.slice(0, 7)}.jsonl`))?.length); // JSONL still written
});

test("daily-bars pack: a write error FAILS the run with DAILY_BARS_PACK_WRITE_FAILED:<date>:<code> only", async () => {
  class FailPack extends MemoryObjectClient {
    override async put(key: string, body: Uint8Array, metadata?: ObjectMetadata): Promise<void> {
      if (key.startsWith("permanent/daily-bars-sidecar/")) throw new Error("R2_PUT_503 secret-detail 123.45");
      await super.put(key, body, metadata);
    }
  }
  const report = await new MarketsScanner(harness([groupedBody("e")]).provider, new ObjectMarketStorage(new MemoryObjectClient()), US_EQUITY_CALENDAR, undefined,
    () => beforeNextSessionOpen(DAY), { store: new FailPack(), zstdVersionProbe: pinnedZstd }).run(DAY);
  assert.equal(report.status, "FAILED");
  const codes = report.unresolvedFailures.filter((f) => f.startsWith("DAILY_BARS_PACK_"));
  assert.deepEqual(codes, [`DAILY_BARS_PACK_WRITE_FAILED:${DAY}:R2_PUT_503`]);
  // Missing pinned zstd is a write error too.
  const noZstd = await new MarketsScanner(harness([groupedBody("z")]).provider, new ObjectMarketStorage(new MemoryObjectClient()), US_EQUITY_CALENDAR, undefined,
    () => beforeNextSessionOpen(DAY), { store: new MemoryObjectClient(), zstdVersionProbe: () => undefined }).run(DAY);
  assert.equal(noZstd.status, "FAILED");
  assert.ok(noZstd.unresolvedFailures.includes(`DAILY_BARS_PACK_WRITE_FAILED:${DAY}:REPLY_DUST_ZSTD_MISSING`));
});

test("daily-bars pack: exists-same on a rescan is fine (run not failed by the pack)", async () => {
  const packStore = new MemoryObjectClient(); const barsClient = new MemoryObjectClient();
  const run = () => new MarketsScanner(harness([groupedBody("s")]).provider, new ObjectMarketStorage(barsClient), US_EQUITY_CALENDAR, undefined,
    () => beforeNextSessionOpen(DAY), { store: packStore, zstdVersionProbe: pinnedZstd }).run(DAY);
  await run();
  const again = await run();
  assert.ok(!again.unresolvedFailures.some((f) => f.startsWith("DAILY_BARS_PACK_")));
  // Direct: same rows again => exists-same, no failure.
  const { maybeWriteScanDailyBarsSidecar } = await import("./daily-bars-sidecar");
  const bars = new TextDecoder().decode((await barsClient.get(`permanent/daily-bars/${DAY.slice(0, 7)}.jsonl`))!).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const same = await maybeWriteScanDailyBarsSidecar({ enabled: true, store: packStore, sessionDate: DAY, bars, securities: [], zstdVersionProbe: pinnedZstd });
  assert.equal(same.status, "exists-same");
  assert.equal(same.failure, undefined);
});
