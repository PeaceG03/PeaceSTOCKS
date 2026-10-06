import assert from "node:assert/strict";
import test from "node:test";
import {
  writeDailyReplyDust,
  dailyReplyDustFileKey,
  dailyReplyDustManifestKey,
} from "./daily-reply-dust";
import { securityId } from "./identity";
import { MemoryObjectClient } from "./object-store";
import { serializePicksBaseV1 } from "./tenmin-daily-picks";
import {
  TENMIN_DAILY_BASE_INPUT_FAILED,
  TENMIN_DAILY_BASE_INPUT_MISSING,
  TENMIN_DAILY_MASSIVE_PROVIDER,
  StoreReadIntegrityError,
  TenMinDailyBaseCorruptError,
  TenMinDailyBaseFailedError,
  TenMinDailyBaseInputError,
  buildTenMinDailyPicksBaseFromStored,
  isIntegrityStoreReadError,
  isTransientStoreReadError,
  loadTickerReferenceIndexAsOf,
  mapsFromTickerReferenceEntries,
} from "./tenmin-daily-picks-base";
import {
  TENMIN_DAY_OBJECT_CORRUPT,
  immutableReplyDustStore,
  readTenMinDayPicks,
} from "./tenmin-day-picks";
import { runTenMinDailyPicks } from "./tenmin-daily-runner";
import {
  TICKER_REFERENCE_INDEX_MANIFEST_KEY,
  type TickerReferenceCapture,
  listTickerReferenceIndexHistory,
  loadTickerReferenceIndexFromManifest,
  tickerReferenceEntry,
  writeTickerReferenceIndex,
} from "./ticker-reference-index";
import type { MarketStore } from "./storage";
import type { ProviderRawReply } from "./contracts";

const D = "2024-11-04";
const SETTLED_NOW = new Date("2026-10-06T18:00:00.000Z");
const settledClock = (): Date => SETTLED_NOW;

function memoryStorage(): MarketStore {
  return {
    async initialize() {},
    async loadPredictionStatuses() {
      return [];
    },
  } as unknown as MarketStore;
}

function groupedBody(tickers: string[]): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      status: "OK",
      request_id: `grouped-${D}`,
      results: tickers.map((T) => ({ T, v: 1, o: 1, c: 1, h: 1, l: 1, t: 1 })),
    }),
  );
}

function groupedReply(sessionDate: string, tickers: string[]): ProviderRawReply {
  return {
    dataset: "stocks-grouped-daily",
    sessionDate,
    request: `/v2/aggs/grouped/locale/us/market/stocks/${sessionDate}`,
    fetchedAt: `${sessionDate}T21:00:00.000Z`,
    body: groupedBody(tickers),
  };
}

function capture(rows: Array<{ ticker: string; type: string; active?: boolean }>): TickerReferenceCapture {
  const active: ReturnType<typeof tickerReferenceEntry>[] = [];
  const inactive: ReturnType<typeof tickerReferenceEntry>[] = [];
  for (const row of rows) {
    const raw = JSON.stringify({
      ticker: row.ticker,
      type: row.type,
      active: row.active !== false,
      market: "stocks",
      locale: "us",
      primary_exchange: "XNAS",
    });
    if (row.active === false) {
      inactive.push(tickerReferenceEntry("inactive", 1, inactive.length, raw));
    } else {
      active.push(tickerReferenceEntry("active", 1, active.length, raw));
    }
  }
  return {
    pages: { active: active.length ? 1 : 0, inactive: inactive.length ? 1 : 0 },
    entries: [...active, ...inactive],
  };
}

async function plantGrouped(store: MemoryObjectClient, sessionDate: string, tickers: string[]) {
  await writeDailyReplyDust(store, groupedReply(sessionDate, tickers), {
    provider: "massive-stocks",
    observedAt: `${sessionDate}T21:05:00.000Z`,
  });
}

async function plantIndex(
  store: MemoryObjectClient,
  asOf: string,
  rows: Array<{ ticker: string; type: string; active?: boolean }>,
) {
  return writeTickerReferenceIndex(store, capture(rows), {
    provider: "massive-stocks",
    asOf,
  });
}

const UNIVERSE = [
  { ticker: "SPY", type: "ETF" },
  { ticker: "QQQ", type: "ETF" },
  { ticker: "AAA", type: "CS" },
  { ticker: "BBB", type: "CS" },
  { ticker: "CCC", type: "CS" },
  { ticker: "DDD", type: "CS" },
  { ticker: "EEE", type: "CS" },
  { ticker: "FFF", type: "CS" },
  { ticker: "GGG", type: "CS" },
  { ticker: "HHH", type: "CS" },
  { ticker: "III", type: "CS" },
  { ticker: "JJJ", type: "CS" },
  { ticker: "OLDX", type: "CS", active: false as const }, // delisted, still in index
];

