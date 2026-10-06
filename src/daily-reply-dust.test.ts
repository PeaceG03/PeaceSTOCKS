import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalDailyBar, MarketProvider, ProviderSecurityRecord } from "./contracts";
import { backfillHistoricalEvidence } from "./backfill";
import {
  dailyReplyDustFileKey,
  readDailyReplyDustBars,
  readDailyReplyDustManifest,
  readDailyReplyDustReply,
  writeDailyReplyDust,
} from "./daily-reply-dust";
import { securityId } from "./identity";
import { MassiveMarketProvider, groupedDailySymbolIndex, symbolBySecurityIdFor } from "./massive-provider";
import { MemoryObjectClient, type ObjectMetadata } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import {
  REPLY_DUST_FALLBACK_VERSION,
  REPLY_DUST_VERSION,
  type ReplyDustBackend,
  decodeReplyDust,
  encodeReplyDust,
  nodeReplyDustBackend,
} from "./reply-dust";

const DAYS = ["2026-01-20", "2026-01-21", "2026-01-22"];
const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";
const universe: ProviderSecurityRecord[] = [
  { provider: "massive-stocks", providerSecurityId: "AAA", symbol: "AAA", assetType: "STOCK", country: "US", exchange: "XNYS", active: true, tradable: true },
  { provider: "massive-stocks", providerSecurityId: "SPY", symbol: "SPY", assetType: "ETF", country: "US", exchange: "ARCX", active: true, tradable: true },
];
const AAA = securityId("massive-stocks", "AAA", "STOCK");
const SPY = securityId("massive-stocks", "SPY", "ETF");

// Wire-shaped grouped replies: ZZZ is not in the universe, QQQ has no vw/n, odd float digits.
function grouped(day: string): string {
  const t = Date.parse(`${day}T21:00:00.000Z`);
  return `{"queryCount":4,"resultsCount":4,"adjusted":false,"results":[{"T":"AAA","v":1234567,"vw":100.1234,"o":100.12,"c":101.5,"h":102.25,"l":99.01,"t":${t},"n":4321},{"T":"ZZZ","v":12.5,"vw":3.3333,"o":3.3,"c":3.35,"h":3.4,"l":3.3,"t":${t},"n":3},{"T":"SPY","v":88888888,"vw":600.40000000000001,"o":600,"c":601.25,"h":602,"l":599.5,"t":${t},"n":999999},{"T":"QQQ","v":100,"o":500,"c":500,"h":500,"l":500,"t":${t}}],"status":"OK","request_id":"${day.replaceAll("-", "")}0123456789abcdef0123456789","count":4}`;
}

function harness(fetches: Record<string, number>) {
  const massive = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    keepRawReplies: true,
    now: () => "2026-01-22T23:00:00.000Z",
    fetchImpl: async (input) => {
      const day = /\/v2\/aggs\/grouped\/locale\/us\/market\/stocks\/(\d{4}-\d{2}-\d{2})$/u.exec(new URL(String(input)).pathname)?.[1];
      if (!day) return new Response('{"status":"ERROR"}', { status: 500 });
      fetches[day] = (fetches[day] ?? 0) + 1;
      return new Response(grouped(day), { status: 200 });
    },
  });
  const provider: MarketProvider & { bindUniverse(records: ProviderSecurityRecord[]): void } = {
    providerName: massive.providerName,
    listApprovedSecurities: async () => universe,
    getDailyBars: (day, ids) => massive.getDailyBars(day, ids),
    getCorporateActions: async () => [],
    takeRawReplies: () => massive.takeRawReplies(),
    bindUniverse: (records) => massive.bindUniverse(records),
  };
  return { massive, provider };
}

const bySymbol = () => groupedDailySymbolIndex(symbolBySecurityIdFor(universe), [AAA, SPY]);

class FailingClient extends MemoryObjectClient {
  failRdustFor: string | undefined;
  override async put(key: string, body: Uint8Array, metadata?: ObjectMetadata): Promise<void> {
    if (this.failRdustFor && key.endsWith(`${this.failRdustFor}/grouped-daily.rdust`)) throw new Error("STORE_DOWN");
    await super.put(key, body, metadata);
  }
}

test("daily Reply Dust is off by default: no new keys and no new result fields", async () => {
  const client = new MemoryObjectClient();
  const result = await backfillHistoricalEvidence({
    root: "/unused", from: DAYS[0]!, to: DAYS[0]!, provider: harness({}).provider,
    storage: new ObjectMarketStorage(client), env: {},
  });
  assert.deepEqual(result.completedSessions, [DAYS[0]]);
  assert.equal("replyDustFilesWritten" in result, false);
  assert.equal("replyDustFallbackFiles" in result, false);
  assert.deepEqual(await client.list("permanent/daily-reply-dust/"), []);
});

