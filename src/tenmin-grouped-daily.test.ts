import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderRawReply, SecurityMasterRecord, TenMinuteRangeReply } from "./contracts";
import { dailyReplyDustFileKey, dailyReplyDustManifestKey, readDailyReplyDustManifest } from "./daily-reply-dust";
import { fakeR2 } from "./fake-r2.test-helper";
import { securityId } from "./identity";
import { MassiveMarketProvider } from "./massive-provider";
import { MemoryObjectClient, type ObjectMetadata } from "./object-store";
import { GROUPED_DAILY_MISSING, storeRangeGroupedDaily } from "./tenmin-grouped-daily";
import { runTenMinHistory, tradingSessionsBetween } from "./tenmin-history";
import { readTenMinRangeManifest, tenMinRangeManifestKey } from "./tenmin-range-reply-dust";

const PROVIDER = "massive-stocks";
const AT = "2026-10-06T08:00:00.000Z";
const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";
const id = (symbol: string) => securityId(PROVIDER, symbol, "STOCK");
const encoder = new TextEncoder();
const NOV_DEC = tradingSessionsBetween("2024-11-01", "2024-12-31");

function groupedReply(sessionDate: string, results = 1): ProviderRawReply {
  const rows = Array.from({ length: results }, (_, i) => `{"T":"T${i}","v":1,"o":1,"c":1,"h":1,"l":1,"t":1730000000000,"n":1}`);
  return {
    dataset: "stocks-grouped-daily",
    sessionDate,
    request: `/v2/aggs/grouped/locale/us/market/stocks/${sessionDate}?adjusted=false&include_otc=false`,
    fetchedAt: AT,
    body: encoder.encode(
      `{"queryCount":${results},"resultsCount":${results},"adjusted":false,${results ? `"results":[${rows.join(",")}],` : ""}"status":"OK","request_id":"G-${sessionDate}","count":${results}}`,
    ),
  };
}

function pagesFor(s: { securityId: string; symbol: string }, from: string, to: string): TenMinuteRangeReply[] {
  return [
    {
      page: 1,
      request: `/v2/aggs/ticker/${s.symbol}/range/10/minute/${from}/${to}?adjusted=false&sort=asc&limit=50000`,
      fetchedAt: AT,
      body: encoder.encode(`{"ticker":"${s.symbol}","results":[{"v":1,"o":1,"c":1,"h":1,"l":1,"t":1730800000000,"n":1}],"status":"OK","request_id":"R-${s.symbol}","count":1}`),
      rangeFrom: from,
      rangeTo: to,
      securityId: s.securityId,
      symbol: s.symbol,
    },
  ];
}

function master(symbol: string): SecurityMasterRecord {
  return {
    securityId: id(symbol),
    currentSymbol: symbol,
    historicalSymbols: [{ symbol, effectiveFrom: "2026-10-02", source: PROVIDER }],
    assetType: "STOCK",
    country: "US",
    exchange: "NYSE",
    firstSeenAt: "2026-10-02",
    status: "ACTIVE",
    tradable: true,
    providerIdentities: [{ provider: PROVIDER, providerSecurityId: symbol }],
    eligibility: "LEVEL_0",
    barCount: 0,
    lastUniverseSeenAt: "2026-10-05",
  };
}