test("buildBase: from fixture grouped + index — SPY/QQQ index, empty holdings, deterministic random", async () => {
  const store = new MemoryObjectClient();
  const tickers = UNIVERSE.map((u) => u.ticker);
  await plantGrouped(store, D, tickers);
  const idx = await plantIndex(store, D, UNIVERSE);

  const base = await buildTenMinDailyPicksBaseFromStored({ store, sessionDate: D });
  assert.equal(base.sessionDate, D);
  assert.equal(base.counts.holding, 0);
  assert.ok(base.counts.index >= 1);
  assert.ok(base.picks.some((p) => p.symbol === "SPY" && p.reason === "index"));
  assert.ok(base.picks.some((p) => p.symbol === "QQQ" && p.reason === "index"));
  assert.ok(base.counts.random > 0);
  assert.ok(base.tickerIndex);
  assert.equal(base.tickerIndex!.asOf, D);
  assert.equal(base.tickerIndex!.sha256, idx.bodySha256);
  assert.equal(base.tickerIndex!.key, TICKER_REFERENCE_INDEX_MANIFEST_KEY);
  assert.equal(base.groupedReply.key, dailyReplyDustFileKey(D));

  // Delisted OLDX can be linked/picked when present in D's index + grouped.
  const oldId = securityId(TENMIN_DAILY_MASSIVE_PROVIDER, "OLDX", "STOCK");
  const maps = mapsFromTickerReferenceEntries(
    (await loadTickerReferenceIndexAsOf(store, D))!.entries,
  );
  assert.equal(maps.tickerTypes.get("OLDX"), "CS");
  assert.equal(maps.tickerToSecurityId.get("OLDX"), oldId);
});

test("buildBase: byte-identical rebuild from same stored inputs", async () => {
  const store = new MemoryObjectClient();
  await plantGrouped(store, D, UNIVERSE.map((u) => u.ticker));
  await plantIndex(store, D, UNIVERSE);
  const a = await buildTenMinDailyPicksBaseFromStored({ store, sessionDate: D });
  const b = await buildTenMinDailyPicksBaseFromStored({ store, sessionDate: D });
  assert.equal(serializePicksBaseV1(a), serializePicksBaseV1(b));
});

test("buildBase: later index (asOf > D) is never used; delisted in D's index remains pickable", async () => {
  const store = new MemoryObjectClient();
  await plantGrouped(store, D, ["SPY", "QQQ", "OLDX", "AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"]);
  // Index as of D includes delisted OLDX, no NEWER ticker.
  await plantIndex(store, D, [
    { ticker: "SPY", type: "ETF" },
    { ticker: "QQQ", type: "ETF" },
    { ticker: "OLDX", type: "CS", active: false },
    { ticker: "AAA", type: "CS" },
    { ticker: "BBB", type: "CS" },
    { ticker: "CCC", type: "CS" },
    { ticker: "DDD", type: "CS" },
    { ticker: "EEE", type: "CS" },
    { ticker: "FFF", type: "CS" },
    { ticker: "GGG", type: "CS" },
    { ticker: "HHH", type: "CS" },
  ]);
  const asOfD = await loadTickerReferenceIndexAsOf(store, D);
  assert.ok(asOfD);
  assert.equal(asOfD!.asOf, D);

  // Later month index adds ZZZ and drops OLDX — must not be used for D.
  await plantIndex(store, "2024-12-02", [
    { ticker: "SPY", type: "ETF" },
    { ticker: "QQQ", type: "ETF" },
    { ticker: "ZZZ", type: "CS" },
    { ticker: "AAA", type: "CS" },
  ]);
  const live = await loadTickerReferenceIndexAsOf(store, "2024-12-02");
  assert.ok(live && live.asOf === "2024-12-02");

  const forD = await loadTickerReferenceIndexAsOf(store, D);
  assert.ok(forD);
  assert.equal(forD!.asOf, D);
  assert.ok(forD!.asOf <= D);
  assert.ok(mapsFromTickerReferenceEntries(forD!.entries).tickerToSecurityId.has("OLDX"));
  assert.ok(!mapsFromTickerReferenceEntries(forD!.entries).tickerToSecurityId.has("ZZZ"));

  const base = await buildTenMinDailyPicksBaseFromStored({ store, sessionDate: D });
  assert.equal(base.tickerIndex!.asOf, D);
  assert.ok(!base.picks.some((p) => p.symbol === "ZZZ"));
  // OLDX may appear as random if selected; at least it is in the candidate mapping.
  assert.ok(base.tickerIndex!.sha256 === forD!.sha256);
});

