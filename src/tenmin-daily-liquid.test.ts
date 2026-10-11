import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalTenMinuteBar, SecurityMasterRecord, TenMinuteRangeReply } from "./contracts";
import { MemoryObjectClient } from "./object-store";
import {
  TENMIN_DAILY_CLOSE_ORIGIN,
  type LiquidityBar,
  dailyBarsLoader,
  parseTenMinDailyLiquidN,
  parseTenMinDailyMaxRequests,
  readTenMinDailyIndex,
  readTenMinSecurityDay,
  runTenMinDailyFromEnv,
  runTenMinDailyLiquid,
  selectTenMinDailyLiquidNames,
  tenMinDailyCatchupSessions,
  tenMinDailyIndexKey,
  tenMinDailyYieldReason,
  tradingSessionsBefore,
} from "./tenmin-daily-liquid";
import { assertNoOverlappingTenMinRangeStoredFetches, rebuildTenMinRangeEntriesFromStore } from "./tenmin-range-entries";
import {
  readTenMinRangeManifest,
  tenMinRangeFileKey,
  tenMinRangeManifestKey,
  writeTenMinRangeReplyDust,
} from "./tenmin-range-reply-dust";

const PROVIDER = "massive-stocks";
const RANGE_FROM = "2026-09-01";
const RANGE_TO = "2026-10-31";
const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";
const ISO = () => "2026-10-10T06:30:00.000Z";

function security(symbol: string, status: SecurityMasterRecord["status"] = "ACTIVE"): SecurityMasterRecord {
  return {
    securityId: `sec_${symbol.toLowerCase()}`,
    currentSymbol: symbol,
    historicalSymbols: [],
    assetType: "STOCK",
    country: "US",
    exchange: "XNYS",
    firstSeenAt: "2024-01-01",
    status,
    tradable: true,
    providerIdentities: [],
    eligibility: "LEVEL_2",
    barCount: 100,
    lastUniverseSeenAt: "2026-10-09",
  };
}

const SECURITIES = ["AAA", "BBB", "CCC", "DDD"].map((s) => security(s));
/** Dollar volume per day: AAA > BBB > CCC > DDD. */
const DV: Record<string, number> = { AAA: 4000, BBB: 3000, CCC: 2000, DDD: 1000 };

function barsFor(sessions: readonly string[], dv: Record<string, number> = DV): LiquidityBar[] {
  return sessions.flatMap((sessionDate) =>
    Object.entries(dv).map(([symbol, value]) => ({
      securityId: `sec_${symbol.toLowerCase()}`,
      sessionDate,
      close: 10,
      volume: value / 10,
      revision: 0,
    })),
  );
}

/** One 10-minute Massive bar JSON for a UTC ISO time. */
const aggBar = (iso: string, price: number) =>
  `{"v":100,"vw":${price},"o":${price},"c":${price + 0.01},"h":${price + 0.02},"l":${price - 0.01},"t":${Date.parse(iso)},"n":3}`;
/** Two regular-hours bars on session D (EDT: 13:30Z and 13:40Z). */
const dayBars = (symbol: string, d: string) => {
  const base = symbol.charCodeAt(0);
  return [aggBar(`${d}T13:30:00Z`, base), aggBar(`${d}T13:40:00Z`, base + 0.5)];
};

function replyPages(symbol: string, securityId: string, from: string, to: string, bars: string[], fetchedAt = "2026-10-10T06:31:00.000Z"): TenMinuteRangeReply[] {
  const body = `{"ticker":"${symbol}","adjusted":false,"results":[${bars.join(",")}],"status":"OK","request_id":"SYN-${symbol}-${from}-${to}","count":${bars.length}}`;
  return [
    {
      page: 1,
      request: `/v2/aggs/ticker/${symbol}/range/10/minute/${from}/${to}?adjusted=false&sort=asc&limit=50000`,
      fetchedAt,
      body: new TextEncoder().encode(body),
      rangeFrom: from,
      rangeTo: to,
      securityId,
      symbol,
    },
  ];
}

