import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SecurityMasterRecord, TenMinuteRangeReply } from "./contracts";
import { securityId } from "./identity";
import { MemoryObjectClient } from "./object-store";
import {
  DEFAULT_TENMIN_HISTORY_WINDOW_START,
  addCalendarDays,
  addCalendarYears,
  effectiveHistoryWindowStart,
  lastCompletedSessionDate,
  planTenMinHistoryRanges,
  runTenMinHistory,
  runTenMinHistoryFromEnv,
  TENMIN_DAILY_COVERAGE_HOLE,
  TENMIN_HISTORY_FIRST_RANGE_START,
  pairRangeForDate,
  TENMIN_MIN_UNIVERSE_RATIO,
  TENMIN_UNIVERSE_EMPTY,
  TENMIN_UNIVERSE_TOO_SMALL,
  tenMinHistorySummary,
  loadDailyBarSessionsForRange,
  tradingSessionsBetween,
  universeForTenMinRange,
} from "./tenmin-history";
import { type DailyBarSessionIndex, indexDailyBarSessions } from "./daily-bar-sessions";
import {
  buildTenMinRangeManifest,
  readRangeReplies,
  readRangeSecurityDay,
  readTenMinRangeManifest,
  TENMIN_DELISTED_COVERAGE_MISSING,
  tenMinRangeDelistedCoverage,
  tenMinRangeManifestKey,
  writeTenMinRangeManifest,
  writeTenMinRangeReplyDust,
} from "./tenmin-range-reply-dust";

const PROVIDER = "massive-stocks";
const AT = "2026-10-06T08:00:00.000Z";
const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";
const id = (symbol: string) => securityId(PROVIDER, symbol, "STOCK");
const encoder = new TextEncoder();

function pageBody(symbol: string): string {
  return `{"ticker":"${symbol}","adjusted":false,"results":[{"v":1,"o":1,"c":1,"h":1,"l":1,"t":1730000000000,"n":1}],"status":"OK","request_id":"SYNTHETIC-${symbol}","count":1}`;
}

function pagesFor(
  security: { securityId: string; symbol: string },
  from: string,
  to: string,
): TenMinuteRangeReply[] {
  return [
    {
      page: 1,
      request: `/v2/aggs/ticker/${security.symbol}/range/10/minute/${from}/${to}`,
      fetchedAt: AT,
      body: encoder.encode(pageBody(security.symbol)),
      rangeFrom: from,
      rangeTo: to,
      securityId: security.securityId,
      symbol: security.symbol,
    },
  ];
}

function master(
  symbol: string,
  fields: Partial<SecurityMasterRecord> & { history?: SecurityMasterRecord["historicalSymbols"] } = {},
): SecurityMasterRecord {
  const history =
    fields.history ??
    fields.historicalSymbols ??
    [{ symbol, effectiveFrom: fields.listingDate ?? "2020-01-01", source: PROVIDER }];
  return {
    securityId: fields.securityId ?? id(symbol),
    currentSymbol: fields.currentSymbol ?? symbol,
    historicalSymbols: history,
    assetType: "STOCK",
    country: "US",
    exchange: "NYSE",
    firstSeenAt: fields.firstSeenAt ?? "2020-01-01",
    ...(fields.listingDate ? { listingDate: fields.listingDate } : {}),
    ...(fields.inactiveAt ? { inactiveAt: fields.inactiveAt } : {}),
    ...(fields.delistedAt ? { delistedAt: fields.delistedAt } : {}),
    status: fields.status ?? "ACTIVE",
    tradable: fields.tradable ?? true,
    providerIdentities: [{ provider: PROVIDER, providerSecurityId: symbol }],
    eligibility: "LEVEL_0",
    barCount: 0,
    lastUniverseSeenAt: "2026-10-05",
  };
}

/** Trading sessions in [from, to] by the repo calendar. */
function sessions(from: string, to: string): string[] {
  return tradingSessionsBetween(from, to);
}

function barsIndex(entries: Array<[string, string[]]>): DailyBarSessionIndex {
  return new Map(entries.map(([securityId, dates]) => [securityId, new Set(dates)]));
}

/** A loadDailyBarSessions stub serving one month at a time from an in-memory index. */
function monthLoader(index: DailyBarSessionIndex, loaded: string[] = []) {
  return async (month: string): Promise<DailyBarSessionIndex> => {
    loaded.push(month);
    const output: DailyBarSessionIndex = new Map();
    for (const [securityId, dates] of index) {
      const kept = [...dates].filter((date) => date.startsWith(`${month}-`));
      if (kept.length) output.set(securityId, new Set(kept));
    }
    return output;
  };
}