test("buildBase: missing grouped reply → BASE_INPUT_MISSING", async () => {
  const store = new MemoryObjectClient();
  await plantIndex(store, D, UNIVERSE);
  await assert.rejects(
    () => buildTenMinDailyPicksBaseFromStored({ store, sessionDate: D }),
    (e: unknown) =>
      e instanceof TenMinDailyBaseInputError &&
      e.input === "grouped_reply" &&
      e.message.startsWith(TENMIN_DAILY_BASE_INPUT_MISSING),
  );
});

test("buildBase: missing index as-of ≤ D → BASE_INPUT_MISSING", async () => {
  const store = new MemoryObjectClient();
  await plantGrouped(store, D, ["SPY", "AAA"]);
  // Only a later index exists.
  await plantIndex(store, "2024-12-15", UNIVERSE);
  await assert.rejects(
    () => buildTenMinDailyPicksBaseFromStored({ store, sessionDate: D }),
    (e: unknown) =>
      e instanceof TenMinDailyBaseInputError && e.input === "ticker_index",
  );
});

test("runner: missing grouped → skip reason, continues, next good day seals; no Massive for base", async () => {
  const store = immutableReplyDustStore(new MemoryObjectClient());
  const raw = (store as { get: MemoryObjectClient["get"] }); // use inner via plant on MemoryObjectClient
  void raw;
  const inner = new MemoryObjectClient();
  const dust = immutableReplyDustStore(inner);

  const missingDay = "2024-11-04";
  const goodDay = "2024-11-05";
  // Index covering both days (asOf = goodDay ≥ both for goodDay; for missingDay need asOf ≤ missingDay)
  await plantIndex(inner, missingDay, UNIVERSE);
  await plantGrouped(inner, goodDay, UNIVERSE.map((u) => u.ticker));
  // missingDay: index ok, no grouped

  let tenMinFetches = 0;
  let otherProviderCalls = 0;
  const report = await runTenMinDailyPicks({
    store: dust,
    storage: memoryStorage(),
    days: [missingDay, goodDay],
    env: { TENMIN_DAILY_PICKS: "true" },
    now: SETTLED_NOW,
    clock: settledClock,
    limit: 2,
    // Production buildBase (default) — do not inject buildBase.
    provider: {
      providerName: "massive-stocks",
      async getTenMinuteRangeReplies() {
        tenMinFetches += 1;
        return [
          {
            body: new TextEncoder().encode(
              JSON.stringify({
                ticker: "X",
                results: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1, n: 1 }],
                status: "OK",
                request_id: "r",
              }),
            ),
          },
        ];
      },
      async getGroupedDailyReply() {
        otherProviderCalls += 1;
        throw new Error("SHOULD_NOT_CALL_GROUPED");
      },
      async listApprovedSecurities() {
        otherProviderCalls += 1;
        throw new Error("SHOULD_NOT_LIST");
      },
    } as never,
    fetchReply: async (sec) => {
      tenMinFetches += 1;
      return new TextEncoder().encode(
        JSON.stringify({
          ticker: sec.symbol,
          results: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1, n: 1 }],
          status: "OK",
          request_id: `req-${sec.symbol}`,
        }),
      );
    },
  });

  assert.equal(otherProviderCalls, 0);
  assert.ok(
    report.skippedBaseInput.some(
      (s) => s.sessionDate === missingDay && s.input === "grouped_reply",
    ),
    JSON.stringify(report.skippedBaseInput),
  );
  assert.ok(report.sealed.includes(goodDay));
  assert.ok(!report.sealed.includes(missingDay));
  assert.equal((await readTenMinDayPicks(dust, missingDay)).status, "TENMIN_DAY_NOT_SEALED");
  assert.equal((await readTenMinDayPicks(dust, goodDay)).status, "SEALED");
  assert.ok(tenMinFetches > 0); // 10-minute fetches for good day only
});

test("runner: missing index → skip, next day with index seals", async () => {
  const inner = new MemoryObjectClient();
  const dust = immutableReplyDustStore(inner);
  const d1 = "2024-11-04";
  const d2 = "2024-11-05";
  await plantGrouped(inner, d1, UNIVERSE.map((u) => u.ticker));
  await plantGrouped(inner, d2, UNIVERSE.map((u) => u.ticker));
  // Index only as-of d2 (after d1) — d1 skips; d2 seals.
  await plantIndex(inner, d2, UNIVERSE);

  const report = await runTenMinDailyPicks({
    store: dust,
    storage: memoryStorage(),
    days: [d1, d2],
    env: { TENMIN_DAILY_PICKS: "true" },
    now: SETTLED_NOW,
    clock: settledClock,
    limit: 2,
    fetchReply: async (sec) =>
      new TextEncoder().encode(
        JSON.stringify({
          ticker: sec.symbol,
          results: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1, n: 1 }],
          status: "OK",
          request_id: `req-${sec.symbol}`,
        }),
      ),
  });
  assert.ok(report.skippedBaseInput.some((s) => s.sessionDate === d1 && s.input === "ticker_index"));
  assert.ok(report.sealed.includes(d2));
  assert.equal((await readTenMinDayPicks(dust, d1)).status, "TENMIN_DAY_NOT_SEALED");
});


