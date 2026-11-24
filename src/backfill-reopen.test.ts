import assert from "node:assert/strict";
import test from "node:test";
import { runBackfillJob, type BackfillJobOptions } from "./backfill-job";
import { dailyBarsSidecarFileKey, maybeWriteScanDailyBarsSidecar } from "./daily-bars-sidecar";
import { dailyReplyDustFileKey, writeDailyReplyDust } from "./daily-reply-dust";
import { FAKE_MASSIVE_BASE_URL, fakeMassive, type FakeMassiveOptions } from "./fake-massive";
import { securityId } from "./identity";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { MassiveMarketProvider } from "./massive-provider";
import { refreshUniverse } from "./universe";

const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";
const DAYS = ["2026-01-20", "2026-01-21", "2026-01-22", "2026-01-23"];
const ACTIVE_FIGI = "FIGI00000AAA";
const INACTIVE_FIGI = "FIGI0000GONE";
const ACTIVE_ID = securityId("massive-stocks", ACTIVE_FIGI, "STOCK");
const INACTIVE_ID = securityId("massive-stocks", INACTIVE_FIGI, "STOCK");

const TICKERS = [
  { ticker: "AAA", figi: ACTIVE_FIGI, type: "CS" as const, active: true },
  { ticker: "GONE", figi: INACTIVE_FIGI, type: "CS" as const, active: false, delistedDate: "2026-01-25" },
];

const GROUPED = () => [
  { T: "AAA", o: 10, h: 11, l: 9, c: 10.5, v: 1000 },
  { T: "GONE", o: 5, h: 5.5, l: 4.5, c: 4.8, v: 500 },
];