/** Fake Massive for the daily step: records (symbol, from, to) per call. */
function dailyFetcher(calls: string[]) {
  return async (sec: { securityId: string; symbol: string }, from: string, to: string) => {
    calls.push(`${sec.symbol}:${from}:${to}`);
    assert.equal(from, to, "daily step fetches exactly one session");
    return replyPages(sec.symbol, sec.securityId, from, to, dayBars(sec.symbol, from));
  };
}

function baseRun(store: MemoryObjectClient, calls: string[], overrides: Partial<Parameters<typeof runTenMinDailyLiquid>[0]> = {}) {
  return runTenMinDailyLiquid({
    store,
    securities: SECURITIES,
    provider: PROVIDER,
    n: 3,
    maxRequests: 100,
    lastCompletedSession: "2026-10-09",
    catchupSessions: 2,
    loadBars: async (sessions) => barsFor(sessions),
    nowIso: ISO,
    zstdVersionProbe: pinnedZstd,
    fetchPages: dailyFetcher(calls),
    ...overrides,
  });
}

test("TENMIN_DAILY_LIQUID_N and TENMIN_DAILY_MAX_REQUESTS: defaults, cap, strict parse", () => {
  assert.equal(parseTenMinDailyLiquidN(undefined), 500);
  assert.equal(parseTenMinDailyLiquidN("  "), 500);
  assert.equal(parseTenMinDailyLiquidN("1000"), 1000);
  assert.equal(parseTenMinDailyLiquidN("1"), 1);
  for (const bad of ["0", "1001", "abc", "5.5", "-3", "1e3"])
    assert.throws(() => parseTenMinDailyLiquidN(bad), /TENMIN_DAILY_LIQUID_N_INVALID/u);
  assert.equal(parseTenMinDailyMaxRequests(""), 720);
  assert.throws(() => parseTenMinDailyMaxRequests("2001"), /TENMIN_DAILY_MAX_REQUESTS_INVALID/u);
});

test("kill switch: anything but exactly 'true' does nothing; config is validated before any store or request", async () => {
  for (const value of [undefined, "", "TRUE", "1", "yes"]) {
    const summary = await runTenMinDailyFromEnv({ TENMIN_DAILY_ENABLED: value } as NodeJS.ProcessEnv);
    assert.equal(summary.status, "DISABLED");
  }
  await assert.rejects(
    runTenMinDailyFromEnv({ TENMIN_DAILY_ENABLED: "true", TENMIN_DAILY_LIQUID_N: "5000" } as NodeJS.ProcessEnv),
    /TENMIN_DAILY_LIQUID_N_INVALID/u,
  );
});

test("sessions: trailing window is strictly before D and skips weekends/holidays; catch-up is oldest first", () => {
  assert.deepEqual(tradingSessionsBefore("2026-10-13", 2), ["2026-10-09", "2026-10-12"]);
  // 2026-11-26 is Thanksgiving (closed).
  assert.deepEqual(tradingSessionsBefore("2026-11-27", 2), ["2026-11-24", "2026-11-25"]);
  assert.deepEqual(tenMinDailyCatchupSessions("2026-10-09", 3), ["2026-10-07", "2026-10-08", "2026-10-09"]);
  assert.equal(tradingSessionsBefore("2026-10-13", 20).length, 20);
  assert.ok(tradingSessionsBefore("2026-10-13", 20).every((s) => s < "2026-10-13"));
});