test("loadTickerReferenceIndexAsOf: newest ≤D broken → CORRUPT; older index never used", async () => {
  const store = new MemoryObjectClient();
  const olderAsOf = "2024-10-15";
  await plantIndex(store, olderAsOf, [
    { ticker: "SPY", type: "ETF" },
    { ticker: "QQQ", type: "ETF" },
    { ticker: "OLDONLY", type: "CS" },
  ]);
  await plantIndex(store, D, UNIVERSE);
  await plantGrouped(store, D, UNIVERSE.map((u) => u.ticker));

  const history = await listTickerReferenceIndexHistory(store);
  assert.ok(history.length >= 2);
  assert.equal(history[0]!.key, TICKER_REFERENCE_INDEX_MANIFEST_KEY);
  assert.equal(history[0]!.manifest!.asOf, D);
  const older = history[1]!;
  assert.ok(older.verified && older.manifest);
  assert.equal(older.manifest!.asOf, olderAsOf);
  const olderLoaded = await loadTickerReferenceIndexFromManifest(store, older.manifest!);
  assert.ok(mapsFromTickerReferenceEntries(olderLoaded.entries).tickerToSecurityId.has("OLDONLY"));

  const baseKey = history[0]!.manifest!.base.key;
  await store.delete(baseKey);

  await assert.rejects(
    () => loadTickerReferenceIndexAsOf(store, D),
    (e: unknown) =>
      e instanceof TenMinDailyBaseCorruptError &&
      e.key === TICKER_REFERENCE_INDEX_MANIFEST_KEY &&
      e.message.startsWith(`${TENMIN_DAY_OBJECT_CORRUPT}:`),
  );

  await assert.rejects(
    () => buildTenMinDailyPicksBaseFromStored({ store, sessionDate: D }),
    (e: unknown) => e instanceof TenMinDailyBaseCorruptError,
  );
});

test("loadTickerReferenceIndexAsOf: transient read on newest ≤D → FAILED; older unused", async () => {
  const inner = new MemoryObjectClient();
  const olderAsOf = "2024-10-15";
  await plantIndex(inner, olderAsOf, [
    { ticker: "SPY", type: "ETF" },
    { ticker: "QQQ", type: "ETF" },
    { ticker: "OLDONLY", type: "CS" },
  ]);
  await plantIndex(inner, D, UNIVERSE);
  await plantGrouped(inner, D, UNIVERSE.map((u) => u.ticker));

  const history = await listTickerReferenceIndexHistory(inner);
  const baseKey = history[0]!.manifest!.base.key;
  const olderManifest = history[1]!.manifest!;
  assert.ok(olderManifest);

  const flaky = {
    async get(key: string) {
      if (key === baseKey) throw new Error("ETIMEDOUT");
      return inner.get(key);
    },
    async put(key: string, body: Uint8Array, metadata?: object) {
      return inner.put(key, body, metadata as never);
    },
    async head(key: string) {
      return inner.head(key);
    },
    async delete(key: string) {
      return inner.delete(key);
    },
    async list(prefix: string) {
      return inner.list(prefix);
    },
  };

  await assert.rejects(
    () => loadTickerReferenceIndexAsOf(flaky, D),
    (e: unknown) =>
      e instanceof TenMinDailyBaseFailedError &&
      e.key === TICKER_REFERENCE_INDEX_MANIFEST_KEY &&
      e.message.startsWith(`${TENMIN_DAILY_BASE_INPUT_FAILED}:`) &&
      e.message.includes("ETIMEDOUT"),
  );

  const olderLoaded = await loadTickerReferenceIndexFromManifest(inner, olderManifest);
  assert.ok(mapsFromTickerReferenceEntries(olderLoaded.entries).tickerToSecurityId.has("OLDONLY"));

  await assert.rejects(
    () => buildTenMinDailyPicksBaseFromStored({ store: flaky as never, sessionDate: D }),
    (e: unknown) => e instanceof TenMinDailyBaseFailedError,
  );
});

