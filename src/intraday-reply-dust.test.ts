import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SecurityMasterRecord } from "./contracts";
import { securityId } from "./identity";
import { backfillHistoricalIntradayEvidence, loadReplyDustProgress } from "./intraday-backfill";
import {
  FileReplyDustStore,
  type ReplyDustFileEntry,
  readReplyDustManifest,
  readReplyDustReply,
  readReplyDustSecurityDay,
  replyDustFileKey,
  decodeTenMinuteFile,
  writeReplyDustFile,
} from "./intraday-reply-dust";
import { MassiveMarketProvider } from "./massive-provider";
import { MemoryObjectClient } from "./object-store";
import { DustReader } from "./reader";
import {
  REPLY_DUST_FALLBACK_VERSION,
  REPLY_DUST_VERSION,
  type ReplyDustBackend,
  decodeReplyDust,
  nodeReplyDustBackend,
} from "./reply-dust";
import { MarketStorage } from "./storage";

const SESSION = "2026-01-02";
const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";
const at = (time: string) => Date.parse(`${SESSION}T${time}:00.000Z`);

function security(symbol: string): SecurityMasterRecord {
  return {
    securityId: securityId("massive-stocks", symbol, "STOCK"),
    currentSymbol: symbol,
    historicalSymbols: [],
    assetType: "STOCK",
    country: "US",
    exchange: "XNYS",
    firstSeenAt: "2025-01-01T00:00:00.000Z",
    status: "ACTIVE",
    tradable: true,
    providerIdentities: [{ provider: "massive-stocks", providerSecurityId: symbol }],
    eligibility: "LEVEL_0",
    barCount: 0,
    lastUniverseSeenAt: SESSION,
  };
}

// Wire-shaped replies: a non-4-decimal price, a fractional volume, an extra unknown field.
const replies: Record<string, string> = {
  AAA: `{"ticker":"AAA","queryCount":3,"resultsCount":3,"adjusted":false,"results":[{"v":1200,"vw":100.1234,"o":100.12,"c":100.2,"h":100.25,"l":100.01,"t":${at("14:30")},"n":31},{"v":350.5,"vw":100.3,"o":100.2,"c":100.40000000000001,"h":100.45,"l":100.15,"t":${at("14:40")},"n":9},{"v":0,"vw":100.4,"o":100.4,"c":100.4,"h":100.4,"l":100.4,"t":${at("20:50")},"n":0}],"status":"OK","request_id":"0123456789abcdef0123456789abcdef","count":3}`,
  BBB: `{"ticker":"BBB","queryCount":1,"resultsCount":1,"adjusted":false,"results":[{"v":10,"vw":5.5,"o":5.5,"c":5.5,"h":5.5,"l":5.5,"t":${at("15:00")},"n":1,"otc":false}],"status":"OK","request_id":"fedcba9876543210fedcba9876543210","count":1}`,
};

function fakeMassive(fetches: Record<string, number>): MassiveMarketProvider {
  return new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    keepRawReplies: true,
    now: () => "2026-01-02T22:00:00.000Z",
    fetchImpl: async (input) => {
      const symbol = /\/v2\/aggs\/ticker\/([^/]+)\/range\/10\/minute\//u.exec(new URL(String(input)).pathname)?.[1];
      const body = symbol ? replies[symbol] : undefined;
      if (!symbol || !body) return new Response('{"status":"ERROR"}', { status: 500 });
      fetches[symbol] = (fetches[symbol] ?? 0) + 1;
      return new Response(body, { status: 200 });
    },
  });
}

async function marketRoot(symbols: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-reply-dust-"));
  const storage = new MarketStorage(root);
  await storage.initialize();
  await storage.saveSecurities(symbols.map(security));
  return root;
}

const exists = (path: string) => stat(path).then(() => true, () => false);