test("selection: top N by trailing dollar volume, no lookahead, latest revision, ACTIVE only, ties by securityId", () => {
  const D = "2026-10-09";
  const trailing = tradingSessionsBefore(D, 3);
  const base = barsFor(trailing);
  const picked = selectTenMinDailyLiquidNames({ sessionDate: D, trailingSessions: trailing, bars: base, securities: SECURITIES, n: 2 });
  assert.deepEqual(picked.map((p) => [p.rank, p.symbol]), [[1, "AAA"], [2, "BBB"]]);
  assert.equal(picked[0]!.dollarVolume, 12000);
  assert.equal(picked[0]!.sessions, 3);

  // A huge DDD bar on D itself and after D must not change anything.
  const future: LiquidityBar[] = [
    { securityId: "sec_ddd", sessionDate: D, close: 1e6, volume: 1e6, revision: 0 },
    { securityId: "sec_ddd", sessionDate: "2026-10-12", close: 1e6, volume: 1e6, revision: 0 },
  ];
  assert.deepEqual(
    selectTenMinDailyLiquidNames({ sessionDate: D, trailingSessions: trailing, bars: [...base, ...future], securities: SECURITIES, n: 2 }),
    picked,
  );
  assert.throws(
    () => selectTenMinDailyLiquidNames({ sessionDate: D, trailingSessions: [...trailing, D], bars: base, securities: SECURITIES, n: 2 }),
    /TENMIN_DAILY_LOOKAHEAD/u,
  );

  // Latest revision wins: a revised CCC bar (revision 1) on one trailing day lifts CCC to the top.
  const revised: LiquidityBar[] = [...base, { securityId: "sec_ccc", sessionDate: trailing[0]!, close: 10, volume: 100_000, revision: 1 }];
  assert.equal(selectTenMinDailyLiquidNames({ sessionDate: D, trailingSessions: trailing, bars: revised, securities: SECURITIES, n: 1 })[0]!.symbol, "CCC");

  // Inactive names never selected; ties broken by securityId.
  const tie = barsFor(trailing, { AAA: 500, BBB: 500 });
  const withInactive = [security("AAA", "DELISTED"), security("BBB"), security("CCC")];
  assert.deepEqual(
    selectTenMinDailyLiquidNames({ sessionDate: D, trailingSessions: trailing, bars: tie, securities: withInactive, n: 5 }).map((p) => p.symbol),
    ["BBB"],
  );
  assert.deepEqual(
    selectTenMinDailyLiquidNames({ sessionDate: D, trailingSessions: trailing, bars: tie, securities: SECURITIES, n: 5 }).map((p) => p.symbol),
    ["AAA", "BBB"],
  );
});

test("daily-bars loader reads each month once and keeps only the wanted sessions", async () => {
  const store = new MemoryObjectClient();
  const row = (sid: string, d: string, close: number, volume: number, revision = 0) =>
    JSON.stringify({ securityId: sid, sessionDate: d, close, volume, revision, open: 1, high: 1, low: 1 });
  await store.put("permanent/daily-bars/2026-09.jsonl", new TextEncoder().encode([row("a", "2026-09-30", 2, 3), row("a", "2026-09-29", 9, 9)].join("\n") + "\n"));
  await store.put("permanent/daily-bars/2026-10.jsonl", new TextEncoder().encode([row("a", "2026-10-01", 4, 5, 1), "not json"].join("\n") + "\n"));
  let gets = 0;
  const counting = { get: async (key: string) => ((gets += 1), store.get(key)) };
  const load = dailyBarsLoader(counting);
  const rows = await load(["2026-09-30", "2026-10-01"]);
  assert.deepEqual(rows, [
    { securityId: "a", sessionDate: "2026-09-30", close: 2, volume: 3, revision: 0 },
    { securityId: "a", sessionDate: "2026-10-01", close: 4, volume: 5, revision: 1 },
  ]);
  await load(["2026-10-01"]);
  assert.equal(gets, 2);
});