/** Every listed security has a stored daily bar on every trading session (2024-2026). */
function everyDay(...symbols: string[]) {
  const all = sessions("2024-01-01", "2026-12-31");
  return monthLoader(barsIndex(symbols.map((symbol) => [id(symbol), all])));
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-tenmin-history-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("effectiveHistoryWindowStart: 2y-2d clamp math including leap day", () => {
  assert.equal(DEFAULT_TENMIN_HISTORY_WINDOW_START, "2024-10-07");
  // 2026-10-05 − 2y + 2d = 2024-10-05 + 2d = 2024-10-07
  assert.equal(effectiveHistoryWindowStart("2026-10-05"), "2024-10-07");
  assert.equal(addCalendarYears("2026-10-05", -2), "2024-10-05");
  assert.equal(addCalendarDays("2024-10-05", 2), "2024-10-07");
  // Later last-completed moves the clamp forward.
  assert.equal(effectiveHistoryWindowStart("2026-10-19"), "2024-10-21");
  // Configured floor wins when later than retention.
  assert.equal(effectiveHistoryWindowStart("2026-10-05", "2024-11-01"), "2024-11-01");
  // Leap day: 2024-02-29 − 2y = 2022-02-28, +2d = 2022-03-02
  assert.equal(addCalendarYears("2024-02-29", -2), "2022-02-28");
  assert.equal(addCalendarDays(addCalendarYears("2024-02-29", -2), 2), "2022-03-02");
  assert.equal(effectiveHistoryWindowStart("2024-02-29", "2020-01-01"), "2022-03-02");
});

test("planTenMinHistoryRanges: fixed first range (Nov 2024), two-month pairs, clamp, skip records", () => {
  assert.equal(TENMIN_HISTORY_FIRST_RANGE_START, "2024-11-01");
  // A run on 2026-10-06 (last completed 2026-10-05): window 2024-10-07, first range Nov-Dec 2024.
  const onOct6 = planTenMinHistoryRanges({
    windowStart: "2024-10-07",
    lastCompletedSession: "2026-10-05",
  });
  assert.equal(onOct6.windowStart, "2024-10-07");
  assert.deepEqual(onOct6.ranges[0], {
    calendarFrom: "2024-11-01",
    calendarTo: "2024-12-31",
    fetchFrom: "2024-11-01",
    fetchTo: "2024-12-31",
  });
  // The window days before the first range are skipped on purpose.
  assert.deepEqual(onOct6.skippedBeforeFirstRange, {
    from: "2024-10-07",
    to: "2024-10-31",
    reason: "SKIPPED_BEFORE_FIRST_RANGE",
  });
  assert.deepEqual(onOct6.skippedBefore, []);
  // Boundaries continue as two-month pairs from November.
  assert.deepEqual(
    onOct6.ranges.map((r) => `${r.calendarFrom}_${r.calendarTo}`),
    [
      "2024-11-01_2024-12-31",
      "2025-01-01_2025-02-28",
      "2025-03-01_2025-04-30",
      "2025-05-01_2025-06-30",
      "2025-07-01_2025-08-31",
      "2025-09-01_2025-10-31",
      "2025-11-01_2025-12-31",
      "2026-01-01_2026-02-28",
      "2026-03-01_2026-04-30",
      "2026-05-01_2026-06-30",
      "2026-07-01_2026-08-31",
    ],
  );
  assert.ok(onOct6.ranges.every((r) => r.calendarTo < "2026-10-05" && !r.agedOut));
  assert.ok(!onOct6.ranges.some((r) => r.calendarFrom < "2024-11-01"));
  assert.deepEqual(pairRangeForDate("2024-12-15"), { calendarFrom: "2024-11-01", calendarTo: "2024-12-31" });
  assert.deepEqual(pairRangeForDate("2028-02-29"), { calendarFrom: "2028-01-01", calendarTo: "2028-02-29" });

  // Window start inside the first range: same folder, fetchFrom clamped, dropped days AGED_OUT.
  const onNov20 = planTenMinHistoryRanges({
    windowStart: "2024-10-07",
    lastCompletedSession: "2026-11-20",
  });
  assert.equal(onNov20.windowStart, "2024-11-22");
  assert.equal(onNov20.skippedBeforeFirstRange, undefined);
  assert.deepEqual(onNov20.ranges[0], {
    calendarFrom: "2024-11-01",
    calendarTo: "2024-12-31",
    fetchFrom: "2024-11-22",
    fetchTo: "2024-12-31",
    agedOut: { from: "2024-11-01", to: "2024-11-21" },
  });

  // A range entirely before the window is not planned and keeps its skippedBefore record.
  const later = planTenMinHistoryRanges({
    windowStart: "2024-10-07",
    lastCompletedSession: "2027-02-15",
  });
  assert.equal(later.windowStart, "2025-02-17");
  assert.deepEqual(later.skippedBefore, [{ calendarFrom: "2024-11-01", calendarTo: "2024-12-31" }]);
  assert.equal(later.ranges[0]?.calendarFrom, "2025-01-01");
  assert.equal(later.ranges[0]?.fetchFrom, "2025-02-17");
});

test("lastCompletedSessionDate is the prior eligible ET session", () => {
  assert.equal(lastCompletedSessionDate(new Date("2026-10-06T12:00:00.000Z")), "2026-10-05");
  assert.equal(lastCompletedSessionDate(new Date("2026-10-10T18:00:00.000Z")), "2026-10-09");
});

test("universe plans one sub-span per held ticker when effective dates separate the stored sessions", () => {
  // universe.ts closes a ticker with effectiveTo = the day the next one starts (exclusive end).
  const active = master("NEW", {
    listingDate: "2023-01-01",
    history: [
      { symbol: "OLD", effectiveFrom: "2023-01-01", effectiveTo: "2024-11-26", source: PROVIDER },
      { symbol: "NEW", effectiveFrom: "2024-11-26", source: PROVIDER },
    ],
  });
  const delisted = master("GONE", {
    listingDate: "2022-01-01",
    delistedAt: "2024-11-15",
    status: "DELISTED",
    tradable: false,
    history: [
      { symbol: "GONE", effectiveFrom: "2022-01-01", effectiveTo: "2024-11-15", source: PROVIDER },
    ],
  });
  const bars = barsIndex([
    [id("NEW"), sessions("2024-10-07", "2024-11-30")],
    [id("GONE"), sessions("2024-10-07", "2024-11-15")],
  ]);
  const plan = universeForTenMinRange([active, delisted], bars, "2024-10-07", "2024-11-30", { nowIso: AT });
  assert.equal(plan.refusal, undefined);
  const newFetches = plan.securities.find((s) => s.securityId === id("NEW"))!.fetches;
  assert.deepEqual(
    newFetches.map((f) => [f.symbol, f.fetchFrom, f.fetchTo]),
    [
      ["OLD", "2024-10-07", "2024-11-25"],
      ["NEW", "2024-11-26", "2024-11-29"],
    ],
  );
  // 2024-11-15 is outside GONE's [from, to) span, so the dates do not separate cleanly and the
  // backfill's binding (currentSymbol) is used over first..last stored session.
  const gone = plan.securities.find((s) => s.securityId === id("GONE"))!.fetches;
  assert.deepEqual(gone, [
    { securityId: id("GONE"), symbol: "GONE", fetchFrom: "2024-10-07", fetchTo: "2024-11-15" },
  ]);
});

test("resume on a later day reuses the same calendar folder and skips completed fetches", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const securities = [master("AAA", { listingDate: "2020-01-01" })];
    const ordered: string[] = [];
    const fetchPages = async (
      s: { securityId: string; symbol: string },
      from: string,
      to: string,
    ) => {
      ordered.push(`${from}_${to}`);
      return pagesFor(s, from, to);
    };
    // Day 1: window starts 2024-10-07 (before the first range)
    const first = await runTenMinHistory({
      root,
      store,
      securities,
      loadDailyBarSessions: everyDay("AAA"),
      windowStart: "2024-10-07",
      lastCompletedSession: "2026-10-05",
      maxRanges: 1,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages,
    });
    assert.equal(first.report.ranges[0]?.calendarFrom, "2024-11-01");
    assert.equal(first.report.ranges[0]?.fetchFrom, "2024-11-01");
    assert.ok(await store.get(tenMinRangeManifestKey("2024-11-01", "2024-12-31")));
    const keysAfter = await store.list("permanent/tenmin-reply-dust/");
    ordered.length = 0;
    // Day 2: clamp moved to 2024-11-22 — same folder, already sealed → zero fetches.
    const second = await runTenMinHistory({
      root,
      store,
      securities,
      loadDailyBarSessions: everyDay("AAA"),
      windowStart: "2024-10-07",
      lastCompletedSession: "2026-11-20",
      maxRanges: 1,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages,
    });
    assert.equal(second.report.windowStart, "2024-11-22");
    assert.equal(second.report.ranges[0]?.calendarFrom, "2024-11-01");
    assert.equal(second.report.ranges[0]?.status, "ALREADY_SEALED");
    assert.deepEqual(ordered, []);
    assert.deepEqual(await store.list("permanent/tenmin-reply-dust/"), keysAfter);
  });
});

test("401 aborts without gapping everyone", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    let fetches = 0;
    await assert.rejects(
      () =>
        writeTenMinRangeReplyDust({
          store,
          root,
          provider: PROVIDER,
          from: "2024-10-01",
          to: "2024-11-30",
          fetches: [
            { securityId: id("A"), symbol: "A", fetchFrom: "2024-10-07", fetchTo: "2024-11-30" },
            { securityId: id("B"), symbol: "B", fetchFrom: "2024-10-07", fetchTo: "2024-11-30" },
          ],
          zstdVersionProbe: pinnedZstd,
          fetchPages: async () => {
            fetches += 1;
            throw new Error("MASSIVE_HTTP_401:requestId=x:body=unauthorized");
          },
        }),
      /MASSIVE_HTTP_401/,
    );
    assert.equal(fetches, 1);
  });
});