test("daily Reply Dust needs an explicit store when market storage is not local", async () => {
  await assert.rejects(
    backfillHistoricalEvidence({
      root: "/unused", from: DAYS[0]!, to: DAYS[0]!, provider: harness({}).provider,
      storage: new ObjectMarketStorage(new MemoryObjectClient()), env: {}, replyDust: true, zstdVersionProbe: pinnedZstd,
    }),
    /REPLY_DUST_STORE_REQUIRED/u,
  );
});

test("the same grouped reply gives identical daily bars via the live path and the Reply Dust reader", async () => {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const fetches: Record<string, number> = {};
  const result = await backfillHistoricalEvidence({
    root: "/unused", from: DAYS[0]!, to: DAYS[2]!, provider: harness(fetches).provider,
    storage, env: {}, replyDust: true, zstdVersionProbe: pinnedZstd, replyDustStore: client,
  });
  assert.deepEqual(result.completedSessions, DAYS);
  assert.equal(result.replyDustFilesWritten, 3);
  assert.equal(result.replyDustFallbackFiles, 0);
  assert.equal(result.replyDustZstdVersion, "1.5.7");
  assert.equal("warnings" in result, false);
  for (const day of DAYS) {
    const manifest = await readDailyReplyDustManifest(client, day);
    assert.ok(manifest);
    assert.equal(manifest.version, REPLY_DUST_VERSION);
    assert.equal(manifest.request, `/v2/aggs/grouped/locale/us/market/stocks/${day}?adjusted=false&include_otc=false`);
    assert.equal(manifest.fetchedAt, "2026-01-22T23:00:00.000Z");
    assert.equal(manifest.observedAt, "2026-01-22T23:00:00.000Z");
    assert.equal(manifest.retrievalId, `${day.replaceAll("-", "")}0123456789abcdef0123456789`);
    // The whole reply is kept byte for byte: every ticker, and vw/n where Massive sent them.
    const reply = await readDailyReplyDustReply(client, manifest);
    assert.deepEqual(reply, new TextEncoder().encode(grouped(day)));
    const rows = (JSON.parse(new TextDecoder().decode(reply)) as { results: Record<string, unknown>[] }).results;
    assert.deepEqual(rows.map((row) => row.T), ["AAA", "ZZZ", "SPY", "QQQ"]);
    assert.equal(rows[0]?.vw, 100.1234);
    assert.equal(rows[0]?.n, 4321);
    assert.equal(rows[2]?.n, 999999);
    // Reader bars equal the live provider's bars and the bars stored by the backfill.
    const readerBars = await readDailyReplyDustBars(client, day, bySymbol());
    const live = harness({}).massive;
    live.bindUniverse(universe);
    const liveBars = await live.getDailyBars(day, [AAA, SPY]);
    assert.equal(readerBars.length, 2);
    assert.deepEqual(readerBars, liveBars);
    const stored = (await storage.loadBars(day)).sort((a: CanonicalDailyBar, b: CanonicalDailyBar) => a.securityId.localeCompare(b.securityId));
    assert.deepEqual(stored, readerBars);
  }
  assert.deepEqual(fetches, { [DAYS[0]!]: 1, [DAYS[1]!]: 1, [DAYS[2]!]: 1 });
});

test("a store failing mid-run does not store bars or advance progress for that day", async () => {
  const client = new FailingClient();
  client.failRdustFor = DAYS[1];
  const storage = new ObjectMarketStorage(client);
  const fetches: Record<string, number> = {};
  const { provider } = harness(fetches);
  const run = () => backfillHistoricalEvidence({
    root: "/unused", from: DAYS[0]!, to: DAYS[2]!, provider, storage, env: {}, replyDust: true, zstdVersionProbe: pinnedZstd, replyDustStore: client,
  });
  const first = await run();
  assert.equal(first.stoppedOnError, true);
  assert.deepEqual(first.completedSessions, [DAYS[0]]);
  assert.match(first.failedSessions[DAYS[1]!] ?? "", /STORE_DOWN/u);
  assert.equal(first.replyDustFilesWritten, 1);
  const progress = (await storage.loadBackfillProgress()) as { completedSessions: string[] };
  assert.deepEqual(progress.completedSessions, [DAYS[0]]);
  assert.deepEqual(await storage.loadBars(DAYS[1]!), []);
  assert.equal(await client.get(dailyReplyDustFileKey(DAYS[1]!)), undefined);
  assert.equal(await readDailyReplyDustManifest(client, DAYS[1]!), undefined);

  client.failRdustFor = undefined;
  const second = await run();
  assert.deepEqual(second.completedSessions, [DAYS[1], DAYS[2]]);
  assert.deepEqual(second.skippedExistingSessions, [DAYS[0]]);
  assert.equal(second.replyDustFilesWritten, 2);
  assert.deepEqual(fetches, { [DAYS[0]!]: 1, [DAYS[1]!]: 2, [DAYS[2]!]: 1 });
  assert.equal((await storage.loadBars(DAYS[1]!)).length, 2);
});