test("run: oldest session first, rank order, one request per name, same range format + rd-origin, budget then catch-up, then idempotent", async () => {
  const store = new MemoryObjectClient();
  const calls: string[] = [];
  const first = await baseRun(store, calls, { maxRequests: 4 });
  assert.deepEqual(calls, ["AAA:2026-10-08:2026-10-08", "BBB:2026-10-08:2026-10-08", "CCC:2026-10-08:2026-10-08", "AAA:2026-10-09:2026-10-09"]);
  assert.equal(first.massiveRequests, 4);
  assert.equal(first.budgetStop, true);
  assert.equal(first.estimatedKeyMinutes, Math.round(((4 * 12.5) / 60) * 10) / 10);
  assert.deepEqual(first.sessions.map((s) => [s.sessionDate, s.status, s.stored]), [["2026-10-08", "COMPLETE", 3], ["2026-10-09", "PARTIAL", 1]]);

  const key = tenMinRangeFileKey(RANGE_FROM, RANGE_TO, "sec_aaa", "AAA", "2026-10-08", "2026-10-08", 1);
  const head = await store.head(key);
  assert.ok(head, "stored under the chain's range folder and file name");
  assert.equal(head!.metadata["rd-origin"], TENMIN_DAILY_CLOSE_ORIGIN);
  assert.equal(head!.metadata["rd-range-from"], RANGE_FROM);
  assert.equal(head!.metadata["rd-fetch-from"], "2026-10-08");
  assert.equal(head!.metadata["rd-fetch-to"], "2026-10-08");
  const index = await readTenMinDailyIndex(store, "2026-10-09");
  assert.equal(tenMinDailyIndexKey("2026-10-09"), `permanent/tenmin-reply-dust/${RANGE_FROM}_${RANGE_TO}/daily/2026-10-09.json`);
  assert.deepEqual(index!.selected.map((s) => s.symbol), ["AAA", "BBB", "CCC"]);
  assert.deepEqual(index!.rule.trailingSessions, tradingSessionsBefore("2026-10-09", 20));

  calls.length = 0;
  const second = await baseRun(store, calls, { maxRequests: 4 });
  assert.deepEqual(calls, ["BBB:2026-10-09:2026-10-09", "CCC:2026-10-09:2026-10-09"]);
  assert.equal(second.budgetStop, undefined);
  assert.ok(second.sessions.every((s) => s.status === "COMPLETE"));

  const bytesBefore = await store.get(key);
  calls.length = 0;
  const third = await baseRun(store, calls);
  assert.deepEqual(calls, []);
  assert.equal(third.massiveRequests, 0);
  assert.deepEqual(await store.get(key), bytesBefore, "never rewritten");
});

test("selection is frozen per session: a resumed run fetches the names chosen first even if later bars change the ranking", async () => {
  const store = new MemoryObjectClient();
  const calls: string[] = [];
  await baseRun(store, calls, { maxRequests: 1, catchupSessions: 1, n: 2 });
  assert.deepEqual(calls, ["AAA:2026-10-09:2026-10-09"]);
  calls.length = 0;
  const flipped = { AAA: 1, BBB: 1, CCC: 1, DDD: 1e9 };
  const run = await baseRun(store, calls, { catchupSessions: 1, n: 2, loadBars: async (s) => barsFor(s, flipped) });
  assert.deepEqual(calls, ["BBB:2026-10-09:2026-10-09"]);
  assert.equal(run.sessions[0]!.status, "COMPLETE");
});