test("symbol/sub-span mismatch on resume warns and refetches", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const sid = id("TICK");
    await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: "2024-10-01",
      to: "2024-11-30",
      fetches: [{ securityId: sid, symbol: "OLD", fetchFrom: "2024-10-07", fetchTo: "2024-11-30" }],
      zstdVersionProbe: pinnedZstd,
      fetchPages: (s, f, t) => Promise.resolve(pagesFor(s, f, t)),
    });
    await store.delete(tenMinRangeManifestKey("2024-10-01", "2024-11-30"));
    let fetches = 0;
    const result = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: "2024-10-01",
      to: "2024-11-30",
      fetches: [{ securityId: sid, symbol: "NEW", fetchFrom: "2024-10-07", fetchTo: "2024-11-30" }],
      zstdVersionProbe: pinnedZstd,
      fetchPages: async (s, f, t) => {
        fetches += 1;
        assert.equal(s.symbol, "NEW");
        return pagesFor(s, f, t);
      },
    });
    assert.equal(fetches, 1);
    assert.ok(result.warnings?.some((w) => w.includes("TENMIN_RANGE_SYMBOL_CHANGED")));
    const manifest = (await readTenMinRangeManifest(store, "2024-10-01", "2024-11-30"))!;
    assert.equal(manifest.securities[0]?.fetches[0]?.symbol, "NEW");
  });
});

test("yields between fetches and resumes without refetching completed ones", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const fetches = ["A", "B", "C"].map((s) => ({
      securityId: id(s),
      symbol: s,
      fetchFrom: "2024-10-07",
      fetchTo: "2024-11-30",
    }));
    let checks = 0;
    let n = 0;
    const first = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: "2024-10-01",
      to: "2024-11-30",
      fetches,
      zstdVersionProbe: pinnedZstd,
      shouldYield: async () => (++checks >= 3 ? "SCAN_GUARD_WINDOW:test" : undefined),
      fetchPages: async (s, f, t) => {
        n += 1;
        return pagesFor(s, f, t);
      },
    });
    assert.equal(first.sealed, false);
    assert.equal(first.yieldedForScan, "SCAN_GUARD_WINDOW:test");
    assert.equal(n, 2);
    n = 0;
    const second = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: "2024-10-01",
      to: "2024-11-30",
      fetches,
      zstdVersionProbe: pinnedZstd,
      fetchPages: async (s, f, t) => {
        n += 1;
        assert.equal(s.symbol, "C");
        return pagesFor(s, f, t);
      },
    });
    assert.equal(second.sealed, true);
    assert.equal(n, 1);
  });
});

test("history runner processes oldest calendar range first", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const order: string[] = [];
    await runTenMinHistory({
      root,
      store,
      securities: [master("AAA")],
      loadDailyBarSessions: everyDay("AAA"),
      windowStart: "2024-10-07",
      lastCompletedSession: "2025-07-15",
      maxRanges: 3,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages: async (s, from, to) => {
        order.push(`${from}_${to}`);
        return pagesFor(s, from, to);
      },
    });
    // Each fetch spans the first to last stored session in the range.
    assert.deepEqual(order, [
      "2024-11-01_2024-12-31",
      "2025-01-02_2025-02-28",
      "2025-03-03_2025-04-30",
    ]);
  });
});

test("history mode is off by default when env unset", async () => {
  assert.equal(await runTenMinHistoryFromEnv({}), undefined);
  assert.equal(await runTenMinHistoryFromEnv({ PEACESTOCKS_TENMIN_HISTORY: "0" }), undefined);
});

test("MASSIVE_RANGE_PAGE_CAP becomes a gap and the range seals", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const result = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: "2024-10-01",
      to: "2024-11-30",
      fetches: [
        { securityId: id("AAA"), symbol: "AAA", fetchFrom: "2024-10-07", fetchTo: "2024-11-30" },
        { securityId: id("BAD"), symbol: "BAD", fetchFrom: "2024-10-07", fetchTo: "2024-11-30" },
      ],
      zstdVersionProbe: pinnedZstd,
      now: () => AT,
      fetchPages: async (s, f, t) => {
        if (s.symbol === "BAD") throw new Error(`MASSIVE_RANGE_PAGE_CAP:BAD:${f}:${t}`);
        return pagesFor(s, f, t);
      },
    });
    assert.equal(result.sealed, true);
    assert.equal(result.gaps[0]?.reason, "MASSIVE_RANGE_PAGE_CAP");
  });
});

test("reopen retries only gaps + new securities, clears resolved gaps, deterministic manifest", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const calFrom = "2024-10-01";
    const calTo = "2024-11-30";
    const fetchFrom = "2024-10-07";
    const fetchTo = "2024-11-30";
    const good = {
      securityId: id("AAA"),
      symbol: "AAA",
      fetchFrom,
      fetchTo,
    };
    const gapSec = {
      securityId: id("GAP"),
      symbol: "GAP",
      fetchFrom,
      fetchTo,
    };
    const first = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: calFrom,
      to: calTo,
      fetches: [good, gapSec],
      zstdVersionProbe: pinnedZstd,
      now: () => AT,
      fetchPages: async (s, f, t) => {
        if (s.symbol === "GAP") throw new Error("MASSIVE_HTTP_404:requestId=x:body=not found");
        return pagesFor(s, f, t);
      },
    });
    assert.equal(first.gaps[0]?.reason, "MASSIVE_HTTP_404");
    assert.equal(first.gaps[0]?.symbol, "GAP");
    assert.equal(first.gaps[0]?.fetchFrom, fetchFrom);
    const sealedBytes = await store.get(tenMinRangeManifestKey(calFrom, calTo));
    // Normal run skips sealed range: zero fetches (even if universe grew).
    let fetches = 0;
    const newSec = {
      securityId: id("NEW"),
      symbol: "NEW",
      fetchFrom,
      fetchTo,
    };
    const skipped = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: calFrom,
      to: calTo,
      fetches: [good, gapSec, newSec],
      zstdVersionProbe: pinnedZstd,
      fetchPages: async (s, f, t) => {
        fetches += 1;
        return pagesFor(s, f, t);
      },
    });
    assert.equal(skipped.alreadySealed, true);
    assert.equal(fetches, 0);
    assert.deepEqual(await store.get(tenMinRangeManifestKey(calFrom, calTo)), sealedBytes);

    // Reopen: FIGI catch-up — retry gap fetch + new security only; AAA not refetched.
    const reopenFetched: string[] = [];
    const reopened = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: calFrom,
      to: calTo,
      fetches: [good, gapSec, newSec],
      reopen: true,
      zstdVersionProbe: pinnedZstd,
      now: () => "2026-10-06T09:00:00.000Z",
      fetchPages: async (s, f, t) => {
        reopenFetched.push(s.symbol);
        return pagesFor(s, f, t);
      },
    });
    assert.deepEqual(reopenFetched.sort(), ["GAP", "NEW"]);
    assert.equal(reopened.sealed, true);
    assert.deepEqual(reopened.gaps, []);
    const manifest = (await readTenMinRangeManifest(store, calFrom, calTo))!;
    assert.equal(manifest.securityCount, 3);
    assert.deepEqual(manifest.gaps, []);

    // Deterministic: two independent seal+reopen sequences with the same inputs → identical bytes.
    async function sealAndReopen(targetStore: MemoryObjectClient, targetRoot: string) {
      await writeTenMinRangeReplyDust({
        store: targetStore,
        root: targetRoot,
        provider: PROVIDER,
        from: calFrom,
        to: calTo,
        fetches: [good, gapSec],
        zstdVersionProbe: pinnedZstd,
        now: () => AT,
        fetchPages: async (s, f, t) => {
          if (s.symbol === "GAP") throw new Error("MASSIVE_HTTP_404:requestId=x:body=not found");
          return pagesFor(s, f, t);
        },
      });
      return writeTenMinRangeReplyDust({
        store: targetStore,
        root: targetRoot,
        provider: PROVIDER,
        from: calFrom,
        to: calTo,
        fetches: [good, gapSec, newSec],
        reopen: true,
        zstdVersionProbe: pinnedZstd,
        now: () => "2026-10-06T09:00:00.000Z",
        fetchPages: (s, f, t) => Promise.resolve(pagesFor(s, f, t)),
      });
    }
    const store2 = new MemoryObjectClient();
    const store3 = new MemoryObjectClient();
    await withRoot(async (root2) => {
      const a = await sealAndReopen(store2, root2);
      const b = await sealAndReopen(store3, root2);
      assert.deepEqual(
        await store2.get(tenMinRangeManifestKey(calFrom, calTo)),
        await store3.get(tenMinRangeManifestKey(calFrom, calTo)),
      );
      assert.equal(a.manifest?.checksum, b.manifest?.checksum);
    });
  });
});