test("a day already sealed in Reply Dust is rebuilt from the store, not fetched again", async () => {
  const client = new MemoryObjectClient();
  let failBars = true;
  class FlakyBars extends ObjectMarketStorage {
    override async appendBars(records: CanonicalDailyBar[]): Promise<void> {
      if (failBars) {
        failBars = false;
        throw new Error("BARS_DOWN");
      }
      await super.appendBars(records);
    }
  }
  const storage = new FlakyBars(client);
  const fetches: Record<string, number> = {};
  const { provider } = harness(fetches);
  const run = () => backfillHistoricalEvidence({
    root: "/unused", from: DAYS[0]!, to: DAYS[0]!, provider, storage, env: {}, replyDust: true, zstdVersionProbe: pinnedZstd, replyDustStore: client,
  });
  const first = await run();
  assert.equal(first.stoppedOnError, true);
  assert.ok(await readDailyReplyDustManifest(client, DAYS[0]!));
  const second = await run();
  assert.deepEqual(second.completedSessions, [DAYS[0]]);
  assert.equal(second.replyDustFilesWritten, 0);
  assert.deepEqual(fetches, { [DAYS[0]!]: 1 });
  const stored = (await storage.loadBars(DAYS[0]!)).sort((a, b) => a.securityId.localeCompare(b.securityId));
  assert.deepEqual(stored, await readDailyReplyDustBars(client, DAYS[0]!, bySymbol()));
});

test("a grouped reply that falls back to raw zstd is still stored, counted, and decodes exactly", async () => {
  const brokenTransform: ReplyDustBackend = {
    ...nodeReplyDustBackend,
    compress: (raw, dictionary) =>
      dictionary
        ? nodeReplyDustBackend.compress(new TextEncoder().encode("not the reply"), dictionary)
        : nodeReplyDustBackend.compress(raw, null),
  };
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const result = await backfillHistoricalEvidence({
    root: "/unused", from: DAYS[0]!, to: DAYS[0]!, provider: harness({}).provider, storage, env: {},
    replyDust: true, zstdVersionProbe: pinnedZstd, replyDustStore: client, replyDustBackend: brokenTransform,
  });
  assert.deepEqual(result.completedSessions, [DAYS[0]]);
  assert.equal(result.stoppedOnError, false);
  assert.equal(result.replyDustFilesWritten, 1);
  assert.equal(result.replyDustFallbackFiles, 1);
  // Run report: a warning, not a failure.
  assert.deepEqual(result.warnings, ["REPLY_DUST_FALLBACK_FILES:1"]);
  assert.equal(result.replyDustZstdVersion, "1.5.7");
  assert.deepEqual(result.failedSessions, {});
  const file = await client.get(dailyReplyDustFileKey(DAYS[0]!));
  assert.equal(file?.[0], REPLY_DUST_FALLBACK_VERSION);
  assert.deepEqual(decodeReplyDust(file!), new TextEncoder().encode(grouped(DAYS[0]!)));
  assert.equal((await readDailyReplyDustManifest(client, DAYS[0]!))?.version, REPLY_DUST_FALLBACK_VERSION);
  assert.equal((await storage.loadBars(DAYS[0]!)).length, 2);
});

test("a failed final decode-compare writes no grouped file and no manifest", async () => {
  let decompressCalls = 0;
  const lyingAfterEncode: ReplyDustBackend = {
    ...nodeReplyDustBackend,
    decompress: (frame, dictionary) => {
      const out = nodeReplyDustBackend.decompress(frame, dictionary);
      decompressCalls += 1;
      if (decompressCalls === 2) out[out.length - 1] = out[out.length - 1]! ^ 1;
      return out;
    },
  };
  const client = new MemoryObjectClient();
  await assert.rejects(
    writeDailyReplyDust(
      client,
      {
        dataset: "stocks-grouped-daily", sessionDate: DAYS[0]!,
        request: `/v2/aggs/grouped/locale/us/market/stocks/${DAYS[0]}?adjusted=false&include_otc=false`,
        fetchedAt: "2026-01-22T23:00:00.000Z", body: new TextEncoder().encode(grouped(DAYS[0]!)),
      },
      { provider: "massive-stocks", observedAt: "2026-01-22T23:00:00.000Z" },
      lyingAfterEncode,
    ),
    /REPLY_DUST_WRITE_VERIFY_FAILED/u,
  );
  assert.deepEqual(await client.list(""), []);
});