test("idempotent: an object already stored is verified and adopted (no request); an unverifiable one is reported and never overwritten", async () => {
  const store = new MemoryObjectClient();
  const calls: string[] = [];
  // AAA's 10-09 object exists (e.g. index lost); BBB's 10-09 key holds junk.
  await baseRun(store, calls, { catchupSessions: 1, n: 1 });
  await store.put(tenMinDailyIndexKey("2026-10-09"), new TextEncoder().encode("{}"));
  const fresh = new MemoryObjectClient();
  for (const k of await store.list("permanent/tenmin-reply-dust/")) {
    if (k.endsWith(".json")) continue;
    await fresh.put(k, (await store.get(k))!, (await store.head(k))!.metadata);
  }
  const junkKey = tenMinRangeFileKey(RANGE_FROM, RANGE_TO, "sec_bbb", "BBB", "2026-10-09", "2026-10-09", 1);
  await fresh.put(junkKey, new Uint8Array([1, 2, 3]), { "rd-page-count": "1" });
  calls.length = 0;
  const run = await baseRun(fresh, calls, { catchupSessions: 1, n: 3 });
  assert.deepEqual(calls, ["CCC:2026-10-09:2026-10-09"]);
  assert.equal(run.sessions[0]!.adoptedThisRun, 1);
  assert.equal(run.sessions[0]!.gaps, 1);
  assert.deepEqual(await fresh.get(junkKey), new Uint8Array([1, 2, 3]));
  const index = await readTenMinDailyIndex(fresh, "2026-10-09");
  assert.deepEqual(index!.gaps.map((g) => [g.symbol, g.reason]), [["BBB", "TENMIN_DAILY_OBJECT_UNVERIFIED"]]);
  assert.equal(index!.stored.find((s) => s.securityId === "sec_aaa")?.adopted, true);
});

test("a corrupt index fails the run instead of re-selecting", async () => {
  const store = new MemoryObjectClient();
  await baseRun(store, [], { catchupSessions: 1, n: 1 });
  const key = tenMinDailyIndexKey("2026-10-09");
  const text = new TextDecoder().decode((await store.get(key))!).replace('"AAA"', '"ZZZ"');
  await store.put(key, new TextEncoder().encode(text));
  await assert.rejects(baseRun(store, [], { catchupSessions: 1 }), /TENMIN_DAILY_INDEX_CHECKSUM_MISMATCH/u);
});

test("sealed range: the chain owns those sessions, the daily step skips them with zero requests", async () => {
  const store = new MemoryObjectClient();
  await store.put(tenMinRangeManifestKey(RANGE_FROM, RANGE_TO), new TextEncoder().encode("{}"));
  const calls: string[] = [];
  const run = await baseRun(store, calls);
  assert.deepEqual(calls, []);
  assert.deepEqual(run.sessions.map((s) => s.status), ["SKIPPED_RANGE_SEALED", "SKIPPED_RANGE_SEALED"]);
});

test("yield: stops between names (never mid-name), keeps what was stored, resumes later", async () => {
  const store = new MemoryObjectClient();
  const calls: string[] = [];
  let checks = 0;
  const run = await baseRun(store, calls, {
    catchupSessions: 1,
    shouldYield: async () => (++checks > 1 ? "SCAN_GUARD_WINDOW:test" : undefined),
  });
  assert.equal(run.yielded, "SCAN_GUARD_WINDOW:test");
  assert.deepEqual(calls, ["AAA:2026-10-09:2026-10-09"]);
  assert.equal((await readTenMinDailyIndex(store, "2026-10-09"))!.stored.length, 1);
  calls.length = 0;
  await baseRun(store, calls, { catchupSessions: 1 });
  assert.deepEqual(calls, ["BBB:2026-10-09:2026-10-09", "CCC:2026-10-09:2026-10-09"]);
});

test("outage: 5 network/5xx failures in a row stop the run; a 404-style failure is a retried gap", async () => {
  const store = new MemoryObjectClient();
  let n = 0;
  const outage = await baseRun(store, [], {
    n: 3,
    catchupSessions: 2,
    fetchPages: async () => {
      n += 1;
      throw new Error("MASSIVE_HTTP_503");
    },
  });
  assert.equal(n, 5);
  assert.match(outage.outageStop ?? "", /^MASSIVE_OUTAGE:MASSIVE_HTTP_503/u);
  const calls: string[] = [];
  const fetcher = dailyFetcher(calls);
  const gapRun = await baseRun(new MemoryObjectClient(), calls, {
    catchupSessions: 1,
    fetchPages: async (sec, from, to) => {
      if (sec.symbol === "BBB") throw new Error("MASSIVE_HTTP_404");
      return fetcher(sec, from, to);
    },
  });
  assert.equal(gapRun.sessions[0]!.gaps, 1);
  assert.equal(gapRun.sessions[0]!.status, "COMPLETE");
});