test("history runner skips a sealed range with zero fetches", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const securities = [master("AAA")];
    let fetches = 0;
    const fetchPages = async (
      s: { securityId: string; symbol: string },
      from: string,
      to: string,
    ) => {
      fetches += 1;
      return pagesFor(s, from, to);
    };
    await runTenMinHistory({
      root,
      store,
      securities,
      loadDailyBarSessions: everyDay("AAA"),
      windowStart: "2024-10-07",
      lastCompletedSession: "2025-01-06",
      maxRanges: 1,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages,
    });
    assert.equal(fetches, 1);
    fetches = 0;
    const second = await runTenMinHistory({
      root,
      store,
      securities,
      loadDailyBarSessions: everyDay("AAA"),
      windowStart: "2024-10-07",
      lastCompletedSession: "2025-01-06",
      maxRanges: 1,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages,
    });
    assert.equal(fetches, 0);
    assert.equal(second.report.ranges[0]?.status, "ALREADY_SEALED");
    assert.equal(second.report.massiveRequests, 0);
  });
});

test("history runner: store error during resume throws with zero new fetches", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const securities = [master("AAA"), master("BBB")];
    await runTenMinHistory({
      root,
      store,
      securities,
      loadDailyBarSessions: everyDay("AAA", "BBB"),
      windowStart: "2024-10-07",
      lastCompletedSession: "2025-01-06",
      maxRanges: 1,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages: (s, f, t) => Promise.resolve(pagesFor(s, f, t)),
    });
    // Unseal so the next run resumes from stored pages (list/verify path).
    await store.delete(tenMinRangeManifestKey("2024-11-01", "2024-12-31"));
    let fetches = 0;
    const failing = {
      get: (key: string) => store.get(key),
      put: (key: string, body: Uint8Array, metadata?: import("./object-store").ObjectMetadata) =>
        store.put(key, body, metadata),
      head: (key: string) => store.head(key),
      list: async () => {
        throw new Error("R2_LIST_500");
      },
    };
    const result = await runTenMinHistory({
      root,
      store: failing,
      securities,
      loadDailyBarSessions: everyDay("AAA", "BBB"),
      windowStart: "2024-10-07",
      lastCompletedSession: "2025-01-06",
      maxRanges: 1,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages: async (s, f, t) => {
        fetches += 1;
        return pagesFor(s, f, t);
      },
    });
    assert.equal(result.report.stoppedOnError, true);
    assert.match(result.report.error ?? "", /R2_LIST_500/);
    assert.equal(fetches, 0);
    assert.equal(result.report.massiveRequests, 0);
  });
});

test("empty universe or no daily coverage never seals: run stops with the error and zero fetches", async () => {
  await withRoot(async (root) => {
    // Production-shaped master: no listing dates, first-seen dates in 2026 only.
    const firstSeenOnly = master("LATE", {
      firstSeenAt: "2026-10-02T00:00:00.000Z",
      history: [{ symbol: "LATE", effectiveFrom: "2026-10-02", source: PROVIDER }],
    });
    const cases = [
      // Bars exist but no master record gives a ticker: nothing to fetch.
      { securities: [], loader: everyDay("ORPHAN"), code: TENMIN_UNIVERSE_EMPTY, planned: 1 },
      // The production master with no stored daily bars: fail closed on coverage first.
      { securities: [firstSeenOnly], loader: monthLoader(new Map()), code: TENMIN_DAILY_COVERAGE_HOLE, planned: 0 },
    ];
    for (const { securities, loader, code, planned } of cases) {
      const store = new MemoryObjectClient();
      let fetches = 0;
      const result = await runTenMinHistory({
        root,
        store,
        securities,
        loadDailyBarSessions: loader,
        windowStart: "2024-10-07",
        lastCompletedSession: "2026-10-05",
        maxRanges: 2,
        zstdVersionProbe: pinnedZstd,
        env: {},
        nowIso: () => AT,
        fetchPages: async (s, f, t) => {
          fetches += 1;
          return pagesFor(s, f, t);
        },
      });
      assert.equal(fetches, 0);
      assert.equal(result.report.massiveRequests, 0);
      assert.equal(result.report.stoppedOnError, true);
      assert.match(result.report.error ?? "", new RegExp(`^${code}:2024-11-01_2024-12-31`));
      // Stops at the first range; the second is never attempted.
      assert.equal(result.report.ranges.length, 1);
      assert.equal(result.report.ranges[0]?.status, "ERROR");
      assert.equal(result.report.ranges[0]?.fetchesPlanned, 0);
      assert.match(result.report.ranges[0]?.error ?? "", new RegExp(code));
      assert.equal(result.rangeResults.length, 0);
      assert.equal(await store.get(tenMinRangeManifestKey("2024-11-01", "2024-12-31")), undefined);
      assert.equal(await readTenMinRangeManifest(store, "2024-11-01", "2024-12-31"), undefined);
      // The stored run report carries the error too.
      const reportKey = (await store.list("transient/tenmin-history-runs/"))[0]!;
      const stored = JSON.parse(new TextDecoder().decode(await store.get(reportKey))) as {
        stoppedOnError: boolean;
        error?: string;
        ranges: Array<{ status: string }>;
      };
      assert.equal(stored.stoppedOnError, true);
      assert.match(stored.error ?? "", new RegExp(code));
      assert.equal(stored.ranges[0]?.status, "ERROR");
      // Host summary line shows the per-range status and plan sizes.
      const summary = tenMinHistorySummary(result.report);
      assert.equal(summary.mode, "tenmin-history");
      assert.deepEqual((summary.ranges as unknown[])[0], {
        range: "2024-11-01_2024-12-31",
        status: "ERROR",
        delistedCoverage: "MISSING",
        securitiesPlanned: planned,
        fetchesPlanned: 0,
        error: result.report.ranges[0]?.error,
      });
      assert.match(String(summary.error), new RegExp(code));
    }
  });
});

async function sealEmptyManifest(store: MemoryObjectClient, from = "2024-10-01", to = "2024-11-30"): Promise<void> {
  // What the bad first production run left behind: a manifest sealed with nothing in it.
  await writeTenMinRangeManifest(store, buildTenMinRangeManifest({ provider: PROVIDER, from, to, securities: [] }));
}