const symbols = ["AAA", "BBB"];
const allSessions = tradingSessionsBetween("2024-10-01", "2025-03-31");
async function loadBars(month: string) {
  return new Map(symbols.map((s) => [id(s), new Set(allSessions.filter((d) => d.startsWith(`${month}-`)))]));
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-tenmin-grouped-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runNovDec(
  root: string,
  store: NonNullable<Parameters<typeof runTenMinHistory>[0]["store"]>,
  log: string[],
  extra: Partial<Parameters<typeof runTenMinHistory>[0]> = {},
) {
  return runTenMinHistory({
    root,
    store,
    securities: symbols.map(master),
    loadDailyBarSessions: loadBars,
    lastCompletedSession: "2025-01-06",
    maxRanges: 1,
    writeReport: false,
    zstdVersionProbe: pinnedZstd,
    env: {},
    nowIso: () => AT,
    fetchGroupedDaily: async (date) => {
      log.push(`G:${date}`);
      return groupedReply(date);
    },
    fetchPages: async (s, f, t) => {
      log.push(`T:${s.symbol}`);
      return pagesFor(s, f, t);
    },
    ...extra,
  });
}

test("a range stores one grouped-daily reply per session, oldest first, before any 10-minute fetch", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const log: string[] = [];
    const result = await runNovDec(root, store, log);
    assert.equal(NOV_DEC.length, 41);
    assert.deepEqual(log, [...NOV_DEC.map((d) => `G:${d}`), "T:AAA", "T:BBB"]);
    for (const date of NOV_DEC) {
      assert.ok(await store.get(dailyReplyDustFileKey(date)));
      assert.equal((await readDailyReplyDustManifest(store, date))?.request, groupedReply(date).request);
    }
    const range = result.report.ranges[0]!;
    assert.equal(range.status, "SEALED");
    assert.deepEqual([range.groupedDailyRequests, range.groupedDailyStored, range.groupedDailyResumed], [41, 41, 0]);
    assert.equal(range.massiveRequests, 43);
    assert.deepEqual(
      [result.report.groupedDailyRequests, result.report.groupedDailyStored, result.report.groupedDailyResumed],
      [41, 41, 0],
    );
    assert.equal(result.report.massiveRequests, 43);
    assert.equal(range.delistedCoverage, "MISSING");

    // Resume (reopen): every stored grouped reply verifies, 0 grouped requests.
    log.length = 0;
    const again = await runNovDec(root, store, log, { reopen: true });
    assert.deepEqual(log, []);
    assert.deepEqual(
      [again.report.groupedDailyRequests, again.report.groupedDailyStored, again.report.groupedDailyResumed],
      [0, 0, 41],
    );
    // A sealed range with no reopen does not touch grouped replies at all.
    const sealed = await runNovDec(root, store, log);
    assert.equal(sealed.report.ranges[0]?.status, "ALREADY_SEALED");
    assert.equal(sealed.report.ranges[0]?.groupedDailyRequests, undefined);
    assert.equal(sealed.report.groupedDailyRequests, 0);
  });
});

test("a 404 or empty grouped reply becomes a GROUPED_DAILY_MISSING gap and the range still seals", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const log: string[] = [];
    const result = await runNovDec(root, store, log, {
      fetchGroupedDaily: async (date) => {
        log.push(`G:${date}`);
        if (date === "2024-11-15") throw new Error("MASSIVE_HTTP_404:requestId=x:body=not found");
        if (date === "2024-11-18") return groupedReply(date, 0);
        return groupedReply(date);
      },
    });
    const range = result.report.ranges[0]!;
    assert.equal(range.status, "SEALED");
    assert.deepEqual([range.groupedDailyRequests, range.groupedDailyStored], [41, 39]);
    const missing = range.gaps.filter((g) => g.reason === GROUPED_DAILY_MISSING);
    assert.deepEqual(missing.map((g) => [g.securityId, g.fetchFrom, g.fetchTo]), [
      ["", "2024-11-15", "2024-11-15"],
      ["", "2024-11-18", "2024-11-18"],
    ]);
    assert.equal(await store.get(dailyReplyDustManifestKey("2024-11-15")), undefined);
    assert.ok(log.includes("T:AAA"));
    const manifest = (await readTenMinRangeManifest(store, "2024-11-01", "2024-12-31"))!;
    assert.equal(manifest.gaps.filter((g) => g.reason === GROUPED_DAILY_MISSING).length, 2);
    // Reopen later: only the 2 missing sessions are requested, and the resolved gaps clear.
    log.length = 0;
    const reopened = await runNovDec(root, store, log, { reopen: true });
    assert.deepEqual(log, ["G:2024-11-15", "G:2024-11-18"]);
    assert.deepEqual(reopened.report.ranges[0]?.gaps, []);
    assert.deepEqual((await readTenMinRangeManifest(store, "2024-11-01", "2024-12-31"))!.gaps, []);
  });
});