class FailingStore extends MemoryObjectClient {
  failNextRdust = 0;
  override async put(key: string, body: Uint8Array): Promise<void> {
    if (key.endsWith(".rdust") && this.failNextRdust > 0 && --this.failNextRdust === 0)
      throw new Error("STORE_DOWN");
    await super.put(key, body);
  }
}

test("Reply Dust is off by default: old layout, result, and state are unchanged", async () => {
  const root = await marketRoot(["AAA"]);
  try {
    const result = await backfillHistoricalIntradayEvidence({ root, from: SESSION, to: SESSION, provider: fakeMassive({}) });
    assert.deepEqual(result.completedSessions, [SESSION]);
    assert.equal("replyDustFilesWritten" in result, false);
    assert.equal("replyDustFallbackFiles" in result, false);
    assert.equal(await exists(join(root, "permanent", "intraday-reply-dust")), false);
    assert.equal(await exists(join(root, "transient", "reply-dust-progress")), false);
    assert.equal((await new DustReader(root).manifest(SESSION)).validation, "SEALED_CANONICAL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same 10-minute reply gives identical canonical bars via old .dust and Reply Dust", async () => {
  const root = await marketRoot(["AAA", "BBB"]);
  try {
    const fetches: Record<string, number> = {};
    const result = await backfillHistoricalIntradayEvidence({
      root, from: SESSION, to: SESSION, provider: fakeMassive(fetches), replyDust: true, zstdVersionProbe: pinnedZstd,
    });
    assert.deepEqual(result.completedSessions, [SESSION]);
    assert.equal(result.replyDustFilesWritten, 2);
    assert.equal(result.replyDustFallbackFiles, 0);
    assert.equal(result.replyDustZstdVersion, "1.5.7");
    assert.equal("warnings" in result, false);
    assert.deepEqual(fetches, { AAA: 1, BBB: 1 });
    const store = new FileReplyDustStore(root);
    const manifest = await readReplyDustManifest(store, SESSION);
    assert.ok(manifest);
    assert.equal(manifest.fileCount, 2);
    assert.equal(manifest.fallbackFileCount, 0);
    const old = new DustReader(root);
    for (const symbol of ["AAA", "BBB"]) {
      const id = securityId("massive-stocks", symbol, "STOCK");
      const entry: ReplyDustFileEntry | undefined = manifest.files.find((file) => file.securityId === id);
      assert.ok(entry);
      assert.equal(entry.symbol, symbol);
      assert.equal(entry.version, REPLY_DUST_VERSION);
      assert.equal(entry.request, `/v2/aggs/ticker/${symbol}/range/10/minute/${SESSION}/${SESSION}?adjusted=false&sort=asc&limit=50000`);
      assert.equal(entry.fetchedAt, "2026-01-02T22:00:00.000Z");
      // Lossless: the stored file decodes to the exact wire bytes.
      const reply = await readReplyDustReply(store, SESSION, entry);
      assert.deepEqual(reply, new TextEncoder().encode(replies[symbol]));
      const oldBars = await old.readSecurityDay(SESSION, id);
      const newBars = await readReplyDustSecurityDay(store, SESSION, id);
      assert.equal(oldBars.length, 39);
      assert.deepEqual(newBars, oldBars);
      // One decoder entry point picks the format from the leading byte(s).
      const rdust = await readFile(join(root, replyDustFileKey(SESSION, id)));
      const dustBlock = (await old.manifest(SESSION)).blocks.find((block) => block.securityId === id)!;
      const dust = await readFile(join(root, "permanent", "intraday-dust", SESSION, dustBlock.relativePath));
      assert.deepEqual(decodeTenMinuteFile(rdust, { provider: manifest.provider, sessionDate: SESSION, entry }), oldBars);
      assert.deepEqual(decodeTenMinuteFile(dust), oldBars);
    }
    assert.deepEqual(await loadReplyDustProgress(root, SESSION), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a store failing mid-session never advances progress past unwritten data", async () => {
  const root = await marketRoot(["AAA", "BBB"]);
  try {
    const store = new FailingStore();
    store.failNextRdust = 2; // the second Reply Dust file write fails
    const fetches: Record<string, number> = {};
    const provider = fakeMassive(fetches);
    const first = await backfillHistoricalIntradayEvidence({
      root, from: SESSION, to: SESSION, provider, replyDust: true, zstdVersionProbe: pinnedZstd, replyDustStore: store,
    });
    assert.equal(first.stoppedOnError, true);
    assert.match(first.failedSessions[SESSION] ?? "", /STORE_DOWN/u);
    assert.deepEqual(first.completedSessions, []);
    assert.equal(first.replyDustFilesWritten, 1);
    const aaa = securityId("massive-stocks", "AAA", "STOCK");
    const bbb = securityId("massive-stocks", "BBB", "STOCK");
    const progress = await loadReplyDustProgress(root, SESSION);
    assert.deepEqual(progress.map((entry) => entry.securityId), [aaa]);
    assert.ok(await store.get(replyDustFileKey(SESSION, aaa)));
    assert.equal(await store.get(replyDustFileKey(SESSION, bbb)), undefined);
    assert.equal(await readReplyDustManifest(store, SESSION), undefined);
    const state = JSON.parse(await readFile(join(root, "intraday-backfill-state.json"), "utf8"));
    assert.deepEqual(state.completedSessions, []);
    await assert.rejects(new DustReader(root).manifest(SESSION));

    // Resume: only the unwritten file is fetched again; the written one is read back from the store.
    const second = await backfillHistoricalIntradayEvidence({
      root, from: SESSION, to: SESSION, provider, replyDust: true, zstdVersionProbe: pinnedZstd, replyDustStore: store,
    });
    assert.deepEqual(second.completedSessions, [SESSION]);
    assert.equal(second.replyDustFilesWritten, 1);
    assert.deepEqual(fetches, { AAA: 1, BBB: 2 });
    assert.equal((await readReplyDustManifest(store, SESSION))?.fileCount, 2);
    assert.deepEqual(
      await readReplyDustSecurityDay(store, SESSION, aaa),
      await new DustReader(root).readSecurityDay(SESSION, aaa),
    );
    assert.deepEqual(await loadReplyDustProgress(root, SESSION), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reply that falls back to raw zstd is still stored, counted, and decodes exactly", async () => {
  const root = await marketRoot(["AAA"]);
  try {
    // The transformed (dictionary) path produces a frame that fails verification, forcing 0x81.
    const brokenTransform: ReplyDustBackend = {
      ...nodeReplyDustBackend,
      compress: (raw, dictionary) =>
        dictionary
          ? nodeReplyDustBackend.compress(new TextEncoder().encode("not the reply"), dictionary)
          : nodeReplyDustBackend.compress(raw, null),
    };
    const store = new MemoryObjectClient();
    const result = await backfillHistoricalIntradayEvidence({
      root, from: SESSION, to: SESSION, provider: fakeMassive({}),
      replyDust: true, zstdVersionProbe: pinnedZstd, replyDustStore: store, replyDustBackend: brokenTransform,
    });
    assert.deepEqual(result.completedSessions, [SESSION]);
    assert.equal(result.stoppedOnError, false);
    assert.equal(result.replyDustFilesWritten, 1);
    assert.equal(result.replyDustFallbackFiles, 1);
    // Run report: a warning, not a failure.
    assert.deepEqual(result.warnings, ["REPLY_DUST_FALLBACK_FILES:1"]);
    assert.equal(result.replyDustZstdVersion, "1.5.7");
    assert.deepEqual(result.failedSessions, {});
    const id = securityId("massive-stocks", "AAA", "STOCK");
    const file = await store.get(replyDustFileKey(SESSION, id));
    assert.equal(file?.[0], REPLY_DUST_FALLBACK_VERSION);
    assert.deepEqual(decodeReplyDust(file!), new TextEncoder().encode(replies.AAA));
    const manifest = await readReplyDustManifest(store, SESSION);
    assert.equal(manifest?.fallbackFileCount, 1);
    assert.deepEqual(
      await readReplyDustSecurityDay(store, SESSION, id),
      await new DustReader(root).readSecurityDay(SESSION, id),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed final decode-compare stops that file before anything is written", async () => {
  let decompressCalls = 0;
  // Honest while encodeReplyDust verifies itself, then lies on the writer's own decode.
  const lyingAfterEncode: ReplyDustBackend = {
    ...nodeReplyDustBackend,
    decompress: (frame, dictionary) => {
      const out = nodeReplyDustBackend.decompress(frame, dictionary);
      decompressCalls += 1;
      if (decompressCalls === 2) out[out.length - 1] = out[out.length - 1]! ^ 1;
      return out;
    },
  };
  const store = new MemoryObjectClient();
  const id = securityId("massive-stocks", "AAA", "STOCK");
  await assert.rejects(
    writeReplyDustFile(
      store,
      {
        dataset: "stocks-aggregates-10m", sessionDate: SESSION, securityId: id, symbol: "AAA",
        request: "/v2/aggs/ticker/AAA/range/10/minute/2026-01-02/2026-01-02", fetchedAt: "2026-01-02T22:00:00.000Z",
        body: new TextEncoder().encode(replies.AAA),
      },
      "2026-01-02T22:00:00.000Z",
      lyingAfterEncode,
    ),
    /REPLY_DUST_WRITE_VERIFY_FAILED/u,
  );
  assert.deepEqual(await store.list(""), []);
});

for (const [label, probe, error] of [
  ["missing", () => undefined, /^Error: REPLY_DUST_ZSTD_MISSING$/u],
  ["a different version of", () => "*** Zstandard CLI (64-bit) v1.5.6, by Yann Collet ***", /^Error: REPLY_DUST_ZSTD_VERSION:1\.5\.6$/u],
] as const) {
  test(`10-minute Reply Dust refuses to start with zstd ${label} and writes nothing`, async () => {
    const root = await marketRoot(["AAA"]);
    try {
      const fetches: Record<string, number> = {};
      const store = new MemoryObjectClient();
      await assert.rejects(
        backfillHistoricalIntradayEvidence({
          root, from: SESSION, to: SESSION, provider: fakeMassive(fetches),
          replyDust: true, replyDustStore: store, zstdVersionProbe: probe,
        }),
        (caught: unknown) => error.test(String(caught)),
      );
      assert.deepEqual(fetches, {});
      assert.deepEqual(await store.list(""), []);
      assert.equal(await exists(join(root, "intraday-backfill-state.json")), false);
      assert.equal(await exists(join(root, "permanent", "intraday-reply-dust")), false);
      assert.equal(await exists(join(root, "transient", "reply-dust-progress")), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("10-minute zstd pin is checked once per run and never with the switch off", async () => {
  const root = await marketRoot(["AAA", "BBB"]);
  try {
    let probes = 0;
    const counted = () => {
      probes += 1;
      return pinnedZstd();
    };
    const store = new MemoryObjectClient();
    const on = await backfillHistoricalIntradayEvidence({
      root, from: SESSION, to: "2026-01-06", provider: fakeMassive({}),
      replyDust: true, replyDustStore: store, zstdVersionProbe: counted,
    });
    assert.equal(on.replyDustFilesWritten, 2 * on.completedSessions.length);
    assert.equal(probes, 1);
    const offRoot = await marketRoot(["AAA"]);
    try {
      const off = await backfillHistoricalIntradayEvidence({
        root: offRoot, from: SESSION, to: SESSION, provider: fakeMassive({}),
        zstdVersionProbe: () => {
          throw new Error("probe must not run with replyDust off");
        },
      });
      assert.deepEqual(off.completedSessions, [SESSION]);
    } finally {
      await rm(offRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