test("reader refuses a manifest sealed with 0 securities; a normal sealed manifest still reads", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    await sealEmptyManifest(store);
    await assert.rejects(() => readTenMinRangeManifest(store, "2024-10-01", "2024-11-30"), /TENMIN_UNIVERSE_EMPTY/);
    await assert.rejects(() => readRangeReplies(store, "2024-10-01", "2024-11-30", id("AAA")), /TENMIN_UNIVERSE_EMPTY/);
    await assert.rejects(
      () => readRangeSecurityDay(store, "2024-10-01", "2024-11-30", id("AAA"), "2024-10-28"),
      /TENMIN_UNIVERSE_EMPTY/,
    );
    // The writer never seals an empty range itself.
    const other = new MemoryObjectClient();
    await assert.rejects(
      () =>
        writeTenMinRangeReplyDust({
          store: other,
          root,
          provider: PROVIDER,
          from: "2024-12-01",
          to: "2025-01-31",
          fetches: [],
          zstdVersionProbe: pinnedZstd,
          fetchPages: async () => {
            throw new Error("unexpected fetch");
          },
        }),
      /TENMIN_UNIVERSE_EMPTY/,
    );
    assert.equal(await other.get(tenMinRangeManifestKey("2024-12-01", "2025-01-31")), undefined);
    // A normal sealed manifest reads fine.
    await writeTenMinRangeReplyDust({
      store: other,
      root,
      provider: PROVIDER,
      from: "2024-12-01",
      to: "2025-01-31",
      fetches: [{ securityId: id("AAA"), symbol: "AAA", fetchFrom: "2024-12-02", fetchTo: "2025-01-31" }],
      zstdVersionProbe: pinnedZstd,
      fetchPages: (s, f, t) => Promise.resolve(pagesFor(s, f, t)),
    });
    const manifest = (await readTenMinRangeManifest(other, "2024-12-01", "2025-01-31"))!;
    assert.equal(manifest.securityCount, 1);
    assert.equal((await readRangeReplies(other, "2024-12-01", "2025-01-31", id("AAA"))).length, 1);
  });
});

test("a range sealed earlier with 0 securities is not a seal: runs (and reopen) plan every member", async () => {
  for (const reopen of [false, true]) {
    await withRoot(async (root) => {
      const store = new MemoryObjectClient();
      await sealEmptyManifest(store, "2024-11-01", "2024-12-31");
      const fetched: string[] = [];
      const result = await runTenMinHistory({
        root,
        store,
        securities: [master("AAA"), master("BBB")],
        loadDailyBarSessions: everyDay("AAA", "BBB"),
        windowStart: "2024-10-07",
        lastCompletedSession: "2025-01-06",
        maxRanges: 1,
        reopen,
        writeReport: false,
        zstdVersionProbe: pinnedZstd,
        env: {},
        nowIso: () => AT,
        fetchPages: async (s, f, t) => {
          fetched.push(`${s.symbol}:${f}_${t}`);
          return pagesFor(s, f, t);
        },
      });
      assert.equal(result.report.ranges[0]?.status, reopen ? "REOPENED" : "SEALED");
      assert.deepEqual(fetched.sort(), ["AAA:2024-11-01_2024-12-31", "BBB:2024-11-01_2024-12-31"]);
      const manifest = (await readTenMinRangeManifest(store, "2024-11-01", "2024-12-31"))!;
      assert.equal(manifest.securityCount, 2);
    });
  }
});

// ---- Point-in-time universe from stored daily bars ----

const OCT_NOV = { from: "2024-10-07", to: "2024-11-30" };

test("daily-bar index keeps only securityId and sessionDate, line by line", () => {
  const line = (securityId: string, sessionDate: string, revision: number) =>
    JSON.stringify({ close: 1, flags: ["MASSIVE_GROUPED_DAILY"], revision, securityId, sessionDate, volume: 5 });
  const body = new TextEncoder().encode(
    [line("A", "2024-10-07", 1), "", line("A", "2024-10-07", 2), line("B", "2024-10-08", 1)].join("\n") + "\n",
  );
  const index = indexDailyBarSessions(body);
  assert.deepEqual([...index.entries()].map(([k, v]) => [k, [...v]]), [
    ["A", ["2024-10-07"]],
    ["B", ["2024-10-08"]],
  ]);
  assert.throws(() => indexDailyBarSessions(new TextEncoder().encode('{"securityId":"A"}\n')), /DAILY_BARS_LINE_INVALID/);
});

test("storage month loaders index one month file (object store and local)", async () => {
  await withRoot(async (root) => {
    const bar = (symbol: string, sessionDate: string) => ({
      securityId: id(symbol),
      sessionDate,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      observedAt: AT,
      ingestedAt: AT,
      dataQuality: "GOOD" as const,
      corporateActionIds: [],
      flags: ["MASSIVE_GROUPED_DAILY"],
      schemaVersion: "markets-scanner-v1" as const,
      revision: 1,
      provenance: { provider: PROVIDER, retrievalId: "x", providerTimestamp: AT },
    });
    const { ObjectMarketStorage } = await import("./object-storage");
    const { MarketStorage } = await import("./storage");
    const records = [bar("AAA", "2024-10-07"), bar("AAA", "2024-10-08"), bar("BBB", "2024-11-01")] as unknown as import("./contracts").CanonicalDailyBar[];
    for (const storage of [new ObjectMarketStorage(new MemoryObjectClient()), new MarketStorage(root)]) {
      await storage.initialize();
      await storage.appendBars(records);
      const october = await storage.loadDailyBarSessions("2024-10");
      assert.deepEqual([...october.keys()], [id("AAA")]);
      assert.deepEqual([...october.get(id("AAA"))!].sort(), ["2024-10-07", "2024-10-08"]);
      assert.deepEqual([...(await storage.loadDailyBarSessions("2024-11")).keys()], [id("BBB")]);
      assert.equal((await storage.loadDailyBarSessions("2024-12")).size, 0);
    }
  });
});

test("universe from crafted daily bars: two months, an October-only delisting, a holiday gap", async () => {
  const all = sessions(OCT_NOV.from, OCT_NOV.to);
  assert.ok(!all.includes("2024-11-28"), "Thanksgiving is not a session");
  assert.ok(all.includes("2024-11-29"), "the half day is a session");
  const loaded: string[] = [];
  const index = barsIndex([
    [id("AAA"), all],
    // Delisted at the end of October: only October bars are stored.
    [id("DLST"), all.filter((d) => d <= "2024-10-31")],
    // Missing its own bars around Thanksgiving; the range coverage is still complete.
    [id("HOL"), all.filter((d) => d !== "2024-11-27" && d !== "2024-11-29")],
    // Starts mid-range: the fetch span is its first to last stored session.
    [id("MID"), all.filter((d) => d >= "2024-10-15" && d <= "2024-11-12")],
    // Outside the clamped window: ignored.
    [id("EARLY"), ["2024-10-01", "2024-10-04"]],
  ]);
  const securities = ["AAA", "DLST", "HOL", "MID", "EARLY"].map((s) =>
    master(s, { firstSeenAt: "2026-10-02", history: [{ symbol: s, effectiveFrom: "2026-10-02", source: PROVIDER }] }),
  );
  const bars = await loadDailyBarSessionsForRange(monthLoader(index, loaded), OCT_NOV.from, OCT_NOV.to);
  assert.deepEqual(loaded, ["2024-10", "2024-11"]);
  const plan = universeForTenMinRange(securities, bars, OCT_NOV.from, OCT_NOV.to, { nowIso: AT });
  assert.equal(plan.refusal, undefined);
  assert.deepEqual(plan.missingSessions, []);
  assert.equal(plan.tradingSessions.length, all.length);
  assert.deepEqual(
    plan.fetches.map((f) => [f.symbol, f.fetchFrom, f.fetchTo]),
    [
      ["AAA", "2024-10-07", "2024-11-29"],
      ["DLST", "2024-10-07", "2024-10-31"],
      ["HOL", "2024-10-07", "2024-11-26"],
      ["MID", "2024-10-15", "2024-11-12"],
    ].sort((a, b) => (id(a[0]!) < id(b[0]!) ? -1 : 1)),
  );
  assert.equal(plan.noDailyBarCount, 1);
  assert.deepEqual(plan.noDailyBarSample, [id("EARLY")]);
  assert.equal(plan.securityLink, "PROVISIONAL");
  assert.equal(plan.linkSource, "provisional-master-2026-10-05");
});