test("a single 503 in the grouped step becomes a GROUPED_DAILY_MISSING gap, the range seals, and reopen retries that day", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const log: string[] = [];
    let failing = true;
    const fetchGroupedDaily = async (date: string) => {
      log.push(`G:${date}`);
      if (failing && date === "2024-11-20") throw new Error("MASSIVE_HTTP_503:requestId=x:body=busy");
      return groupedReply(date);
    };
    const result = await runNovDec(root, store, log, { fetchGroupedDaily });
    const range = result.report.ranges[0]!;
    assert.equal(range.status, "SEALED");
    assert.equal(result.report.outageStop, undefined);
    assert.deepEqual([range.groupedDailyRequests, range.groupedDailyStored], [41, 40]);
    assert.deepEqual(
      range.gaps.filter((g) => g.reason === GROUPED_DAILY_MISSING).map((g) => g.fetchFrom),
      ["2024-11-20"],
    );
    const sealed = (await readTenMinRangeManifest(store, "2024-11-01", "2024-12-31"))!;
    assert.deepEqual(sealed.gaps.map((g) => [g.reason, g.fetchFrom, g.fetchTo]), [
      [GROUPED_DAILY_MISSING, "2024-11-20", "2024-11-20"],
    ]);
    // Reopen while it still fails: the gap is kept (not dropped by the authoritative re-check).
    log.length = 0;
    const stillFailing = await runNovDec(root, store, log, { reopen: true, fetchGroupedDaily });
    assert.deepEqual(log, ["G:2024-11-20"]);
    assert.deepEqual(
      (await readTenMinRangeManifest(store, "2024-11-01", "2024-12-31"))!.gaps.map((g) => g.fetchFrom),
      ["2024-11-20"],
    );
    assert.equal(stillFailing.report.ranges[0]?.status, "REOPENED");
    // Reopen once it succeeds: stored, gap dropped.
    failing = false;
    log.length = 0;
    await runNovDec(root, store, log, { reopen: true, fetchGroupedDaily });
    assert.deepEqual(log, ["G:2024-11-20"]);
    assert.ok(await readDailyReplyDustManifest(store, "2024-11-20"));
    assert.deepEqual((await readTenMinRangeManifest(store, "2024-11-01", "2024-12-31"))!.gaps, []);
  });
});

test("every session ends stored, as a gap, or the step stops resumably", async () => {
  // Mix of outcomes below the outage limit: each session is accounted for exactly once.
  const store = new MemoryObjectClient();
  const sessions = NOV_DEC.slice(0, 12);
  const outcome = (i: number) =>
    ["ok", "503", "ok", "net", "404", "empty", "ok", "500", "ok", "ok", "429x", "ok"][i]!;
  const step = await storeRangeGroupedDaily({
    store,
    provider: PROVIDER,
    sessions: sessions.slice(0, 10),
    now: () => AT,
    fetchGroupedDaily: async (date) => {
      const kind = outcome(sessions.indexOf(date));
      if (kind === "503") throw new Error("MASSIVE_HTTP_503:x");
      if (kind === "500") throw new Error("MASSIVE_HTTP_500:x");
      if (kind === "net") throw new Error("MASSIVE_NETWORK:reset");
      if (kind === "404") throw new Error("MASSIVE_HTTP_404:x");
      if (kind === "empty") return groupedReply(date, 0);
      return groupedReply(date);
    },
  });
  const gapped = step.gaps.map((g) => g.fetchFrom!);
  const stored = [];
  for (const date of sessions.slice(0, 10)) if (await readDailyReplyDustManifest(store, date)) stored.push(date);
  assert.equal(step.requests, 10);
  assert.equal(stored.length, step.stored);
  assert.deepEqual([...stored, ...gapped].sort(), sessions.slice(0, 10));
  assert.equal(new Set([...stored, ...gapped]).size, 10);
  assert.equal(step.outageStop, undefined);
  // Five outage failures in a row stop the step (unsealed, resumable) instead of gapping a 5th.
  const stop = await storeRangeGroupedDaily({
    store: new MemoryObjectClient(),
    provider: PROVIDER,
    sessions: NOV_DEC.slice(0, 7),
    fetchGroupedDaily: async () => {
      throw new Error("MASSIVE_NETWORK:down");
    },
  });
  assert.ok(stop.outageStop?.startsWith("MASSIVE_OUTAGE:"));
  assert.equal(stop.requests, 5);
  assert.equal(stop.gaps.length, 4);
});

test("a store error in the grouped step throws with 0 further requests", async () => {
  await withRoot(async (root) => {
    const inner = new MemoryObjectClient();
    let puts = 0;
    const store = {
      get: (k: string) => inner.get(k),
      head: (k: string) => inner.head(k),
      list: (p: string) => inner.list(p),
      put: async (k: string, body: Uint8Array, metadata?: ObjectMetadata) => {
        if (k.startsWith("permanent/daily-reply-dust/") && k.endsWith(".rdust") && ++puts === 3)
          throw new Error("R2_PUT_500");
        return inner.put(k, body, metadata);
      },
    };
    const log: string[] = [];
    const result = await runNovDec(root, store, log);
    assert.deepEqual(log, NOV_DEC.slice(0, 3).map((d) => `G:${d}`));
    assert.equal(result.report.stoppedOnError, true);
    assert.match(result.report.error ?? "", /R2_PUT_500/);
    assert.equal(result.report.ranges[0]?.status, "ERROR");
    assert.equal(result.report.ranges[0]?.groupedDailyRequests, 3);
    assert.equal(result.report.groupedDailyRequests, 3);
    assert.equal(result.report.massiveRequests, 3);
    assert.equal(await inner.get(tenMinRangeManifestKey("2024-11-01", "2024-12-31")), undefined);
  });
});

