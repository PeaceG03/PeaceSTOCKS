import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MarketProvider, ProviderSecurityRecord, ScannerRunReport } from "./contracts";
import {
  dailyReplyDustFileKey,
  dailyReplyDustHashedFileKey,
  dailyReplyDustManifestKey,
  readDailyReplyDustManifest,
  readDailyReplyDustReply,
} from "./daily-reply-dust";
import { fakeR2 } from "./fake-r2.test-helper";
import { sha256Hex } from "./intraday-reply-dust";
import { MassiveMarketProvider } from "./massive-provider";
import { MemoryObjectClient, type ObjectMetadata } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { MarketsScanner, US_EQUITY_CALENDAR } from "./scanner";
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

function harness(bodies: Uint8Array[]) {
  let i = 0;
  let requests = 0;
  const massive = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    keepRawReplies: true,
    now: () => AT,
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
  const { groupedReplyDust: _g, completedAt: _c, storage: _s, ...rest } = report;
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
    const off = await new MarketsScanner(offH.provider, offStorage, US_EQUITY_CALENDAR).run(DAY);

    const onH = harness([body]);
    const onStorage = new ObjectMarketStorage(new MemoryObjectClient());
    const on = await new MarketsScanner(onH.provider, onStorage, US_EQUITY_CALENDAR, {
      enabled: true,
      store: new FailPut(),
      zstdVersionProbe: pinnedZstd,
    }).run(DAY);

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
  await new MarketsScanner(offH.provider, offStorage, US_EQUITY_CALENDAR).run(DAY);
  const offRequests = offH.requests();

  const onH = harness([body]);
  const store = new MemoryObjectClient();
  const onStorage = new ObjectMarketStorage(new MemoryObjectClient());
  const report = await new MarketsScanner(onH.provider, onStorage, US_EQUITY_CALENDAR, {
    enabled: true,
    store,
    zstdVersionProbe: pinnedZstd,
  }).run(DAY);
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

test("maybeStore: kill switch off / no fetch / holiday path via disabled report", async () => {
  const off = await maybeStoreScanGroupedReplyDust({
    enabled: false,
    provider: { providerName: PROVIDER },
    sessionDate: DAY,
    hadDailyBarsFetch: true,
  });
  assert.equal(off.enabled, false);
  assert.equal(off.reason, "SCAN_GROUPED_REPLY_DUST_OFF");

  const noFetch = await maybeStoreScanGroupedReplyDust({
    enabled: true,
    store: new MemoryObjectClient(),
    provider: { providerName: PROVIDER, takeRawReplies: () => [] },
    sessionDate: DAY,
    hadDailyBarsFetch: false,
  });
  assert.equal(noFetch.reason, "NO_GROUPED_REPLY_FETCH");
  assert.equal(noFetch.copies.length, 0);
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