test("coverage hole: a trading session with zero stored bars refuses to fetch or seal", async () => {
  await withRoot(async (root) => {
    const all = sessions("2024-10-07", "2024-12-31").filter((d) => d !== "2024-11-05");
    const loader = monthLoader(barsIndex([[id("AAA"), all], [id("BBB"), all]]));
    const plan = universeForTenMinRange(
      [master("AAA"), master("BBB")],
      await loadDailyBarSessionsForRange(loader, OCT_NOV.from, OCT_NOV.to),
      OCT_NOV.from,
      OCT_NOV.to,
    );
    assert.deepEqual(plan.missingSessions, ["2024-11-05"]);
    assert.equal(plan.refusal?.code, TENMIN_DAILY_COVERAGE_HOLE);
    assert.match(plan.refusal?.message ?? "", /missing=2024-11-05$/);
    const store = new MemoryObjectClient();
    let fetches = 0;
    const result = await runTenMinHistory({
      root,
      store,
      securities: [master("AAA"), master("BBB")],
      loadDailyBarSessions: loader,
      windowStart: "2024-10-07",
      lastCompletedSession: "2026-10-05",
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages: async (s, f, t) => {
        fetches += 1;
        return pagesFor(s, f, t);
      },
    });
    assert.equal(fetches, 0);
    assert.equal(result.report.stoppedOnError, true);
    assert.match(result.report.error ?? "", /^TENMIN_DAILY_COVERAGE_HOLE:.*2024-11-05/);
    assert.deepEqual(result.report.ranges[0]?.coverage?.missingSessions, ["2024-11-05"]);
    assert.equal(result.report.ranges.length, 1);
    assert.equal(await store.get(tenMinRangeManifestKey("2024-11-01", "2024-12-31")), undefined);
  });
});

test("universe smaller than TENMIN_MIN_UNIVERSE_RATIO x median per session refuses to seal", () => {
  assert.equal(TENMIN_MIN_UNIVERSE_RATIO, 0.8);
  const all = sessions(OCT_NOV.from, OCT_NOV.to);
  const symbols = Array.from({ length: 10 }, (_, i) => `S${i}`);
  const bars = barsIndex(symbols.map((s) => [id(s), all]));
  const median = 10;
  // Crafted bug: only some bar securities resolve to a master ticker.
  const needed = Math.ceil(TENMIN_MIN_UNIVERSE_RATIO * median);
  const short = universeForTenMinRange(
    symbols.slice(0, needed - 1).map((s) => master(s)),
    bars,
    OCT_NOV.from,
    OCT_NOV.to,
  );
  assert.equal(short.medianSecuritiesPerSession, median);
  assert.equal(short.securities.length, needed - 1);
  assert.equal(short.refusal?.code, TENMIN_UNIVERSE_TOO_SMALL);
  assert.match(short.refusal?.message ?? "", new RegExp(`planned=${needed - 1}:median=${median}:ratio=0.8`));
  const enough = universeForTenMinRange(
    symbols.slice(0, needed).map((s) => master(s)),
    bars,
    OCT_NOV.from,
    OCT_NOV.to,
  );
  assert.equal(enough.refusal, undefined);
  assert.equal(enough.gaps.filter((g) => g.reason === "NO_HISTORICAL_SYMBOL").length, median - needed);
});

test("NO_DAILY_BAR: master securities without a stored bar are a counted known gap (sample of 50)", async () => {
  await withRoot(async (root) => {
    const extra = Array.from({ length: 60 }, (_, i) => master(`ND${String(i).padStart(2, "0")}`));
    const securities = [master("AAA"), ...extra];
    const result = await runTenMinHistory({
      root,
      store: new MemoryObjectClient(),
      securities,
      loadDailyBarSessions: everyDay("AAA"),
      windowStart: "2024-10-07",
      lastCompletedSession: "2025-01-06",
      maxRanges: 1,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages: (s, f, t) => Promise.resolve(pagesFor(s, f, t)),
    });
    const range = result.report.ranges[0]!;
    assert.equal(range.status, "SEALED");
    assert.equal(range.noDailyBar?.reason, "NO_DAILY_BAR");
    assert.equal(range.noDailyBar?.count, 60);
    assert.equal(range.noDailyBar?.sampleSecurityIds.length, 50);
    assert.deepEqual(
      range.noDailyBar?.sampleSecurityIds,
      extra.map((s) => s.securityId).sort().slice(0, 50),
    );
    assert.equal(range.fetchesPlanned, 1);
  });
});

test("provisional link: rd-link on written objects, securityLink in manifest and report; resume accepts objects without it", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    // An object written earlier without rd-link (older writer).
    await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: "2024-11-01",
      to: "2024-12-31",
      fetches: [{ securityId: id("OLDW"), symbol: "OLDW", fetchFrom: "2024-11-01", fetchTo: "2024-12-31" }],
      zstdVersionProbe: pinnedZstd,
      fetchPages: (s, f, t) => Promise.resolve(pagesFor(s, f, t)),
    });
    await store.delete(tenMinRangeManifestKey("2024-11-01", "2024-12-31"));
    const fetched: string[] = [];
    const result = await runTenMinHistory({
      root,
      store,
      securities: [master("AAA"), master("OLDW")],
      loadDailyBarSessions: everyDay("AAA", "OLDW"),
      windowStart: "2024-10-07",
      lastCompletedSession: "2025-01-06",
      maxRanges: 1,
      zstdVersionProbe: pinnedZstd,
      env: {},
      nowIso: () => AT,
      fetchPages: async (s, f, t) => {
        fetched.push(s.symbol);
        return pagesFor(s, f, t);
      },
    });
    assert.deepEqual(fetched, ["AAA"]);
    assert.equal(result.report.ranges[0]?.securitiesResumed, 1);
    assert.equal(result.report.securityLink, "PROVISIONAL");
    assert.equal(result.report.ranges[0]?.securityLink, "PROVISIONAL");
    const keys = (await store.list("permanent/tenmin-reply-dust/2024-11-01_2024-12-31/")).filter((k) =>
      k.endsWith(".rdust"),
    );
    const heads = await Promise.all(keys.map(async (k) => [k, (await store.head(k))!.metadata] as const));
    const aaa = heads.find(([k]) => k.includes(Buffer.from(id("AAA")).toString("base64url")))!;
    assert.equal(aaa[1]["rd-link"], "provisional-master-2026-10-05");
    const old = heads.find(([k]) => k.includes(Buffer.from(id("OLDW")).toString("base64url")))!;
    assert.equal(old[1]["rd-link"], undefined);
    const manifest = (await readTenMinRangeManifest(store, "2024-11-01", "2024-12-31"))!;
    assert.equal(manifest.securityLink, "PROVISIONAL");
    assert.equal(manifest.securityLinkSource, "provisional-master-2026-10-05");
    assert.deepEqual(
      manifest.securities.map((s) => s.securityLink),
      ["PROVISIONAL", "PROVISIONAL"],
    );
  });
});