test("a yield partway through the grouped step stops cleanly and the next run resumes", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const log: string[] = [];
    let checks = 0;
    const first = await runNovDec(root, store, log, {
      // 1 check before the range, then 1 before each grouped request: yield before the 11th.
      shouldYield: async () => (++checks > 11 ? "TIME_BUDGET:test" : undefined),
    });
    assert.equal(first.report.yieldedForScan, "TIME_BUDGET:test");
    assert.equal(first.report.stoppedOnError, false);
    assert.equal(first.report.ranges[0]?.status, "PARTIAL");
    assert.equal(first.report.ranges[0]?.groupedDailyStored, 10);
    assert.deepEqual(log, NOV_DEC.slice(0, 10).map((d) => `G:${d}`));
    assert.equal(await store.get(tenMinRangeManifestKey("2024-11-01", "2024-12-31")), undefined);
    log.length = 0;
    const second = await runNovDec(root, store, log);
    assert.deepEqual(log, [...NOV_DEC.slice(10).map((d) => `G:${d}`), "T:AAA", "T:BBB"]);
    assert.deepEqual(
      [second.report.groupedDailyRequests, second.report.groupedDailyStored, second.report.groupedDailyResumed],
      [31, 31, 10],
    );
    assert.equal(second.report.ranges[0]?.status, "SEALED");
  });
});

test("the outage streak is shared between the grouped and 10-minute steps", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const log: string[] = [];
    const lastThree = new Set(NOV_DEC.slice(-3));
    const result = await runNovDec(root, store, log, {
      fetchGroupedDaily: async (date) => {
        log.push(`G:${date}`);
        if (lastThree.has(date)) throw new Error("MASSIVE_NETWORK:reset");
        return groupedReply(date);
      },
      fetchPages: async (s) => {
        log.push(`T:${s.symbol}`);
        throw new Error("MASSIVE_HTTP_503:requestId=x:body=down");
      },
    });
    // 3 grouped failures + 2 ten-minute failures = 5 in a row: outage stop.
    assert.ok(result.report.outageStop?.startsWith("MASSIVE_OUTAGE:MASSIVE_HTTP_503"));
    assert.equal(result.report.ranges[0]?.status, "OUTAGE_STOP");
    assert.deepEqual(log.slice(-2), ["T:AAA", "T:BBB"]);
    assert.equal(await store.get(tenMinRangeManifestKey("2024-11-01", "2024-12-31")), undefined);
  });
});

test("grouped-daily Reply Dust over R2 with RFC 2047 HEAD metadata stores, verifies and resumes", async () => {
  const { objects, client } = fakeR2();
  const sessions = NOV_DEC.slice(0, 3);
  let requests = 0;
  const fetchGroupedDaily = async (date: string) => {
    requests += 1;
    return groupedReply(date);
  };
  const first = await storeRangeGroupedDaily({ store: client, provider: PROVIDER, sessions, fetchGroupedDaily, now: () => AT });
  assert.deepEqual([first.requests, first.stored, first.resumed], [3, 3, 0]);
  // Stored raw (/ ? = & in rd-request); the fake returns it encoded on HEAD like R2.
  assert.match(objects.get(dailyReplyDustFileKey(sessions[0]!))!.meta["rd-request"]!, /\?adjusted=false&include_otc=false$/u);
  requests = 0;
  const again = await storeRangeGroupedDaily({ store: client, provider: PROVIDER, sessions, fetchGroupedDaily });
  assert.deepEqual([requests, again.stored, again.resumed], [0, 0, 3]);
});

test("provider getGroupedDailyReply uses the getDailyBars path and params, without the API key", async () => {
  const seen: string[] = [];
  const provider = new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    now: () => AT,
    fetchImpl: async (input) => {
      seen.push(String(input));
      return new Response(new TextDecoder().decode(groupedReply("2024-11-01").body), { status: 200 });
    },
  });
  const reply = await provider.getGroupedDailyReply("2024-11-01");
  assert.equal(reply.request, "/v2/aggs/grouped/locale/us/market/stocks/2024-11-01?adjusted=false&include_otc=false");
  assert.equal(reply.dataset, "stocks-grouped-daily");
  assert.equal(new URL(seen[0]!).pathname, "/v2/aggs/grouped/locale/us/market/stocks/2024-11-01");
  assert.ok(!reply.request.includes("test-key"));
});