function makeFake(extra: Partial<FakeMassiveOptions> = {}) {
  const base = fakeMassive({ tickers: TICKERS, grouped: GROUPED, ...extra });
  const splitCalls: string[] = [];
  const divCalls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/stocks/v1/splits") {
      const d = url.searchParams.get("execution_date") ?? "";
      splitCalls.push(d);
      return new Response(
        JSON.stringify({
          status: "OK",
          results: [
            { id: `split-aaa-${d}`, ticker: "AAA", execution_date: d, split_from: 1, split_to: 2, adjustment_type: "split" },
            { id: `split-gone-${d}`, ticker: "GONE", execution_date: d, split_from: 10, split_to: 1, adjustment_type: "reverse_split" },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.pathname === "/stocks/v1/dividends") {
      const d = url.searchParams.get("ex_dividend_date") ?? "";
      divCalls.push(d);
      return new Response(
        JSON.stringify({
          status: "OK",
          results: [{ id: `div-gone-${d}`, ticker: "GONE", ex_dividend_date: d, cash_amount: 0.25 }],
        }),
        { status: 200 },
      );
    }
    return base.fetchImpl(input, init);
  };
  return { ...base, fetchImpl, splitCalls, divCalls };
}

async function seedStore(options: { withReplyDust: boolean; withPack?: boolean; days?: string[]; seedMemberIds?: string[] }) {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const fake = makeFake();
  const days = options.days ?? [DAYS[0]!];
  const seedIds = options.seedMemberIds ?? [ACTIVE_ID];
  const { MassiveMarketProvider } = await import("./massive-provider");
  const provider = new MassiveMarketProvider({
    apiKey: "fake-key-not-real",
    baseUrl: FAKE_MASSIVE_BASE_URL,
    fetchImpl: fake.fetchImpl,
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    keepRawReplies: true,
    now: () => "2026-01-25T00:00:00.000Z",
  });
  await refreshUniverse(provider, storage, days.at(-1)!);
  const securities = await storage.loadSecurities();
  for (const d of days) {
    const bars = await provider.getDailyBars(d, seedIds);
    const replies = provider.takeRawReplies();
    if (options.withReplyDust && replies[0]) {
      await writeDailyReplyDust(client, replies[0], { provider: provider.providerName, observedAt: bars[0]!.observedAt });
    }
    await storage.appendBars(bars);
    const actions = await provider.getCorporateActions(d, seedIds);
    await storage.appendActions(actions);
    if (options.withPack !== false) {
      const pack = await maybeWriteScanDailyBarsSidecar({
        enabled: true,
        store: client,
        sessionDate: d,
        bars,
        securities,
        zstdVersionProbe: pinnedZstd,
      });
      assert.equal(pack.failure, undefined);
    }
  }
  await storage.saveBackfillProgress({
    schemaVersion: "markets-scanner-backfill-v1",
    provider: "massive-stocks",
    from: days[0]!,
    to: days.at(-1)!,
    completedSessions: [...days],
    failedSessions: {},
    updatedAt: "2026-01-25T00:00:00.000Z",
  });
  return { client, storage };
}

function jobOpts(
  client: MemoryObjectClient,
  storage: ObjectMarketStorage,
  fake: ReturnType<typeof makeFake>,
  from: string,
  to: string,
  extra: Partial<BackfillJobOptions> = {},
): BackfillJobOptions {
  let now = Date.parse("2026-11-24T12:00:00Z");
  return {
    from,
    to,
    storage,
    store: client,
    fetchImpl: fake.fetchImpl,
    apiKey: "fake-key-not-real",
    baseUrl: FAKE_MASSIVE_BASE_URL,
    minRequestIntervalMs: 0,
    clock: () => now,
    sleep: async (ms) => {
      await new Promise((r) => setImmediate(r));
      now += ms;
    },
    now: () => new Date(now).toISOString(),
    zstdVersionProbe: pinnedZstd,
    ...extra,
  };
}

test("default-off: stored ACTIVE-only session is skipped and INACTIVE bars stay missing", async () => {
  const { client, storage } = await seedStore({ withReplyDust: true });
  const fake = makeFake();
  const report = await runBackfillJob(jobOpts(client, storage, fake, DAYS[0]!, DAYS[0]!));
  assert.equal(report.status, "COMPLETE");
  assert.deepEqual(fake.calls.grouped, []);
  assert.equal(fake.splitCalls.length, 0);
  const bars = await storage.loadBars(DAYS[0]!);
  assert.deepEqual(bars.map((b) => b.securityId), [ACTIVE_ID]);
});

test("reopenInactiveTails with cached Reply Dust adds INACTIVE bars & actions, preserves existing lines & sealed pack, 0 grouped calls", async () => {
  const { client, storage } = await seedStore({ withReplyDust: true });
  const monthKey = "permanent/daily-bars/2026-01.jsonl";
  const priorLine = new TextDecoder().decode((await client.get(monthKey))!).trim();
  const packBefore = Buffer.from((await client.get(dailyBarsSidecarFileKey(DAYS[0]!)))!).toString("base64");
  const fake = makeFake();
  const report = await runBackfillJob(
    jobOpts(client, storage, fake, DAYS[0]!, DAYS[0]!, { reopenInactiveTails: true } as Partial<BackfillJobOptions>),
  );
  assert.equal(report.status, "COMPLETE");
  assert.deepEqual(fake.calls.grouped, [], "reuses stored Reply Dust without grouped-daily fetch");
  assert.deepEqual(fake.splitCalls, [DAYS[0]!], "fetches splits for memberIds");
  assert.deepEqual(fake.divCalls, [DAYS[0]!], "fetches dividends for memberIds");
  const bars = await storage.loadBars(DAYS[0]!);
  assert.deepEqual(bars.map((b) => b.securityId).sort(), [ACTIVE_ID, INACTIVE_ID].sort());
  const monthLines = new TextDecoder().decode((await client.get(monthKey))!).split("\n").filter(Boolean);
  assert.ok(monthLines.includes(priorLine), "existing month line preserved byte-for-byte");
  assert.equal(Buffer.from((await client.get(dailyBarsSidecarFileKey(DAYS[0]!)))!).toString("base64"), packBefore);
  assert.deepEqual(report.rowsOutsidePack, { [DAYS[0]!]: 1 });
  assert.equal(report.barRows, report.distinctBarKeys);
  const actionIds = new Set((await storage.loadSplitActions()).map((a) => a.actionId));
  assert.ok(actionIds.has(`split-gone-${DAYS[0]!}`), "INACTIVE reverse split captured");
});

test("reopenInactiveTails without Reply Dust fetches grouped daily once, writes Dust, adds INACTIVE bars, keeps sealed pack", async () => {
  const { client, storage } = await seedStore({ withReplyDust: false });
  const packBefore = Buffer.from((await client.get(dailyBarsSidecarFileKey(DAYS[0]!)))!).toString("base64");
  const fake = makeFake();
  const report = await runBackfillJob(
    jobOpts(client, storage, fake, DAYS[0]!, DAYS[0]!, { reopenInactiveTails: true } as Partial<BackfillJobOptions>),
  );
  assert.equal(report.status, "COMPLETE");
  assert.deepEqual(fake.calls.grouped, [DAYS[0]!]);
  assert.ok(await client.get(dailyReplyDustFileKey(DAYS[0]!)));
  const bars = await storage.loadBars(DAYS[0]!);
  assert.deepEqual(bars.map((b) => b.securityId).sort(), [ACTIVE_ID, INACTIVE_ID].sort());
  assert.equal(Buffer.from((await client.get(dailyBarsSidecarFileKey(DAYS[0]!)))!).toString("base64"), packBefore);
  assert.deepEqual(report.rowsOutsidePack, { [DAYS[0]!]: 1 });
  const secondFake = makeFake();
  const second = await runBackfillJob(
    jobOpts(client, storage, secondFake, DAYS[0]!, DAYS[0]!, { reopenInactiveTails: true } as Partial<BackfillJobOptions>),
  );
  assert.equal(second.status, "COMPLETE");
  assert.equal(second.requests, 0);
});

test("pre-write checkSealedDailyBarsPack refuses tampered pack before touching month file", async () => {
  const { client, storage } = await seedStore({ withReplyDust: true });
  const monthKey = "permanent/daily-bars/2026-01.jsonl";
  const monthBefore = Buffer.from((await client.get(monthKey))!).toString("base64");
  const packKey = dailyBarsSidecarFileKey(DAYS[0]!);
  const bad = Uint8Array.from((await client.get(packKey))!);
  bad.set([bad.at(-1)! ^ 0xff], bad.length - 1);
  await client.put(packKey, bad);
  const fake = makeFake();
  const refused = await runBackfillJob(
    jobOpts(client, storage, fake, DAYS[0]!, DAYS[0]!, { reopenInactiveTails: true } as Partial<BackfillJobOptions>),
  );
  assert.equal(refused.status, "REFUSED_SHA_MISMATCH");
  assert.deepEqual(refused.shaMismatches, [DAYS[0]!]);
  assert.deepEqual(fake.calls.grouped, []);
  assert.equal(fake.splitCalls.length, 0);
  assert.equal(Buffer.from((await client.get(monthKey))!).toString("base64"), monthBefore);
});

test("pre-write checkSealedDailyBarsPack refuses PACKED_ROW_NOT_STORED conflict before touching month file", async () => {
  const { client, storage } = await seedStore({ withReplyDust: true });
  const monthKey = "permanent/daily-bars/2026-01.jsonl";
  // Remove the stored bar from month file while keeping the sealed pack expecting it.
  await client.put(monthKey, new Uint8Array(0));
  const fake = makeFake();
  const refused = await runBackfillJob(
    jobOpts(client, storage, fake, DAYS[0]!, DAYS[0]!, { reopenInactiveTails: true } as Partial<BackfillJobOptions>),
  );
  assert.equal(refused.status, "REFUSED_PACK_CONFLICT");
  assert.deepEqual(refused.packConflicts, [DAYS[0]!]);
  assert.deepEqual(fake.calls.grouped, []);
  assert.equal(fake.splitCalls.length, 0);
  assert.equal((await client.get(monthKey))!.byteLength, 0);
});

test("no-op when 0 new bar keys exist: month file is not rewritten", async () => {
  const { client, storage } = await seedStore({ withReplyDust: true, seedMemberIds: [ACTIVE_ID, INACTIVE_ID] });
  const monthKey = "permanent/daily-bars/2026-01.jsonl";
  let monthWrites = 0;
  const origPut = client.put.bind(client);
  const origPutIfMatch = client.putIfMatch.bind(client);
  client.put = async (k, b, m) => {
    if (k === monthKey) monthWrites += 1;
    return origPut(k, b, m);
  };
  client.putIfMatch = async (k, b, e) => {
    if (k === monthKey) monthWrites += 1;
    return origPutIfMatch(k, b, e);
  };
  const fake = makeFake();
  const report = await runBackfillJob(
    jobOpts(client, storage, fake, DAYS[0]!, DAYS[0]!, { reopenInactiveTails: true } as Partial<BackfillJobOptions>),
  );
  assert.equal(report.status, "COMPLETE");
  assert.equal(monthWrites, 0);
  assert.deepEqual(fake.splitCalls, [DAYS[0]!]);
});

test("multi-chunk resume via backfill-reopen-state.json skips finished chunk before refreshUniverse and caps Dust-cached sessions", async () => {
  const { client, storage } = await seedStore({ withReplyDust: true, days: DAYS });
  const fake1 = makeFake();
  let reopened = 0;
  const max3Yield = async () => (reopened >= 3 ? "JOB_MAX_SESSIONS_REACHED" : undefined);
  const c1 = await runBackfillJob(
    jobOpts(client, storage, fake1, DAYS[0]!, DAYS[1]!, {
      reopenInactiveTails: true,
      maxSessions: 3,
      shouldYield: max3Yield,
      onSessionAttempt: () => { reopened += 1; },
    } as Partial<BackfillJobOptions>),
  );
  assert.equal(c1.status, "COMPLETE");
  assert.equal(reopened, 2);
  const c2 = await runBackfillJob(
    jobOpts(client, storage, fake1, DAYS[2]!, DAYS[3]!, {
      reopenInactiveTails: true,
      maxSessions: 3 - reopened,
      shouldYield: max3Yield,
      onSessionAttempt: () => { reopened += 1; },
    } as Partial<BackfillJobOptions>),
  );
  assert.equal(c2.status, "STOPPED_RESUMABLE");
  assert.equal(c2.stopReason, "MAX_SESSIONS");
  assert.equal(reopened, 3);
  const fake2 = makeFake();
  let reopened2 = 0;
  const r1 = await runBackfillJob(
    jobOpts(client, storage, fake2, DAYS[0]!, DAYS[1]!, {
      reopenInactiveTails: true,
      maxSessions: 3,
      onSessionAttempt: () => { reopened2 += 1; },
    } as Partial<BackfillJobOptions>),
  );
  assert.equal(r1.status, "COMPLETE");
  assert.equal(r1.requests, 0, "finished chunk skips refreshUniverse");
  const r2 = await runBackfillJob(
    jobOpts(client, storage, fake2, DAYS[2]!, DAYS[3]!, {
      reopenInactiveTails: true,
      maxSessions: 3,
      onSessionAttempt: () => { reopened2 += 1; },
    } as Partial<BackfillJobOptions>),
  );
  assert.equal(r2.status, "COMPLETE");
  assert.equal(reopened2, 1);
  for (const d of DAYS) {
    assert.deepEqual((await storage.loadBars(d)).map((b) => b.securityId).sort(), [ACTIVE_ID, INACTIVE_ID].sort());
  }
});

async function seedRawDustAndBars(options: {
  client: MemoryObjectClient;
  storage: ObjectMarketStorage;
  day: string;
  tickers: Array<{ ticker: string; figi: string; active: boolean; delistedDate?: string }>;
  seedBarsForIds: string[];
  groupedTickers: string[];
}) {
  const grouped = () => options.groupedTickers.map((T) => ({ T, o: 10, h: 11, l: 9, c: 10.5, v: 1000 }));
  const fake = fakeMassive({ tickers: options.tickers, grouped });
  const provider = new MassiveMarketProvider({
    apiKey: "fake-key-not-real",
    baseUrl: FAKE_MASSIVE_BASE_URL,
    fetchImpl: fake.fetchImpl,
    minRequestIntervalMs: 0,
    retryBackoffMs: 0,
    keepRawReplies: true,
    now: () => "2026-01-21T00:00:00.000Z",
  });
  const securities = await options.storage.loadSecurities();
  const records = securities.map((s) => ({
    provider: "massive-stocks",
    providerSecurityId: s.providerIdentities[0]!.providerSecurityId,
    symbol: s.currentSymbol,
    assetType: s.assetType,
    country: s.country,
    exchange: s.exchange,
    active: s.status === "ACTIVE",
    tradable: s.tradable,
  }));
  (provider as unknown as { bindUniverse: (r: unknown[]) => void }).bindUniverse(records);
  const bars = await provider.getDailyBars(options.day, options.seedBarsForIds);
  const raw = provider.takeRawReplies()[0]!;
  await writeDailyReplyDust(options.client, raw, { provider: provider.providerName, observedAt: bars[0]!.observedAt });
  if (bars.length) await options.storage.appendBars(bars);
}

test("B1 re-FIGI collision: old INACTIVE stored row + new ACTIVE id with later historicalSymbols adds 0 rows and logs collision by status", async () => {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const oldFigi = "FIGI000OLD01";
  const newFigi = "FIGI000NEW01";
  const oldId = securityId("massive-stocks", oldFigi, "STOCK");
  const newId = securityId("massive-stocks", newFigi, "STOCK");
  const day = DAYS[0]!;
  await storage.saveSecurities([
    {
      securityId: oldId,
      providerIdentities: [{ provider: "massive-stocks", providerSecurityId: oldFigi }],
      currentSymbol: "SYNA",
      historicalSymbols: [{ symbol: "SYNA", effectiveFrom: "2024-01-01" }],
      assetType: "STOCK",
      country: "US",
      exchange: "XNYS",
      status: "INACTIVE",
      inactiveAt: "2026-10-02",
      tradable: true,
      barCount: 1,
      eligibility: "NONE",
    },
    {
      securityId: newId,
      providerIdentities: [{ provider: "massive-stocks", providerSecurityId: newFigi }],
      currentSymbol: "SYNA",
      historicalSymbols: [{ symbol: "SYNA", effectiveFrom: "2026-10-05" }],
      assetType: "STOCK",
      country: "US",
      exchange: "XNYS",
      status: "ACTIVE",
      tradable: true,
      barCount: 0,
      eligibility: "NONE",
    },
  ]);
  await seedRawDustAndBars({
    client,
    storage,
    day,
    tickers: [{ ticker: "SYNA", figi: oldFigi, active: false }],
    seedBarsForIds: [oldId],
    groupedTickers: ["SYNA"],
  });
  const base = fakeMassive({ tickers: [], grouped: () => [{ T: "SYNA", o: 10, h: 11, l: 9, c: 10.5, v: 1000 }] });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v3/reference/tickers") {
      const active = url.searchParams.get("active") !== "false";
      return new Response(
        JSON.stringify({
          status: "OK",
          results: active
            ? [{ ticker: "SYNA", share_class_figi: newFigi, type: "CS", market: "stocks", locale: "us", primary_exchange: "XNYS", active: true }]
            : [{ ticker: "SYNA", share_class_figi: oldFigi, type: "CS", market: "stocks", locale: "us", primary_exchange: "XNYS", active: false }],
        }),
        { status: 200 },
      );
    }
    return base.fetchImpl(input, init);
  };
  const fake = { ...base, fetchImpl, splitCalls: [] as string[], divCalls: [] as string[] };
  const monthKey = "permanent/daily-bars/2026-01.jsonl";
  let monthWrites = 0;
  const origPut = client.put.bind(client);
  const origPutIfMatch = client.putIfMatch.bind(client);
  client.put = async (k, b, m) => {
    if (k === monthKey) monthWrites += 1;
    return origPut(k, b, m);
  };
  client.putIfMatch = async (k, b, e) => {
    if (k === monthKey) monthWrites += 1;
    return origPutIfMatch(k, b, e);
  };
  const report = await runBackfillJob(
    jobOpts(client, storage, fake, day, day, { reopenInactiveTails: true }),
  );
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.backfill.barsStored, 0, "0 duplicate rows added on re-FIGI collision");
  assert.equal(monthWrites, 0, "month file untouched");
  assert.deepEqual((await storage.loadBars(day)).map((b) => b.securityId), [oldId]);
  assert.deepEqual(report.backfill.reopenAddedByStatus, {});
  assert.deepEqual(report.backfill.reopenSkippedCollisionByStatus, { ACTIVE: 1 });
});