test("reused ticker: the fetch uses the ticker and dates the backfill stored, not the old holder", () => {
  // In 2024 the ticker ABC belonged to OldCo (delisted 2025). Today ABC is NewCo's current symbol.
  // The backfill bound every grouped-daily row by today's currentSymbol, so 2024 ABC rows were
  // stored under NewCo's securityId. To stay consistent with those stored bars, the 10-minute
  // fetch for NewCo is ticker ABC over exactly the dates NewCo has stored bars. OldCo has no stored
  // bars (its former symbol was never bound), so it is a NO_DAILY_BAR known gap, not a fetch.
  const newCo = master("ABC", {
    securityId: id("NEWCO"),
    firstSeenAt: "2026-10-02",
    history: [{ symbol: "ABC", effectiveFrom: "2026-10-02", source: PROVIDER }],
  });
  const oldCo = master("ABCQ", {
    securityId: id("OLDCO"),
    firstSeenAt: "2026-10-03",
    status: "INACTIVE",
    history: [
      { symbol: "ABC", effectiveFrom: "2015-01-01", effectiveTo: "2025-03-01", source: PROVIDER },
      { symbol: "ABCQ", effectiveFrom: "2026-10-03", effectiveTo: "2026-10-03", source: PROVIDER },
    ],
  });
  const stored = sessions("2024-10-21", "2024-11-22");
  const others = sessions(OCT_NOV.from, OCT_NOV.to);
  const plan = universeForTenMinRange(
    [newCo, oldCo, master("AAA")],
    barsIndex([[id("NEWCO"), stored], [id("AAA"), others]]),
    OCT_NOV.from,
    OCT_NOV.to,
  );
  assert.equal(plan.refusal, undefined);
  assert.deepEqual(plan.securities.find((s) => s.securityId === id("NEWCO"))?.fetches, [
    { securityId: id("NEWCO"), symbol: "ABC", fetchFrom: "2024-10-21", fetchTo: "2024-11-22" },
  ]);
  assert.ok(!plan.fetches.some((f) => f.securityId === id("OLDCO")));
  assert.deepEqual(plan.noDailyBarSample, [id("OLDCO")]);
});

// ---- Fixed first range and AGED_OUT ----

test("a run on 2026-10-06 starts at 2024-11-01_2024-12-31 and records the skipped Oct 2024 days", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const fetched: string[] = [];
    const result = await runTenMinHistory({
      root,
      store,
      securities: [master("AAA")],
      loadDailyBarSessions: everyDay("AAA"),
      now: new Date("2026-10-06T12:00:00.000Z"),
      maxRanges: 1,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages: async (s, f, t) => {
        fetched.push(`${s.symbol}:${f}_${t}`);
        return pagesFor(s, f, t);
      },
    });
    assert.equal(result.report.lastCompletedSession, "2026-10-05");
    assert.equal(result.report.ranges[0]?.calendarFrom, "2024-11-01");
    assert.equal(result.report.ranges[0]?.calendarTo, "2024-12-31");
    assert.equal(result.report.ranges[0]?.fetchFrom, "2024-11-01");
    assert.equal(result.report.ranges[0]?.status, "SEALED");
    assert.deepEqual(fetched, ["AAA:2024-11-01_2024-12-31"]);
    assert.deepEqual(result.report.skippedBeforeFirstRange, {
      from: "2024-10-07",
      to: "2024-10-31",
      reason: "SKIPPED_BEFORE_FIRST_RANGE",
    });
    assert.equal(result.report.stoppedOnError, false);
    assert.equal(result.report.error, undefined);
  });
});

test("the old 2024-10-01_2024-11-30 folder (empty sealed manifest) is never read or written", async () => {
  await withRoot(async (root) => {
    const inner = new MemoryObjectClient();
    await sealEmptyManifest(inner);
    const before = await inner.get(tenMinRangeManifestKey("2024-10-01", "2024-11-30"));
    const touched: string[] = [];
    const old = "permanent/tenmin-reply-dust/2024-10-01_2024-11-30";
    const note = (op: string, key: string) => {
      if (key.startsWith(old) || old.startsWith(key)) touched.push(`${op}:${key}`);
    };
    const store = {
      get: (key: string) => (note("get", key), inner.get(key)),
      put: (key: string, body: Uint8Array, metadata?: import("./object-store").ObjectMetadata) => (
        note("put", key), inner.put(key, body, metadata)
      ),
      head: (key: string) => (note("head", key), inner.head(key)),
      list: (prefix: string) => (note("list", prefix), inner.list(prefix)),
    };
    for (const reopen of [false, true])
      await runTenMinHistory({
        root,
        store,
        securities: [master("AAA")],
        loadDailyBarSessions: everyDay("AAA"),
        lastCompletedSession: "2026-10-05",
        maxRanges: 2,
        reopen,
        writeReport: false,
        zstdVersionProbe: pinnedZstd,
        env: {},
        fetchPages: (s, f, t) => Promise.resolve(pagesFor(s, f, t)),
      });
    assert.deepEqual(touched, []);
    assert.deepEqual(await inner.get(tenMinRangeManifestKey("2024-10-01", "2024-11-30")), before);
  });
});

test("AGED_OUT: window start inside an unsealed range clamps the fetch, records the dropped days, and seals", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const fetched: string[] = [];
    const run = (reopen: boolean) =>
      runTenMinHistory({
        root,
        store,
        securities: [master("AAA"), master("BBB")],
        loadDailyBarSessions: everyDay("AAA", "BBB"),
        // Effective window = max(2024-11-10, 2026-10-05 - 2y + 2d) = 2024-11-10.
        windowStart: "2024-11-10",
        lastCompletedSession: "2026-10-05",
        maxRanges: 1,
        reopen,
        writeReport: false,
        zstdVersionProbe: pinnedZstd,
        env: {},
        nowIso: () => AT,
        fetchPages: async (s, f, t) => {
          fetched.push(`${s.symbol}:${f}_${t}`);
          return pagesFor(s, f, t);
        },
      });
    const first = await run(false);
    const range = first.report.ranges[0]!;
    assert.equal(range.calendarFrom, "2024-11-01");
    assert.equal(range.fetchFrom, "2024-11-10");
    // Recorded as the calendar date span (not a trading-session list).
    assert.deepEqual(range.agedOut, { from: "2024-11-01", to: "2024-11-09" });
    assert.equal(range.status, "SEALED");
    // 2024-11-10 is a Sunday: fetches start at the first stored session on or after it.
    assert.deepEqual(fetched.sort(), ["AAA:2024-11-11_2024-12-31", "BBB:2024-11-11_2024-12-31"]);
    const agedGap = { securityId: "", symbol: "", reason: "AGED_OUT", at: AT, fetchFrom: "2024-11-01", fetchTo: "2024-11-09" };
    assert.deepEqual(range.gaps, [agedGap]);
    const manifest = (await readTenMinRangeManifest(store, "2024-11-01", "2024-12-31"))!;
    assert.deepEqual(manifest.gaps, [agedGap]);
    assert.equal(manifest.securityCount, 2);
    // Reopen never retries AGED_OUT and keeps a single record.
    fetched.length = 0;
    const reopened = await run(true);
    assert.equal(reopened.report.ranges[0]?.status, "REOPENED");
    assert.deepEqual(fetched, []);
    assert.deepEqual(
      (await readTenMinRangeManifest(store, "2024-11-01", "2024-12-31"))!.gaps.filter((g) => g.reason === "AGED_OUT"),
      [agedGap],
    );
  });
});