test("buildBase: present grouped manifest checksum mismatch → CORRUPT with key (not MISSING)", async () => {
  const store = new MemoryObjectClient();
  await plantGrouped(store, D, UNIVERSE.map((u) => u.ticker));
  await plantIndex(store, D, UNIVERSE);
  const manifestKey = dailyReplyDustManifestKey(D);
  const good = await store.get(manifestKey);
  assert.ok(good);
  const parsed = JSON.parse(new TextDecoder().decode(good!)) as Record<string, unknown>;
  parsed.checksum = "0".repeat(64);
  await store.put(manifestKey, new TextEncoder().encode(JSON.stringify(parsed)));

  await assert.rejects(
    () => buildTenMinDailyPicksBaseFromStored({ store, sessionDate: D }),
    (e: unknown) =>
      e instanceof TenMinDailyBaseCorruptError &&
      e.key === manifestKey &&
      e.message.startsWith(`${TENMIN_DAY_OBJECT_CORRUPT}:`),
  );
});

test("buildBase: present .rdust checksum mismatch → CORRUPT with file key (not MISSING)", async () => {
  const store = new MemoryObjectClient();
  await plantGrouped(store, D, UNIVERSE.map((u) => u.ticker));
  await plantIndex(store, D, UNIVERSE);
  const fileKey = dailyReplyDustFileKey(D);
  const good = await store.get(fileKey);
  assert.ok(good && good.length > 4);
  const bad = new Uint8Array(good!);
  const last = bad.length - 1;
  bad[last] = (bad[last] ?? 0) ^ 0xff;
  await store.put(fileKey, bad);

  await assert.rejects(
    () => buildTenMinDailyPicksBaseFromStored({ store, sessionDate: D }),
    (e: unknown) =>
      e instanceof TenMinDailyBaseCorruptError &&
      e.key === fileKey &&
      e.message.startsWith(`${TENMIN_DAY_OBJECT_CORRUPT}:`),
  );
});

test("runner: newest ≤D index CORRUPT → unsealed + reported; next good day seals", async () => {
  const inner = new MemoryObjectClient();
  const dust = immutableReplyDustStore(inner);
  const badDay = "2024-11-04";
  const goodDay = "2024-11-05";
  await plantIndex(inner, "2024-10-15", UNIVERSE);
  await plantIndex(inner, badDay, UNIVERSE);
  await plantGrouped(inner, badDay, UNIVERSE.map((u) => u.ticker));
  await plantGrouped(inner, goodDay, UNIVERSE.map((u) => u.ticker));

  const history = await listTickerReferenceIndexHistory(inner);
  const brokenBaseKey = history[0]!.manifest!.base.key;
  assert.equal(history[0]!.manifest!.asOf, badDay);

  // Proxy: fail rebuild of the badDay live base body; allow everything else (incl. after we add goodDay index).
  // First run path: for badDay, history live=badDay → get(brokenBaseKey) throws non-transient → CORRUPT.
  // Then plant goodDay index onto real inner before runner... we need broken only while live asOf is badDay.
  // Approach: delete broken base on inner, then plantIndex(goodDay) which archives unreadable live as unverified
  // and writes new live asOf=goodDay. For badDay: skip goodDay, hit unverified → CORRUPT.
  await inner.delete(brokenBaseKey);
  await plantIndex(inner, goodDay, UNIVERSE);

  const report = await runTenMinDailyPicks({
    store: dust,
    storage: memoryStorage(),
    days: [badDay, goodDay],
    env: { TENMIN_DAILY_PICKS: "true" },
    now: SETTLED_NOW,
    clock: settledClock,
    limit: 2,
    fetchReply: async (sec) =>
      new TextEncoder().encode(
        JSON.stringify({
          ticker: sec.symbol,
          results: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1, n: 1 }],
          status: "OK",
          request_id: `req-${sec.symbol}`,
        }),
      ),
  });

  assert.ok(
    report.corrupt.some((c) => c.sessionDate === badDay),
    JSON.stringify(report),
  );
  assert.ok(!report.sealed.includes(badDay));
  assert.equal((await readTenMinDayPicks(dust, badDay)).status, "TENMIN_DAY_NOT_SEALED");
  assert.ok(report.sealed.includes(goodDay), JSON.stringify(report));
  assert.equal((await readTenMinDayPicks(dust, goodDay)).status, "SEALED");
});