test("B1 reopen appends INACTIVE-only: skips non-colliding ACTIVE missing rows and INACTIVE symbol collisions", async () => {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const day = DAYS[0]!;
  const oldInactFigi = "FIGI000OLD02";
  const newInactFigi = "FIGI000NEW02";
  const actFigi = "FIGI000ACT03";
  const delFigi = "FIGI000DEL03";
  const oldInactId = securityId("massive-stocks", oldInactFigi, "STOCK");
  const newInactId = securityId("massive-stocks", newInactFigi, "STOCK");
  const actId = securityId("massive-stocks", actFigi, "STOCK");
  const delId = securityId("massive-stocks", delFigi, "STOCK");
  await storage.saveSecurities([
    {
      securityId: oldInactId,
      providerIdentities: [{ provider: "massive-stocks", providerSecurityId: oldInactFigi }],
      currentSymbol: "SYNB",
      historicalSymbols: [{ symbol: "SYNB", effectiveFrom: "2024-01-01" }],
      assetType: "STOCK",
      country: "US",
      exchange: "XNYS",
      status: "INACTIVE",
      inactiveAt: "2026-01-19",
      tradable: true,
      barCount: 1,
      eligibility: "NONE",
    },
    {
      securityId: newInactId,
      providerIdentities: [{ provider: "massive-stocks", providerSecurityId: newInactFigi }],
      currentSymbol: "SYNB",
      historicalSymbols: [{ symbol: "SYNB", effectiveFrom: "2026-01-20" }],
      assetType: "STOCK",
      country: "US",
      exchange: "XNYS",
      status: "INACTIVE",
      inactiveAt: "2026-10-02",
      tradable: true,
      barCount: 0,
      eligibility: "NONE",
    },
    {
      securityId: actId,
      providerIdentities: [{ provider: "massive-stocks", providerSecurityId: actFigi }],
      currentSymbol: "SYNC",
      assetType: "STOCK",
      country: "US",
      exchange: "XNYS",
      status: "ACTIVE",
      tradable: true,
      barCount: 0,
      eligibility: "NONE",
    },
    {
      securityId: delId,
      providerIdentities: [{ provider: "massive-stocks", providerSecurityId: delFigi }],
      currentSymbol: "SYND",
      assetType: "STOCK",
      country: "US",
      exchange: "XNYS",
      status: "INACTIVE",
      inactiveAt: "2026-10-02",
      tradable: true,
      barCount: 0,
      eligibility: "NONE",
    },
  ]);
  await seedRawDustAndBars({
    client,
    storage,
    day,
    tickers: [{ ticker: "SYNB", figi: oldInactFigi, active: false }],
    seedBarsForIds: [oldInactId],
    groupedTickers: ["SYNB", "SYNC", "SYND"],
  });
  const base = fakeMassive({ tickers: [], grouped: () => [] });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v3/reference/tickers") {
      const active = url.searchParams.get("active") !== "false";
      return new Response(
        JSON.stringify({
          status: "OK",
          results: active
            ? [{ ticker: "SYNC", share_class_figi: actFigi, type: "CS", market: "stocks", locale: "us", primary_exchange: "XNYS", active: true }]
            : [
                { ticker: "SYNB", share_class_figi: newInactFigi, type: "CS", market: "stocks", locale: "us", primary_exchange: "XNYS", active: false },
                { ticker: "SYND", share_class_figi: delFigi, type: "CS", market: "stocks", locale: "us", primary_exchange: "XNYS", active: false },
              ],
        }),
        { status: 200 },
      );
    }
    return base.fetchImpl(input, init);
  };
  const fake = { ...base, fetchImpl, splitCalls: [] as string[], divCalls: [] as string[] };
  const report = await runBackfillJob(
    jobOpts(client, storage, fake, day, day, { reopenInactiveTails: true }),
  );
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.backfill.barsStored, 1);
  assert.deepEqual((await storage.loadBars(day)).map((b) => b.securityId).sort(), [oldInactId, delId].sort());
  assert.deepEqual(report.backfill.reopenAddedByStatus, { INACTIVE: 1 });
  assert.deepEqual(report.backfill.reopenSkippedCollisionByStatus, { INACTIVE: 1 });
  assert.deepEqual(report.backfill.reopenSkippedNonInactiveByStatus, { ACTIVE: 1 });
});

test("corrupt backfill-reopen-state.json refuses instead of silently restarting", async () => {
  const { client, storage } = await seedStore({ withReplyDust: true });
  await client.put("backfill-reopen-state.json", new TextEncoder().encode("{not-valid-json"));
  const fake = makeFake();
  await assert.rejects(
    () => runBackfillJob(jobOpts(client, storage, fake, DAYS[0]!, DAYS[0]!, { reopenInactiveTails: true })),
    /JSON|BACKFILL_REOPEN_STATE_CORRUPT/u,
  );
  await client.put(
    "backfill-reopen-state.json",
    new TextEncoder().encode(JSON.stringify({ schemaVersion: "wrong", provider: "massive-stocks" })),
  );
  await assert.rejects(
    () => runBackfillJob(jobOpts(client, storage, fake, DAYS[0]!, DAYS[0]!, { reopenInactiveTails: true })),
    /BACKFILL_REOPEN_STATE_CORRUPT/u,
  );
});