test("requests made before an abort are counted in the range and run reports", async () => {
  await withRoot(async (root) => {
    const inner = new MemoryObjectClient();
    const store = {
      get: (key: string) => inner.get(key),
      head: (key: string) => inner.head(key),
      list: (prefix: string) => inner.list(prefix),
      put: async (key: string, body: Uint8Array, metadata?: import("./object-store").ObjectMetadata) => {
        if (key.endsWith(".rdust")) throw new Error("REPLY_DUST_METADATA_READBACK_MISMATCH:test");
        return inner.put(key, body, metadata);
      },
    };
    let fetches = 0;
    const result = await runTenMinHistory({
      root,
      store,
      securities: [master("AAA"), master("BBB")],
      loadDailyBarSessions: everyDay("AAA", "BBB"),
      lastCompletedSession: "2026-10-05",
      maxRanges: 1,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages: async (s, f, t) => {
        fetches += 1;
        return pagesFor(s, f, t);
      },
    });
    assert.equal(fetches, 1);
    assert.equal(result.report.stoppedOnError, true);
    assert.match(result.report.error ?? "", /REPLY_DUST_METADATA_READBACK_MISMATCH/);
    assert.equal(result.report.massiveRequests, 1);
    assert.equal(result.report.ranges[0]?.status, "ERROR");
    assert.equal(result.report.ranges[0]?.massiveRequests, 1);
    assert.equal(tenMinHistorySummary(result.report).massiveRequests, 1);
  });
});

// ---- delistedCoverage ----

test("delistedCoverage MISSING is on each range report entry and the sealed manifest", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const result = await runTenMinHistory({
      root,
      store,
      securities: [master("AAA")],
      loadDailyBarSessions: everyDay("AAA"),
      lastCompletedSession: "2026-10-05",
      maxRanges: 2,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages: (s, f, t) => Promise.resolve(pagesFor(s, f, t)),
    });
    assert.deepEqual(result.report.ranges.map((r) => [r.status, r.delistedCoverage]), [
      ["SEALED", "MISSING"],
      ["SEALED", "MISSING"],
    ]);
    assert.equal((tenMinHistorySummary(result.report).ranges as Array<{ delistedCoverage: string }>)[0]?.delistedCoverage, "MISSING");
    const raw = JSON.parse(
      new TextDecoder().decode(await store.get(tenMinRangeManifestKey("2024-11-01", "2024-12-31"))),
    ) as { delistedCoverage?: string };
    assert.equal(raw.delistedCoverage, TENMIN_DELISTED_COVERAGE_MISSING);
    assert.equal((await readTenMinRangeManifest(store, "2024-11-01", "2024-12-31"))!.delistedCoverage, "MISSING");
  });
});

/** Rewrite a sealed manifest the way the pre-field writer (6b57850) left it: no delistedCoverage. */
async function rewriteAsOldFormat(store: MemoryObjectClient, from: string, to: string): Promise<void> {
  const current = (await readTenMinRangeManifest(store, from, to))!;
  const old = buildTenMinRangeManifest({
    provider: current.provider,
    from,
    to,
    securities: current.securities,
    gaps: current.gaps,
    ...(current.securityLink
      ? { securityLink: { status: current.securityLink, source: current.securityLinkSource! } }
      : {}),
  });
  assert.equal("delistedCoverage" in old, false);
  await writeTenMinRangeManifest(store, old);
}

test("an old-format manifest without delistedCoverage reads as MISSING, resumes with 0 refetches, and gains the field on its next write", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    let fetches = 0;
    const run = (reopen: boolean) =>
      runTenMinHistory({
        root,
        store,
        securities: [master("AAA"), master("BBB")],
        loadDailyBarSessions: everyDay("AAA", "BBB"),
        lastCompletedSession: "2025-01-06",
        maxRanges: 1,
        reopen,
        writeReport: false,
        zstdVersionProbe: pinnedZstd,
        env: {},
        fetchPages: async (s, f, t) => {
          fetches += 1;
          return pagesFor(s, f, t);
        },
      });
    await run(false);
    assert.equal(fetches, 2);
    await rewriteAsOldFormat(store, "2024-11-01", "2024-12-31");
    const key = tenMinRangeManifestKey("2024-11-01", "2024-12-31");
    const oldBytes = await store.get(key);
    assert.ok(!new TextDecoder().decode(oldBytes).includes("delistedCoverage"));
    // Readers keep reading it and expose MISSING.
    const read = (await readTenMinRangeManifest(store, "2024-11-01", "2024-12-31"))!;
    assert.equal(tenMinRangeDelistedCoverage(read), "MISSING");
    assert.equal(read.delistedCoverage, "MISSING");
    assert.equal((await readRangeReplies(store, "2024-11-01", "2024-12-31", id("AAA"))).length, 1);
    // A normal run leaves the sealed range alone and reports MISSING.
    fetches = 0;
    const skipped = await run(false);
    assert.equal(skipped.report.ranges[0]?.status, "ALREADY_SEALED");
    assert.equal(skipped.report.ranges[0]?.delistedCoverage, "MISSING");
    assert.equal(fetches, 0);
    assert.deepEqual(await store.get(key), oldBytes);
    // Reopen resumes every stored fetch (0 refetches) and the rewritten manifest has the field.
    const reopened = await run(true);
    assert.equal(reopened.report.ranges[0]?.status, "REOPENED");
    assert.equal(fetches, 0);
    const raw = JSON.parse(new TextDecoder().decode(await store.get(key))) as { delistedCoverage?: string; securityCount: number };
    assert.equal(raw.delistedCoverage, "MISSING");
    assert.equal(raw.securityCount, 2);
  });
});

test("an in-progress range written before the field existed resumes with 0 refetches and seals with it", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    // Objects and local progress from a partial run, no manifest yet (like the run on 6b57850).
    const partial = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: "2024-11-01",
      to: "2024-12-31",
      fetches: [
        { securityId: id("AAA"), symbol: "AAA", fetchFrom: "2024-11-01", fetchTo: "2024-12-31" },
        { securityId: id("BBB"), symbol: "BBB", fetchFrom: "2024-11-01", fetchTo: "2024-12-31" },
      ],
      zstdVersionProbe: pinnedZstd,
      shouldYield: (() => {
        let n = 0;
        return async () => (++n > 1 ? "SCAN_GUARD_WINDOW:test" : undefined);
      })(),
      fetchPages: (s, f, t) => Promise.resolve(pagesFor(s, f, t)),
    });
    assert.equal(partial.sealed, false);
    const fetched: string[] = [];
    const result = await runTenMinHistory({
      root,
      store,
      securities: [master("AAA"), master("BBB")],
      loadDailyBarSessions: everyDay("AAA", "BBB"),
      lastCompletedSession: "2025-01-06",
      maxRanges: 1,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages: async (s, f, t) => {
        fetched.push(s.symbol);
        return pagesFor(s, f, t);
      },
    });
    assert.deepEqual(fetched, ["BBB"]);
    assert.equal(result.report.ranges[0]?.securitiesResumed, 1);
    assert.equal(result.report.ranges[0]?.delistedCoverage, "MISSING");
    assert.equal((await readTenMinRangeManifest(store, "2024-11-01", "2024-12-31"))!.delistedCoverage, "MISSING");
  });
});