test("runner: grouped present-but-corrupt → CORRUPT (not SKIPPED_BASE_INPUT); next day seals", async () => {
  const inner = new MemoryObjectClient();
  const dust = immutableReplyDustStore(inner);
  const badDay = "2024-11-04";
  const goodDay = "2024-11-05";
  await plantIndex(inner, badDay, UNIVERSE);
  await plantGrouped(inner, badDay, UNIVERSE.map((u) => u.ticker));
  await plantGrouped(inner, goodDay, UNIVERSE.map((u) => u.ticker));

  const manifestKey = dailyReplyDustManifestKey(badDay);
  const good = await inner.get(manifestKey);
  assert.ok(good);
  const parsed = JSON.parse(new TextDecoder().decode(good!)) as Record<string, unknown>;
  parsed.checksum = "a".repeat(64);
  await inner.put(manifestKey, new TextEncoder().encode(JSON.stringify(parsed)));

  const report = await runTenMinDailyPicks({
    store: dust,
    storage: memoryStorage(),
    days: [badDay, goodDay],
    env: { TENMIN_DAILY_PICKS: "true" },
    now: SETTLED_NOW,
    clock: settledClock,
    limit: 2,
    fetchReply: async (sec) =>
      new TextEncoder().encode(
        JSON.stringify({
          ticker: sec.symbol,
          results: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1, n: 1 }],
          status: "OK",
          request_id: `req-${sec.symbol}`,
        }),
      ),
  });

  assert.ok(
    report.corrupt.some((c) => c.sessionDate === badDay && c.key === manifestKey),
    JSON.stringify(report.corrupt),
  );
  assert.ok(!report.skippedBaseInput.some((s) => s.sessionDate === badDay));
  assert.ok(report.sealed.includes(goodDay));
  assert.equal((await readTenMinDayPicks(dust, badDay)).status, "TENMIN_DAY_NOT_SEALED");
});

test("buildBase: groupedWithoutIndexEntry counts tickers absent from asOf≤D index", async () => {
  const store = new MemoryObjectClient();
  // Index includes SPY/QQQ/AAA and a non-CS/ETF WARRANT so it is "in index" but not linkable.
  await plantIndex(store, D, [
    { ticker: "SPY", type: "ETF" },
    { ticker: "QQQ", type: "ETF" },
    { ticker: "AAA", type: "CS" },
    { ticker: "BBB", type: "CS" },
    { ticker: "CCC", type: "CS" },
    { ticker: "DDD", type: "CS" },
    { ticker: "EEE", type: "CS" },
    { ticker: "FFF", type: "CS" },
    { ticker: "GGG", type: "CS" },
    { ticker: "HHH", type: "CS" },
    { ticker: "III", type: "CS" },
    { ticker: "JJJ", type: "CS" },
    { ticker: "WRNT", type: "WARRANT" },
  ]);
  // Grouped has WRNT (in index), MISS (not in index), and the CS/ETF names.
  await plantGrouped(store, D, [
    "SPY", "QQQ", "AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH", "III", "JJJ",
    "WRNT", "MISS", "MISS",
  ]);
  const base = await buildTenMinDailyPicksBaseFromStored({ store, sessionDate: D });
  assert.ok(base.groupedWithoutIndexEntry);
  assert.equal(base.groupedWithoutIndexEntry!.count, 1);
  assert.deepEqual(base.groupedWithoutIndexEntry!.sample, ["MISS"]);
  // WRNT is unlinkedExcluded (wrong type) but NOT in groupedWithoutIndexEntry.
  assert.ok(base.counts.unlinkedExcluded >= 1);
});

