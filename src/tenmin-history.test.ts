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
  universeForTenMinRange,
} from "./tenmin-history";
import {
  readTenMinRangeManifest,
  tenMinRangeManifestKey,
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

test("planTenMinHistoryRanges: stable calendar folders, clamp fetchFrom, skip earlier pairs", () => {
  const onOct6 = planTenMinHistoryRanges({
    windowStart: "2024-10-07",
    lastCompletedSession: "2026-10-05",
  });
  assert.equal(onOct6.windowStart, "2024-10-07");
  assert.deepEqual(onOct6.ranges[0], {
    calendarFrom: "2024-10-01",
    calendarTo: "2024-11-30",
    fetchFrom: "2024-10-07",
    fetchTo: "2024-11-30",
  });
  assert.deepEqual(onOct6.ranges[1], {
    calendarFrom: "2024-12-01",
    calendarTo: "2025-01-31",
    fetchFrom: "2024-12-01",
    fetchTo: "2025-01-31",
  });
  assert.ok(onOct6.ranges.every((r) => r.calendarTo < "2026-10-05"));
  assert.equal(onOct6.ranges.at(-1)?.calendarTo, "2026-09-30");

  // Later day: clamp moves; folder identity for Oct-Nov stays 2024-10-01_2024-11-30.
  const onOct20 = planTenMinHistoryRanges({
    windowStart: "2024-10-07",
    lastCompletedSession: "2026-10-19",
  });
  assert.equal(onOct20.windowStart, "2024-10-21");
  assert.deepEqual(onOct20.ranges[0], {
    calendarFrom: "2024-10-01",
    calendarTo: "2024-11-30",
    fetchFrom: "2024-10-21",
    fetchTo: "2024-11-30",
  });

  // Range entirely before window is skipped.
  const withSkip = planTenMinHistoryRanges({
    windowStart: "2024-08-01",
    lastCompletedSession: "2026-10-05",
  });
  // effective window is still max(2024-08-01, 2024-10-07) = 2024-10-07
  assert.equal(withSkip.windowStart, "2024-10-07");
  assert.ok(
    withSkip.skippedBefore.some(
      (r) => r.calendarFrom === "2024-08-01" && r.calendarTo === "2024-09-30",
    ),
  );
  assert.ok(!withSkip.ranges.some((r) => r.calendarFrom === "2024-08-01"));
});

test("lastCompletedSessionDate is the prior eligible ET session", () => {
  assert.equal(lastCompletedSessionDate(new Date("2026-10-06T12:00:00.000Z")), "2026-10-05");
  assert.equal(lastCompletedSessionDate(new Date("2026-10-10T18:00:00.000Z")), "2026-10-09");
});

test("universe plans every overlapping historical ticker over its own sub-span", () => {
  const active = master("NEW", {
    listingDate: "2023-01-01",
    history: [
      { symbol: "OLD", effectiveFrom: "2023-01-01", effectiveTo: "2024-11-25", source: PROVIDER },
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
  const plan = universeForTenMinRange([active, delisted], "2024-10-07", "2024-11-30", AT);
  const newFetches = plan.securities.find((s) => s.securityId === id("NEW"))!.fetches;
  assert.deepEqual(
    newFetches.map((f) => [f.symbol, f.fetchFrom, f.fetchTo]),
    [
      ["OLD", "2024-10-07", "2024-11-25"],
      ["NEW", "2024-11-26", "2024-11-30"],
    ],
  );
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
    // Day 1: window starts 2024-10-07
    const first = await runTenMinHistory({
      root,
      store,
      securities,
      windowStart: "2024-10-07",
      lastCompletedSession: "2026-10-05",
      maxRanges: 1,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages,
    });
    assert.equal(first.report.ranges[0]?.calendarFrom, "2024-10-01");
    assert.equal(first.report.ranges[0]?.fetchFrom, "2024-10-07");
    assert.ok(await store.get(tenMinRangeManifestKey("2024-10-01", "2024-11-30")));
    const keysAfter = await store.list("permanent/tenmin-reply-dust/");
    ordered.length = 0;
    // Day 2: clamp moved to 2024-10-21 — same folder, already sealed → zero fetches.
    const second = await runTenMinHistory({
      root,
      store,
      securities,
      windowStart: "2024-10-07",
      lastCompletedSession: "2026-10-19",
      maxRanges: 1,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages,
    });
    assert.equal(second.report.windowStart, "2024-10-21");
    assert.equal(second.report.ranges[0]?.calendarFrom, "2024-10-01");
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
      windowStart: "2024-10-07",
      lastCompletedSession: "2025-04-15",
      maxRanges: 3,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages: async (s, from, to) => {
        order.push(`${from}_${to}`);
        return pagesFor(s, from, to);
      },
    });
    assert.deepEqual(order, [
      "2024-10-07_2024-11-30",
      "2024-12-01_2025-01-31",
      "2025-02-01_2025-03-31",
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
      windowStart: "2024-10-07",
      lastCompletedSession: "2024-12-01",
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
      windowStart: "2024-10-07",
      lastCompletedSession: "2024-12-01",
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
      windowStart: "2024-10-07",
      lastCompletedSession: "2024-12-01",
      maxRanges: 1,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchPages: (s, f, t) => Promise.resolve(pagesFor(s, f, t)),
    });
    // Unseal so the next run resumes from stored pages (list/verify path).
    await store.delete(tenMinRangeManifestKey("2024-10-01", "2024-11-30"));
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
      windowStart: "2024-10-07",
      lastCompletedSession: "2024-12-01",
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