test("yield reason: guard windows, deadline, waiting scheduled scan only (history, restarter and the daily run itself do not preempt)", async () => {
  assert.match((await tenMinDailyYieldReason({ now: () => new Date("2026-10-13T05:20:00Z"), env: {} })) ?? "", /^SCAN_GUARD_WINDOW/u);
  assert.match((await tenMinDailyYieldReason({ now: () => new Date("2026-10-13T09:15:00Z"), env: {} })) ?? "", /^SCAN_GUARD_WINDOW/u);
  assert.equal(await tenMinDailyYieldReason({ now: () => new Date("2026-10-13T06:15:00Z"), env: {} }), undefined);
  assert.match(
    (await tenMinDailyYieldReason({ now: () => new Date("2026-10-13T07:00:00Z"), env: {}, deadlineMs: Date.parse("2026-10-13T07:00:00Z") })) ?? "",
    /^TIME_BUDGET/u,
  );
  const env = {
    GITHUB_TOKEN: "t",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_WORKFLOW_REF: "o/r/.github/workflows/scanner.yml@refs/heads/main",
    GITHUB_RUN_ID: "1",
  } as NodeJS.ProcessEnv;
  const runs = (list: object[]) => async () => new Response(JSON.stringify({ workflow_runs: list }), { status: 200 });
  const at = () => new Date("2026-10-13T07:00:00Z");
  const others = [
    { id: 1, status: "in_progress", event: "schedule", display_title: "Scanner tenmin daily" },
    { id: 2, status: "queued", event: "workflow_dispatch", display_title: "Scanner" },
    { id: 3, status: "in_progress", event: "schedule", display_title: "Scanner restarter" },
    { id: 4, status: "completed", event: "schedule", display_title: "Scanner" },
  ];
  assert.equal(await tenMinDailyYieldReason({ now: at, env, fetchImpl: runs(others) as typeof fetch }), undefined);
  assert.equal(
    await tenMinDailyYieldReason({
      now: at,
      env,
      fetchImpl: runs([...others, { id: 5, status: "pending", event: "schedule", display_title: "Scanner" }]) as typeof fetch,
    }),
    "SCAN_RUN_WAITING:5:pending",
  );
  assert.match(
    (await tenMinDailyYieldReason({ now: at, env, fetchImpl: (async () => new Response("", { status: 500 })) as typeof fetch })) ?? "",
    /^SCAN_CHECK_FAILED/u,
  );
});

function ohlcv(bars: readonly CanonicalTenMinuteBar[]) {
  return bars.map((b) => [b.intervalIndex, b.state, b.open, b.high, b.low, b.close, b.volume, b.vwap, b.sourceTimestamp]);
}