test("a whole-market grouped reply (10k tickers) encodes as Reply Dust v1, not the fallback", () => {
  const t = Date.parse("2026-01-20T21:00:00.000Z");
  const rows: string[] = [];
  for (let i = 0; i < 10_000; i += 1) {
    const price = 1 + ((i * 7919) % 30_000) / 100;
    rows.push(`{"T":"T${i.toString(36).toUpperCase()}","v":${(i * 104729) % 50_000_000},"vw":${(price + 0.0123).toFixed(4)},"o":${price},"c":${(price * 1.01).toFixed(4)},"h":${(price * 1.02).toFixed(4)},"l":${(price * 0.98).toFixed(4)},"t":${t},"n":${(i * 31) % 200_000}}`);
  }
  const body = new TextEncoder().encode(`{"queryCount":10000,"resultsCount":10000,"adjusted":false,"results":[${rows.join(",")}],"status":"OK","request_id":"0123456789abcdef0123456789abcdef","count":10000}`);
  const encoded = encodeReplyDust(body);
  assert.equal(encoded[0], REPLY_DUST_VERSION);
  assert.ok(encoded.length < body.length / 2);
  assert.deepEqual(decodeReplyDust(encoded), body);
});

for (const [label, probe, error] of [
  ["missing", () => undefined, /^Error: REPLY_DUST_ZSTD_MISSING$/u],
  ["a different version of", () => "*** Zstandard CLI (64-bit) v1.5.8, by Yann Collet ***", /^Error: REPLY_DUST_ZSTD_VERSION:1\.5\.8$/u],
] as const) {
  test(`daily Reply Dust refuses to start with zstd ${label} and writes nothing`, async () => {
    const client = new MemoryObjectClient();
    const fetches: Record<string, number> = {};
    await assert.rejects(
      backfillHistoricalEvidence({
        root: "/unused", from: DAYS[0]!, to: DAYS[0]!, provider: harness(fetches).provider,
        storage: new ObjectMarketStorage(client), env: {}, replyDust: true, replyDustStore: client,
        zstdVersionProbe: probe,
      }),
      (caught: unknown) => error.test(String(caught)),
    );
    assert.deepEqual(fetches, {});
    assert.deepEqual(await client.list(""), []);
  });
}

test("daily zstd pin is checked once per run and never with the switch off", async () => {
  let probes = 0;
  const client = new MemoryObjectClient();
  const on = await backfillHistoricalEvidence({
    root: "/unused", from: DAYS[0]!, to: DAYS[2]!, provider: harness({}).provider,
    storage: new ObjectMarketStorage(client), env: {}, replyDust: true, replyDustStore: client,
    zstdVersionProbe: () => {
      probes += 1;
      return pinnedZstd();
    },
  });
  assert.equal(on.replyDustFilesWritten, 3);
  assert.equal(probes, 1);
  const off = await backfillHistoricalEvidence({
    root: "/unused", from: DAYS[0]!, to: DAYS[0]!, provider: harness({}).provider,
    storage: new ObjectMarketStorage(new MemoryObjectClient()), env: {},
    zstdVersionProbe: () => {
      throw new Error("probe must not run with replyDust off");
    },
  });
  assert.deepEqual(off.completedSessions, [DAYS[0]]);
});

test("the grouped daily object carries its manifest fields as object metadata", async () => {
  const client = new MemoryObjectClient();
  await backfillHistoricalEvidence({
    root: "/unused", from: DAYS[0]!, to: DAYS[0]!, provider: harness({}).provider,
    storage: new ObjectMarketStorage(client), env: {}, replyDust: true, zstdVersionProbe: pinnedZstd,
    replyDustStore: client,
  });
  const manifest = (await readDailyReplyDustManifest(client, DAYS[0]!))!;
  const head = await client.head(dailyReplyDustFileKey(DAYS[0]!));
  assert.deepEqual(head, {
    size: manifest.byteLength,
    metadata: {
      "rd-schema": "daily-reply-dust-object-v1",
      "rd-provider": "massive-stocks",
      "rd-session-date": DAYS[0],
      "rd-dataset": "stocks-grouped-daily",
      "rd-request": manifest.request,
      "rd-fetched-at": manifest.fetchedAt,
      "rd-observed-at": manifest.observedAt,
      "rd-retrieval-id": manifest.retrievalId,
      "rd-version": String(manifest.version),
      "rd-reply-sha256": manifest.replySha256,
      "rd-reply-length": String(manifest.replyByteLength),
    },
  });
});