test("runner: no ticker index at all → every settled day SKIPPED_BASE_INPUT, zero Massive requests", async () => {
  const inner = new MemoryObjectClient();
  const dust = immutableReplyDustStore(inner);
  const days = ["2024-11-04", "2024-11-05", "2024-11-06"];
  for (const d of days) {
    await plantGrouped(inner, d, UNIVERSE.map((u) => u.ticker));
  }
  // Intentionally no plantIndex — production state before dated indexes seal.

  let providerCalls = 0;
  let fetchCalls = 0;
  const report = await runTenMinDailyPicks({
    store: dust,
    storage: memoryStorage(),
    days,
    env: { TENMIN_DAILY_PICKS: "true" },
    now: SETTLED_NOW,
    clock: settledClock,
    limit: 5,
    provider: {
      providerName: "massive-stocks",
      async getTenMinuteRangeReplies() {
        providerCalls += 1;
        throw new Error("SHOULD_NOT_FETCH_TENMIN");
      },
      async getGroupedDailyReply() {
        providerCalls += 1;
        throw new Error("SHOULD_NOT_CALL_GROUPED");
      },
      async listApprovedSecurities() {
        providerCalls += 1;
        throw new Error("SHOULD_NOT_LIST");
      },
    } as never,
    fetchReply: async () => {
      fetchCalls += 1;
      throw new Error("SHOULD_NOT_FETCH_REPLY");
    },
  });

  assert.equal(providerCalls, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(report.totalRequests, 0);
  assert.equal(report.sealed.length, 0);
  assert.equal(report.days.length, days.length);
  for (const d of days) {
    assert.ok(
      report.skippedBaseInput.some((s) => s.sessionDate === d && s.input === "ticker_index"),
      `expected ticker_index skip for ${d}: ${JSON.stringify(report.skippedBaseInput)}`,
    );
    const day = report.days.find((x) => x.sessionDate === d);
    assert.equal(day?.outcome, "SKIPPED_BASE_INPUT");
    assert.equal(day?.requests, 0);
    assert.equal((await readTenMinDayPicks(dust, d)).status, "TENMIN_DAY_NOT_SEALED");
  }
});

test("isTransientStoreReadError: inverted — only clear integrity is non-transient", () => {
  // Auditor cases: R2_ + timeout → FAILED (transient); integrity-in-cause → CORRUPT;
  // status 500 → FAILED; plain unknown → FAILED.
  const r2Timeout = new Error("R2_GET timed out waiting for upstream");
  assert.equal(isTransientStoreReadError(r2Timeout), true);
  assert.equal(isIntegrityStoreReadError(r2Timeout), false);

  const wrappedChecksum = new Error("store get failed", {
    cause: new Error("REPLY_DUST_MANIFEST_CHECKSUM_MISMATCH"),
  });
  assert.equal(isIntegrityStoreReadError(wrappedChecksum), true);
  assert.equal(isTransientStoreReadError(wrappedChecksum), false);

  const typedWrapped = new Error("wrapper", {
    cause: new StoreReadIntegrityError("REPLY_DUST_FILE_CHECKSUM_MISMATCH"),
  });
  assert.equal(isIntegrityStoreReadError(typedWrapped), true);

  const status500 = Object.assign(new Error("upstream"), { status: 500 });
  assert.equal(isTransientStoreReadError(status500), true);
  assert.equal(isIntegrityStoreReadError(status500), false);

  assert.equal(isTransientStoreReadError(new Error("something")), true);
  assert.equal(isIntegrityStoreReadError(new Error("something")), false);

  // Transient table (must be true / not integrity).
  const transientCases: unknown[] = [
    new Error("R2_GET_500"),
    new Error("R2_HEAD_503"),
    new Error("R2_GET_429"),
    new Error("SlowDown"),
    new Error("ETIMEDOUT"),
    Object.assign(new Error("aborted"), { name: "AbortError" }),
    Object.assign(new Error("reset"), { code: "ECONNRESET" }),
    new Error("fetch failed"),
    Object.assign(new Error("connect"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    new Error("R2_LIST_TRUNCATED_WITHOUT_TOKEN"),
    new Error("R2_CONFIG_REQUIRED"),
  ];
  for (const err of transientCases) {
    assert.equal(
      isTransientStoreReadError(err),
      true,
      `expected transient: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Integrity table (must be false for transient / true for integrity).
  const integrityCases: unknown[] = [
    new Error("REPLY_DUST_MANIFEST_CHECKSUM_MISMATCH"),
    new Error("REPLY_DUST_FILE_CHECKSUM_MISMATCH:grouped-daily:2024-11-04"),
    new Error("REPLY_DUST_VERSION_UNSUPPORTED:99"),
    new Error("REPLY_DUST_ZSTD_FAILED"),
    new Error("TICKER_REFERENCE_INDEX_BODY_MISMATCH:base"),
    new Error("TICKER_REFERENCE_INDEX_FILE_MISMATCH:permanent/x"),
    new Error("TICKER_REFERENCE_INDEX_ARCHIVE_SHA_MISMATCH:permanent/y"),
    new Error("TICKER_REFERENCE_INDEX_MANIFEST_INVALID"),
    new SyntaxError("Unexpected token } in JSON at position 0"),
    new StoreReadIntegrityError("REPLY_DUST_HASH_MISMATCH"),
    // R2-prefixed wrapper must not hide integrity in cause:
    new Error("R2_GET_200 body invalid", {
      cause: new Error("TICKER_REFERENCE_INDEX_BODY_MISMATCH"),
    }),
  ];
  for (const err of integrityCases) {
    assert.equal(
      isIntegrityStoreReadError(err),
      true,
      `expected integrity: ${err instanceof Error ? err.message : String(err)}`,
    );
    assert.equal(isTransientStoreReadError(err), false);
  }
});

test("buildBase: R2 5xx on ticker index read → FAILED; unknown → FAILED; checksum → CORRUPT", async () => {
  const inner = new MemoryObjectClient();
  await plantIndex(inner, D, UNIVERSE);
  await plantGrouped(inner, D, UNIVERSE.map((u) => u.ticker));

  const history = await listTickerReferenceIndexHistory(inner);
  const baseKey = history[0]!.manifest!.base.key;

  const flaky5xx = {
    async get(key: string) {
      if (key === baseKey) throw new Error("R2_GET_503");
      return inner.get(key);
    },
    async put(key: string, body: Uint8Array, metadata?: object) {
      return inner.put(key, body, metadata as never);
    },
    async head(key: string) {
      return inner.head(key);
    },
    async delete(key: string) {
      return inner.delete(key);
    },
    async list(prefix: string) {
      return inner.list(prefix);
    },
  };

  await assert.rejects(
    () => buildTenMinDailyPicksBaseFromStored({ store: flaky5xx as never, sessionDate: D }),
    (e: unknown) =>
      e instanceof TenMinDailyBaseFailedError &&
      e.message.includes("R2_GET_503"),
  );

  const flakyUnknown = {
    ...flaky5xx,
    async get(key: string) {
      if (key === baseKey) throw new Error("something");
      return inner.get(key);
    },
  };
  await assert.rejects(
    () => buildTenMinDailyPicksBaseFromStored({ store: flakyUnknown as never, sessionDate: D }),
    (e: unknown) =>
      e instanceof TenMinDailyBaseFailedError && e.message.includes("something"),
  );

  // Integrity via cause still CORRUPT even when outer message looks like R2_.
  const flakyIntegrity = {
    ...flaky5xx,
    async get(key: string) {
      if (key === baseKey) {
        throw new Error("R2_GET failed", {
          cause: new Error("TICKER_REFERENCE_INDEX_FILE_MISMATCH:" + baseKey),
        });
      }
      return inner.get(key);
    },
  };
  await assert.rejects(
    () => buildTenMinDailyPicksBaseFromStored({ store: flakyIntegrity as never, sessionDate: D }),
    (e: unknown) => e instanceof TenMinDailyBaseCorruptError,
  );
});

test("runner: R2 5xx on grouped reply → FAILED; checksum mismatch → CORRUPT; unknown → FAILED", async () => {
  const inner = new MemoryObjectClient();
  const dust = immutableReplyDustStore(inner);
  const day5xx = "2024-11-04";
  const dayCorrupt = "2024-11-05";
  const dayUnknown = "2024-11-06";
  const dayOk = "2024-11-07";

  for (const d of [day5xx, dayCorrupt, dayUnknown, dayOk]) {
    await plantIndex(inner, d, UNIVERSE);
    await plantGrouped(inner, d, UNIVERSE.map((u) => u.ticker));
  }

  const file5xx = dailyReplyDustFileKey(day5xx);
  const manifestCorrupt = dailyReplyDustManifestKey(dayCorrupt);
  const fileUnknown = dailyReplyDustFileKey(dayUnknown);

  const goodCorrupt = await inner.get(manifestCorrupt);
  assert.ok(goodCorrupt);
  const parsed = JSON.parse(new TextDecoder().decode(goodCorrupt!)) as Record<string, unknown>;
  parsed.checksum = "b".repeat(64);
  await inner.put(manifestCorrupt, new TextEncoder().encode(JSON.stringify(parsed)));

  const proxy = {
    async get(key: string) {
      if (key === file5xx) throw new Error("R2_GET_500");
      if (key === fileUnknown) throw new Error("something");
      return inner.get(key);
    },
    async put(key: string, body: Uint8Array, metadata?: object) {
      return inner.put(key, body, metadata as never);
    },
    async head(key: string) {
      return inner.head(key);
    },
    async delete(key: string) {
      return inner.delete(key);
    },
    async list(prefix: string) {
      return inner.list(prefix);
    },
  };
  const store = immutableReplyDustStore(proxy as never);

  const report = await runTenMinDailyPicks({
    store,
    storage: memoryStorage(),
    days: [day5xx, dayCorrupt, dayUnknown, dayOk],
    env: { TENMIN_DAILY_PICKS: "true" },
    now: SETTLED_NOW,
    clock: settledClock,
    limit: 4,
    fetchReply: async (sec) =>
      new TextEncoder().encode(
        JSON.stringify({
          ticker: sec.symbol,
          results: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1, n: 1 }],
          status: "OK",
          request_id: `req-${sec.symbol}`,
        }),
      ),
  });

  const outcome = (d: string) => report.days.find((x) => x.sessionDate === d)?.outcome;
  assert.equal(outcome(day5xx), "FAILED", JSON.stringify(report.days));
  assert.equal(outcome(dayCorrupt), "CORRUPT", JSON.stringify(report.days));
  assert.equal(outcome(dayUnknown), "FAILED", JSON.stringify(report.days));
  assert.ok(report.sealed.includes(dayOk), JSON.stringify(report));
  assert.ok(
    report.corrupt.some((c) => c.sessionDate === dayCorrupt && c.key === manifestCorrupt),
  );
});