test("history chain reuse: chain fetches its full span once, daily objects are superseded (kept), one consistent series, no gap/overlap", async () => {
  const root = await mkdtemp(join(tmpdir(), "tenmin-daily-chain-"));
  try {
    const store = new MemoryObjectClient();
    const dailyCalls: string[] = [];
    // Daily step stores 10-08 and 10-09 for the top 2 (AAA, BBB).
    await baseRun(store, dailyCalls, { n: 2 });
    assert.equal(dailyCalls.length, 4);

    // Before the range seals, readers get the daily objects.
    const before = await readTenMinSecurityDay(store, "sec_aaa", "2026-10-08");
    assert.equal(before.source, "daily");
    assert.ok(before.bars.some((b) => b.state !== "NO_TRADE" && b.close !== undefined));
    assert.deepEqual(await readTenMinSecurityDay(store, "sec_ccc", "2026-10-08"), { source: "none", bars: [] });

    const dailyKeys = (await store.list(`permanent/tenmin-reply-dust/${RANGE_FROM}_${RANGE_TO}/`)).filter((k) => k.endsWith(".rdust"));
    const dailyBytes = new Map(await Promise.all(dailyKeys.map(async (k) => [k, await store.get(k)] as const)));

    // The chain later works the closed range. AAA: full span (its first..last stored session).
    // BBB: its only planned span is exactly 10-09 (e.g. listed that day) = the daily identity.
    const chainCalls: string[] = [];
    const fullAaa = ["2026-09-01", "2026-10-08", "2026-10-09", "2026-10-30"].flatMap((d) => dayBars("AAA", d));
    const result = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: RANGE_FROM,
      to: RANGE_TO,
      fetches: [
        { securityId: "sec_aaa", symbol: "AAA", fetchFrom: "2026-09-01", fetchTo: "2026-10-30" },
        { securityId: "sec_bbb", symbol: "BBB", fetchFrom: "2026-10-09", fetchTo: "2026-10-09" },
      ],
      zstdVersionProbe: pinnedZstd,
      now: ISO,
      fetchPages: async (sec, from, to) => {
        chainCalls.push(`${sec.symbol}:${from}:${to}`);
        return replyPages(sec.symbol, sec.securityId, from, to, fullAaa, "2026-11-02T03:00:00.000Z");
      },
    });
    assert.deepEqual(chainCalls, ["AAA:2026-09-01:2026-10-30"], "one request for AAA; BBB reused the daily object");
    assert.equal(result.sealed, true);
    assert.equal(result.massiveRequests, 1);
    assert.equal(result.fetchesResumed, 1);

    const manifest = await readTenMinRangeManifest(store, RANGE_FROM, RANGE_TO);
    const spans = manifest!.securities.map((s) => [s.securityId, s.fetches.map((f) => `${f.fetchFrom}_${f.fetchTo}`)]);
    assert.deepEqual(spans, [
      ["sec_aaa", ["2026-09-01_2026-10-30"]],
      ["sec_bbb", ["2026-10-09_2026-10-09"]],
    ]);

    // After the seal every read comes from the range manifest; values equal the daily ones (same
    // replies), and every session is served once (readRangeSecurityDay refuses overlaps).
    for (const d of ["2026-10-08", "2026-10-09"]) {
      const daily = await (async () => {
        const copy = new MemoryObjectClient();
        for (const k of await store.list("permanent/tenmin-reply-dust/")) {
          if (k.endsWith("manifest.json") || k.includes("/entries-")) continue;
          await copy.put(k, (await store.get(k))!, (await store.head(k))!.metadata);
        }
        return readTenMinSecurityDay(copy, "sec_aaa", d);
      })();
      const after = await readTenMinSecurityDay(store, "sec_aaa", d);
      assert.equal(daily.source, "daily");
      assert.equal(after.source, "range");
      assert.deepEqual(ohlcv(after.bars), ohlcv(daily.bars));
    }
    assert.equal((await readTenMinSecurityDay(store, "sec_bbb", "2026-10-09")).source, "range");
    assert.ok((await readTenMinSecurityDay(store, "sec_aaa", "2026-10-30")).bars.some((b) => b.close !== undefined));

    // Daily objects are never deleted or rewritten.
    for (const [k, bytes] of dailyBytes) assert.deepEqual(await store.get(k), bytes);

    // The entries rebuild (read-only fallback) lets the chain fetch supersede AAA's daily objects
    // and keeps BBB's reused one: no overlap.
    const rebuilt = await rebuildTenMinRangeEntriesFromStore(store, RANGE_FROM, RANGE_TO);
    assert.doesNotThrow(() => assertNoOverlappingTenMinRangeStoredFetches(rebuilt.records));
    assert.deepEqual(
      rebuilt.records.map((r) => `${r.securityId}:${r.fetchFrom}_${r.fetchTo}`),
      ["sec_aaa:2026-09-01_2026-10-30", "sec_bbb:2026-10-08_2026-10-08", "sec_bbb:2026-10-09_2026-10-09"],
    );
    assert.ok(rebuilt.warnings.includes("TENMIN_DAILY_SUPERSEDED:2"));

    // After the seal the daily step leaves the range alone.
    dailyCalls.length = 0;
    const later = await baseRun(store, dailyCalls, { n: 2 });
    assert.deepEqual(dailyCalls, []);
    assert.ok(later.sessions.every((s) => s.status === "SKIPPED_RANGE_SEALED"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("history yields to a working daily run but not to a switched-off daily tick", async () => {
  const { scanYieldReason, TENMIN_DAILY_OFF_RUN_NAME } = await import("./scan-yield");
  const env = {
    GITHUB_TOKEN: "t",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_WORKFLOW_REF: "o/r/.github/workflows/scanner.yml@refs/heads/main",
    GITHUB_RUN_ID: "1",
  } as NodeJS.ProcessEnv;
  const runs = (list: object[]) => (async () => new Response(JSON.stringify({ workflow_runs: list }), { status: 200 })) as typeof fetch;
  const now = () => new Date("2026-10-13T07:00:00Z");
  assert.equal(
    await scanYieldReason({ now, env, fetchImpl: runs([{ id: 2, status: "in_progress", event: "schedule", display_title: TENMIN_DAILY_OFF_RUN_NAME }]) }),
    undefined,
  );
  assert.equal(
    await scanYieldReason({ now, env, fetchImpl: runs([{ id: 3, status: "pending", event: "schedule", display_title: "Scanner tenmin daily" }]) }),
    "SCAN_RUN_WAITING:3:schedule:pending",
  );
});

test("workflow: tenmin_daily job is kill-switched, in the R2 writer group, reads the queue, and runs the daily step", async () => {
  const { readFileSync } = await import("node:fs");
  const yml = readFileSync(new URL("../.github/workflows/scanner.yml", import.meta.url), "utf8");
  const job = yml.slice(yml.indexOf("\n  tenmin_daily:\n"), yml.indexOf("\n  # Hourly ten-minute history restarter"));
  assert.ok(job.includes("if: ${{ vars.TENMIN_DAILY_ENABLED == 'true' && ((github.event_name == 'schedule' && (github.event.schedule == '20 6 * * 2-6' || github.event.schedule == '20 10 * * 2-6')) || (github.event_name == 'workflow_dispatch' && github.event.inputs.mode == 'tenmin_daily')) }}"));
  for (const line of [
    "actions: read",
    "contents: read",
    "timeout-minutes: 170",
    'PEACESTOCKS_REQUIRE_OBJECT_STORE: "1"',
    "TENMIN_DAILY_LIQUID_N: ${{ vars.TENMIN_DAILY_LIQUID_N }}",
    "TENMIN_DAILY_MAX_REQUESTS: ${{ vars.TENMIN_DAILY_MAX_REQUESTS }}",
    "run: pnpm exec tsx src/tenmin-daily-liquid.ts",
    "~/.local/zstd-1.5.7/bin/zstd --version",
  ])
    assert.ok(job.includes(line), line);
  assert.ok(!job.includes("concurrency:"), "uses the workflow-level writer group (no job-level override)");
  assert.ok(!job.includes("actions: write"), "never dispatches anything");
  assert.ok(yml.includes("          - tenmin_daily\n"), "manual mode option");
  // 155 min default budget from 06:20Z ends before the 09:15Z guard window.
  const { TENMIN_DAILY_DEFAULT_BUDGET_MS } = await import("./tenmin-daily-liquid");
  assert.ok(Date.parse("2026-10-13T06:20:00Z") + TENMIN_DAILY_DEFAULT_BUDGET_MS < Date.parse("2026-10-13T09:15:00Z"));
  assert.ok(TENMIN_DAILY_DEFAULT_BUDGET_MS < 170 * 60_000, "budget ends before the job timeout");
});
