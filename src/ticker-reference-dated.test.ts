import assert from "node:assert/strict";
import test from "node:test";
import type { SecurityMasterRecord } from "./contracts";
import { MemoryObjectClient } from "./object-store";
import {
  loadTickerReferenceIndexAsOf,
} from "./tenmin-daily-picks-base";
import {
  MASSIVE_TICKER_PAGE_LIMIT,
} from "./massive-provider";
import {
  TICKER_INDEX_DATED_PROBE_DATE,
  TICKER_REFERENCE_DATED_OBJECT_CORRUPT,
  datedTickerManifestKey,
  datedTickerMonthStarts,
  datedTickerPageKey,
  loadCurrentMasterTickerSet,
  requestContainsApiKey,
  runDatedTickerIndexBuild,
  stripApiKeyFromUrl,
  tenMinDatedTickerSummary,
  tickerIndexDatedEnabled,
  tickerIndexDatedFullEnabled,
} from "./ticker-reference-dated";
import {
  TICKER_REFERENCE_INDEX_MANIFEST_KEY,
  listTickerReferenceIndexHistory,
} from "./ticker-reference-index";

const SETTLED = new Date("2026-10-06T18:00:00.000Z");
const clock = (): Date => SETTLED;

function masterRecord(
  currentSymbol: string,
  fields: Partial<SecurityMasterRecord> = {},
): SecurityMasterRecord {
  return {
    securityId: fields.securityId ?? `sid-${currentSymbol}`,
    currentSymbol: fields.currentSymbol ?? currentSymbol,
    historicalSymbols:
      fields.historicalSymbols ??
      [{ symbol: currentSymbol, effectiveFrom: "2020-01-01", source: "massive-stocks" }],
    assetType: fields.assetType ?? "STOCK",
    country: "US",
    exchange: fields.exchange ?? "XNAS",
    firstSeenAt: fields.firstSeenAt ?? "2020-01-01",
    ...(fields.listingDate ? { listingDate: fields.listingDate } : {}),
    ...(fields.inactiveAt ? { inactiveAt: fields.inactiveAt } : {}),
    ...(fields.delistedAt ? { delistedAt: fields.delistedAt } : {}),
    status: fields.status ?? "ACTIVE",
    tradable: fields.tradable ?? true,
    providerIdentities: fields.providerIdentities ?? [
      { provider: "massive-stocks", providerSecurityId: currentSymbol },
    ],
    eligibility: fields.eligibility ?? "LEVEL_0",
    barCount: fields.barCount ?? 0,
    lastUniverseSeenAt: fields.lastUniverseSeenAt ?? "2026-10-05",
  };
}

async function plantMaster(store: MemoryObjectClient, records: SecurityMasterRecord[]) {
  await store.put(
    "permanent/security-master.json",
    new TextEncoder().encode(JSON.stringify(records)),
  );
}


function pageBody(options: {
  tickers: Array<Record<string, unknown>>;
  nextUrl?: string;
  requestId?: string;
}): Uint8Array {
  const payload: Record<string, unknown> = {
    status: "OK",
    request_id: options.requestId ?? "req1",
    results: options.tickers,
    count: options.tickers.length,
  };
  if (options.nextUrl) payload.next_url = options.nextUrl;
  return new TextEncoder().encode(JSON.stringify(payload));
}

function rec(
  ticker: string,
  type: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ticker,
    name: `${ticker} Co`,
    market: "stocks",
    locale: "us",
    primary_exchange: "XNAS",
    type,
    active: true,
    currency_name: "usd",
    composite_figi: `BBG000${ticker}`,
    last_updated_utc: "2024-11-01T00:00:00Z",
    ...extra,
  };
}

test("switches: dated off by default; full only when exactly true", () => {
  assert.equal(tickerIndexDatedEnabled({}), false);
  assert.equal(tickerIndexDatedEnabled({ TICKER_INDEX_DATED: "1" }), false);
  assert.equal(tickerIndexDatedEnabled({ TICKER_INDEX_DATED: "true" }), true);
  assert.equal(tickerIndexDatedFullEnabled({}), false);
  assert.equal(tickerIndexDatedFullEnabled({ TICKER_INDEX_DATED_FULL: "true" }), true);
});

test("stripApiKeyFromUrl removes apiKey from absolute and relative URLs", () => {
  assert.equal(
    stripApiKeyFromUrl(
      "https://api.massive.com/v3/reference/tickers?cursor=abc&apiKey=SECRET&limit=1000",
    ),
    "/v3/reference/tickers?cursor=abc&limit=1000",
  );
  assert.ok(!requestContainsApiKey(stripApiKeyFromUrl("/v3/reference/tickers?apiKey=x&cursor=1")));
});

test("datedTickerMonthStarts: from 2024-11 through current; skips older than 2y", () => {
  const months = datedTickerMonthStarts(new Date("2026-10-06T12:00:00Z"));
  assert.equal(months[0], "2024-11-01");
  assert.equal(months[months.length - 1], "2026-10-01");
  assert.ok(!months.includes("2024-10-01"));
  // Far future now: floor is 2025-01-15 → 2025-01-01 skipped, first is 2025-02-01
  const later = datedTickerMonthStarts(new Date("2027-01-15T12:00:00Z"));
  assert.ok(!later.includes("2024-11-01"));
  assert.ok(!later.includes("2025-01-01"));
  assert.equal(later[0], "2025-02-01");
});

test("probe mode: exactly 1 request, stores page 1 with cursor and no apiKey; no index unless complete", async () => {
  const store = new MemoryObjectClient();
  let calls = 0;
  const next =
    "https://api.massive.com/v3/reference/tickers?cursor=p2&apiKey=LEAK&date=2024-11-01";
  const report = await runDatedTickerIndexBuild({
    store,
    env: { TICKER_INDEX_DATED: "true" },
    now: SETTLED,
    clock,
    fetchPage: async ({ date, nextUrl }) => {
      calls += 1;
      assert.equal(date, TICKER_INDEX_DATED_PROBE_DATE);
      assert.equal(nextUrl, undefined);
      return {
        status: 200,
        body: pageBody({
          tickers: [
            rec("AAA", "CS"),
            rec("OLDX", "CS", { delisted_utc: "2025-03-01T00:00:00Z", active: true }),
            rec("SPY", "ETF"),
          ],
          nextUrl: next,
        }),
        request: `/v3/reference/tickers?market=stocks&locale=us&active=true&order=asc&sort=ticker&limit=${MASSIVE_TICKER_PAGE_LIMIT}&date=${date}`,
        nextUrl: stripApiKeyFromUrl(next),
        fetchedAt: "2026-10-06T18:00:00.000Z",
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(report.mode, "probe");
  assert.equal(report.requests, 1);
  assert.ok(report.probe);
  assert.equal(report.probe!.httpStatus, 200);
  assert.equal(report.probe!.resultCount, 3);
  assert.equal(report.probe!.nextUrlPresent, true);
  assert.equal(report.probe!.countsByType.CS, 2);
  assert.equal(report.probe!.countsByType.ETF, 1);
  assert.equal(report.probe!.page1TickerCount, 3);
  assert.deepEqual(report.probe!.page1TickersSample, ["AAA", "OLDX", "SPY"]);
  assert.deepEqual(report.probe!.missingFromCurrentMaster, {
    status: "unavailable",
    reason: "absent",
  });
  assert.ok(report.probe!.estimatedPagesPerMonth >= 2);
  assert.equal(report.dates[0]!.status, "PROBE");
  assert.equal(report.dates[0]!.indexSealed, false);
  assert.equal(report.dates[0]!.complete, false);

  const pageKey = datedTickerPageKey(TICKER_INDEX_DATED_PROBE_DATE, 1);
  assert.ok(await store.get(pageKey));
  const manBytes = await store.get(datedTickerManifestKey(TICKER_INDEX_DATED_PROBE_DATE));
  assert.ok(manBytes);
  const man = JSON.parse(new TextDecoder().decode(manBytes!));
  assert.equal(man.pages[0].request.includes("apiKey"), false);
  assert.equal(man.resumeCursor.includes("apiKey"), false);
  assert.equal(man.resumeCursor.startsWith("/v3/"), true);
  // Incomplete probe must not seal an index.
  assert.equal((await listTickerReferenceIndexHistory(store)).length, 0);
});

test("full mode: paginates via next_url and seals index with asOf = date", async () => {
  const store = new MemoryObjectClient();
  const date = "2024-11-01";
  let calls = 0;
  const report = await runDatedTickerIndexBuild({
    store,
    env: { TICKER_INDEX_DATED: "true", TICKER_INDEX_DATED_FULL: "true" },
    now: SETTLED,
    clock,
    monthStarts: [date],
    fetchPage: async ({ date: d, nextUrl }) => {
      calls += 1;
      assert.equal(d, date);
      if (!nextUrl) {
        return {
          status: 200,
          body: pageBody({
            tickers: [rec("AAA", "CS"), rec("BBB", "CS")],
            nextUrl: `/v3/reference/tickers?cursor=p2&date=${date}`,
          }),
          request: `/v3/reference/tickers?market=stocks&locale=us&active=true&order=asc&sort=ticker&limit=1000&date=${date}`,
          nextUrl: `/v3/reference/tickers?cursor=p2&date=${date}`,
          fetchedAt: "2026-10-06T18:01:00.000Z",
        };
      }
      assert.equal(nextUrl, `/v3/reference/tickers?cursor=p2&date=${date}`);
      return {
        status: 200,
        body: pageBody({
          tickers: [rec("SPY", "ETF"), rec("QQQ", "ETF")],
        }),
        request: nextUrl,
        fetchedAt: "2026-10-06T18:02:00.000Z",
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(report.mode, "full");
  assert.equal(report.dates[0]!.status, "SEALED");
  assert.equal(report.dates[0]!.complete, true);
  assert.equal(report.dates[0]!.indexAsOf, date);
  assert.equal(report.dates[0]!.fingerprints?.source, "dated-list");
  assert.equal(report.dates[0]!.fingerprints?.requestedDate, date);
  assert.equal(report.dates[0]!.fingerprints?.pages.length, 2);

  const loaded = await loadTickerReferenceIndexAsOf(store, "2024-11-15");
  assert.ok(loaded);
  assert.equal(loaded!.asOf, date);
  assert.ok(loaded!.asOf <= "2024-11-15");
  // Later day in month still sees this month-start index; never a future one.
  const laterIdx = await loadTickerReferenceIndexAsOf(store, "2024-11-30");
  assert.equal(laterIdx!.asOf, date);
});

test("interrupted build resumes from stored cursor; zero refetch of stored pages", async () => {
  const store = new MemoryObjectClient();
  const date = "2024-11-01";
  const urls: string[] = [];
  const fetchPage = async ({ nextUrl }: { date: string; nextUrl?: string }) => {
    urls.push(nextUrl ?? "FIRST");
    if (!nextUrl) {
      return {
        status: 200,
        body: pageBody({
          tickers: [rec("AAA", "CS")],
          nextUrl: `/v3/reference/tickers?cursor=p2&date=${date}`,
        }),
        request: `/v3/reference/tickers?date=${date}&active=true`,
        nextUrl: `/v3/reference/tickers?cursor=p2&date=${date}`,
        fetchedAt: "2026-10-06T18:01:00.000Z",
      };
    }
    return {
      status: 200,
      body: pageBody({ tickers: [rec("SPY", "ETF")] }),
      request: nextUrl,
      fetchedAt: "2026-10-06T18:02:00.000Z",
    };
  };

  // Run 1: probe stores page 1 only.
  await runDatedTickerIndexBuild({
    store,
    env: { TICKER_INDEX_DATED: "true" },
    now: SETTLED,
    clock,
    fetchPage,
  });
  assert.deepEqual(urls, ["FIRST"]);

  // Run 2: full resumes — must not refetch page 1.
  urls.length = 0;
  const report = await runDatedTickerIndexBuild({
    store,
    env: { TICKER_INDEX_DATED: "true", TICKER_INDEX_DATED_FULL: "true" },
    now: SETTLED,
    clock,
    monthStarts: [date],
    fetchPage,
  });
  assert.deepEqual(urls, [`/v3/reference/tickers?cursor=p2&date=${date}`]);
  assert.equal(report.dates[0]!.pagesAdopted >= 1, true);
  assert.equal(report.dates[0]!.complete, true);
  assert.equal(report.dates[0]!.indexSealed, true);
});

test("corrupt stored page → CORRUPT, not refetched/overwritten", async () => {
  const store = new MemoryObjectClient();
  const date = "2024-11-01";
  let fetches = 0;
  await runDatedTickerIndexBuild({
    store,
    env: { TICKER_INDEX_DATED: "true" },
    now: SETTLED,
    clock,
    fetchPage: async () => {
      fetches += 1;
      return {
        status: 200,
        body: pageBody({
          tickers: [rec("AAA", "CS")],
          nextUrl: `/v3/reference/tickers?cursor=p2&date=${date}`,
        }),
        request: `/v3/reference/tickers?date=${date}`,
        nextUrl: `/v3/reference/tickers?cursor=p2&date=${date}`,
        fetchedAt: "2026-10-06T18:00:00.000Z",
      };
    },
  });
  assert.equal(fetches, 1);
  const key = datedTickerPageKey(date, 1);
  // Corrupt the .rdust bytes (module must not overwrite/refetch).
  await store.put(key, new TextEncoder().encode("not-reply-dust"));

  fetches = 0;
  const report = await runDatedTickerIndexBuild({
    store,
    env: { TICKER_INDEX_DATED: "true", TICKER_INDEX_DATED_FULL: "true" },
    now: SETTLED,
    clock,
    monthStarts: [date],
    fetchPage: async () => {
      fetches += 1;
      throw new Error("SHOULD_NOT_FETCH");
    },
  });
  assert.equal(fetches, 0);
  assert.equal(report.dates[0]!.status, "CORRUPT");
  assert.ok(report.dates[0]!.corruptKey);
  assert.ok(report.dates[0]!.error?.startsWith(TICKER_REFERENCE_DATED_OBJECT_CORRUPT));
  // Bytes unchanged (still garbage).
  const still = await store.get(key);
  assert.equal(new TextDecoder().decode(still!), "not-reply-dust");
});

test("guard window → no request", async () => {
  const store = new MemoryObjectClient();
  let fetches = 0;
  const report = await runDatedTickerIndexBuild({
    store,
    env: { TICKER_INDEX_DATED: "true" },
    now: SETTLED,
    clock,
    shouldYield: async () => "SCAN_GUARD_WINDOW:2026-10-06T05:20:00.000Z",
    fetchPage: async () => {
      fetches += 1;
      throw new Error("no");
    },
  });
  assert.equal(fetches, 0);
  assert.equal(report.yieldedForScan?.startsWith("SCAN_GUARD_WINDOW"), true);
  assert.equal(report.dates[0]!.status, "SKIPPED_GUARD");
});

test("month older than 2-year window skipped", async () => {
  const store = new MemoryObjectClient();
  let fetches = 0;
  // now = 2027-01 → 2024-11 is older than 2y; monthStarts override still filtered by window set
  // when using datedTickerMonthStarts internally — pass empty planned via monthStarts that
  // includes an old date and rely on SKIPPED_WINDOW when not in allowed set.
  const report = await runDatedTickerIndexBuild({
    store,
    env: { TICKER_INDEX_DATED: "true", TICKER_INDEX_DATED_FULL: "true" },
    now: new Date("2027-01-15T12:00:00Z"),
    clock: () => new Date("2027-01-15T12:00:00Z"),
    // Force an old date into the plan list; build filters against datedTickerMonthStarts(now).
    monthStarts: ["2024-11-01", "2025-02-01"],
    fetchPage: async ({ date }) => {
      fetches += 1;
      assert.equal(date, "2025-02-01");
      return {
        status: 200,
        body: pageBody({ tickers: [rec("AAA", "CS")] }),
        request: `/v3/reference/tickers?date=${date}`,
        fetchedAt: "2027-01-15T12:00:00.000Z",
      };
    },
  });
  assert.ok(report.dates.some((d) => d.date === "2024-11-01" && d.status === "SKIPPED_WINDOW"));
  assert.ok(report.dates.some((d) => d.date === "2025-02-01" && d.status !== "SKIPPED_WINDOW"));
  assert.equal(fetches, 1);
});

test("3b loader finds dated index for D in that month and never a later one", async () => {
  const store = new MemoryObjectClient();
  // Seal Nov 2024
  await runDatedTickerIndexBuild({
    store,
    env: { TICKER_INDEX_DATED: "true", TICKER_INDEX_DATED_FULL: "true" },
    now: SETTLED,
    clock,
    monthStarts: ["2024-11-01"],
    fetchPage: async ({ date }) => ({
      status: 200,
      body: pageBody({
        tickers: [rec("OLDX", "CS", { delisted_utc: "2025-01-01T00:00:00Z" }), rec("SPY", "ETF")],
      }),
      request: `/v3/reference/tickers?date=${date}`,
      fetchedAt: "2026-10-06T18:00:00.000Z",
    }),
  });
  // Seal Dec 2024 (later)
  await runDatedTickerIndexBuild({
    store,
    env: { TICKER_INDEX_DATED: "true", TICKER_INDEX_DATED_FULL: "true" },
    now: SETTLED,
    clock,
    monthStarts: ["2024-12-01"],
    fetchPage: async ({ date }) => ({
      status: 200,
      body: pageBody({
        tickers: [rec("ZZZ", "CS"), rec("SPY", "ETF")],
      }),
      request: `/v3/reference/tickers?date=${date}`,
      fetchedAt: "2026-10-06T18:00:00.000Z",
    }),
  });

  const forNov = await loadTickerReferenceIndexAsOf(store, "2024-11-20");
  assert.ok(forNov);
  assert.equal(forNov!.asOf, "2024-11-01");
  assert.ok(forNov!.entries.some((e) => e.ticker === "OLDX"));
  assert.ok(!forNov!.entries.some((e) => e.ticker === "ZZZ"));

  const forDec = await loadTickerReferenceIndexAsOf(store, "2024-12-15");
  assert.equal(forDec!.asOf, "2024-12-01");
  assert.ok(forDec!.entries.some((e) => e.ticker === "ZZZ"));
});


test("loadCurrentMasterTickerSet: currentSymbol + historicalSymbols; empty/unparseable/absent", async () => {
  const store = new MemoryObjectClient();
  assert.deepEqual(await loadCurrentMasterTickerSet(store), {
    status: "unavailable",
    reason: "absent",
  });

  await store.put("permanent/security-master.json", new TextEncoder().encode("not-json{"));
  assert.deepEqual(await loadCurrentMasterTickerSet(store), {
    status: "unavailable",
    reason: "unparseable",
  });

  await store.put("permanent/security-master.json", new TextEncoder().encode("[]"));
  assert.deepEqual(await loadCurrentMasterTickerSet(store), {
    status: "unavailable",
    reason: "empty",
  });

  // Ad-hoc {symbol} shape (wrong field) yields empty set → unavailable empty.
  await store.put(
    "permanent/security-master.json",
    new TextEncoder().encode(JSON.stringify([{ securityId: "x", symbol: "SPY" }])),
  );
  assert.deepEqual(await loadCurrentMasterTickerSet(store), {
    status: "unavailable",
    reason: "empty",
  });

  const renamed: SecurityMasterRecord = masterRecord("NEWCO", {
    historicalSymbols: [
      { symbol: "OLDCO", effectiveFrom: "2019-01-01", effectiveTo: "2023-06-01", source: "massive-stocks" },
      { symbol: "NEWCO", effectiveFrom: "2023-06-01", source: "massive-stocks" },
    ],
  });
  const spy: SecurityMasterRecord = masterRecord("SPY", { assetType: "ETF" });
  await plantMaster(store, [renamed, spy]);
  const loaded = await loadCurrentMasterTickerSet(store);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") throw new Error("expected ok");
  assert.ok(loaded.tickers.has("NEWCO"));
  assert.ok(loaded.tickers.has("OLDCO"));
  assert.ok(loaded.tickers.has("SPY"));
  assert.equal(loaded.tickers.size, 3);
});

test("probe summary: currentSymbol match, historicalSymbols match, genuinely missing counted", async () => {
  const store = new MemoryObjectClient();
  await plantMaster(store, [
    masterRecord("SPY", { assetType: "ETF" }),
    masterRecord("NEWCO", {
      historicalSymbols: [
        { symbol: "OLDX", effectiveFrom: "2018-01-01", effectiveTo: "2024-01-01", source: "massive-stocks" },
        { symbol: "NEWCO", effectiveFrom: "2024-01-01", source: "massive-stocks" },
      ],
    }),
  ]);
  const report = await runDatedTickerIndexBuild({
    store,
    env: { TICKER_INDEX_DATED: "true" },
    now: SETTLED,
    clock,
    fetchPage: async ({ date }) => ({
      status: 200,
      body: pageBody({
        // SPY → currentSymbol; OLDX → historicalSymbols; AAA → genuinely missing
        tickers: [rec("AAA", "CS"), rec("OLDX", "CS"), rec("SPY", "ETF")],
        nextUrl: `/v3/reference/tickers?cursor=p2&date=${date}`,
      }),
      request: `/v3/reference/tickers?date=${date}`,
      nextUrl: `/v3/reference/tickers?cursor=p2&date=${date}`,
      fetchedAt: "2026-10-06T18:00:00.000Z",
    }),
  });
  const miss = report.probe!.missingFromCurrentMaster;
  assert.equal(miss.status, "ok");
  if (miss.status !== "ok") throw new Error("expected ok");
  assert.equal(miss.count, 1);
  assert.deepEqual(miss.sample, ["AAA"]);
  assert.ok(report.probe!.page1TickersSample.includes("SPY"));
  assert.ok(report.probe!.page1TickersSample.includes("OLDX"));
});

test("probe summary: missingFromCurrentMaster unavailable for empty and unparseable master", async () => {
  const emptyStore = new MemoryObjectClient();
  await emptyStore.put("permanent/security-master.json", new TextEncoder().encode("[]"));
  const emptyReport = await runDatedTickerIndexBuild({
    store: emptyStore,
    env: { TICKER_INDEX_DATED: "true" },
    now: SETTLED,
    clock,
    fetchPage: async ({ date }) => ({
      status: 200,
      body: pageBody({ tickers: [rec("AAA", "CS")], nextUrl: `/v3/reference/tickers?cursor=p2&date=${date}` }),
      request: `/v3/reference/tickers?date=${date}`,
      nextUrl: `/v3/reference/tickers?cursor=p2&date=${date}`,
      fetchedAt: "2026-10-06T18:00:00.000Z",
    }),
  });
  assert.deepEqual(emptyReport.probe!.missingFromCurrentMaster, {
    status: "unavailable",
    reason: "empty",
  });

  const badStore = new MemoryObjectClient();
  await badStore.put("permanent/security-master.json", new TextEncoder().encode("{not json"));
  const badReport = await runDatedTickerIndexBuild({
    store: badStore,
    env: { TICKER_INDEX_DATED: "true" },
    now: SETTLED,
    clock,
    fetchPage: async ({ date }) => ({
      status: 200,
      body: pageBody({ tickers: [rec("AAA", "CS")], nextUrl: `/v3/reference/tickers?cursor=p2&date=${date}` }),
      request: `/v3/reference/tickers?date=${date}`,
      nextUrl: `/v3/reference/tickers?cursor=p2&date=${date}`,
      fetchedAt: "2026-10-06T18:00:00.000Z",
    }),
  });
  assert.deepEqual(badReport.probe!.missingFromCurrentMaster, {
    status: "unavailable",
    reason: "unparseable",
  });
});

test("default shouldYield: injected clock entering 05:15Z mid-date stops further requests", async () => {
  const store = new MemoryObjectClient();
  const date = "2024-11-01";
  // Start outside guard (04:00Z); after page 1, jump into 05:15–06:15 window.
  let nowMs = Date.parse("2026-10-06T04:00:00.000Z");
  const clockFn = (): Date => new Date(nowMs);
  const urls: string[] = [];
  const report = await runDatedTickerIndexBuild({
    store,
    env: { TICKER_INDEX_DATED: "true", TICKER_INDEX_DATED_FULL: "true" },
    now: new Date("2026-10-06T04:00:00.000Z"),
    clock: clockFn,
    // Do NOT inject shouldYield — exercise the default inScanGuardWindow(clock()).
    monthStarts: [date],
    fetchPage: async ({ nextUrl }) => {
      urls.push(nextUrl ?? "FIRST");
      // After the first request returns, move clock into the scan guard window.
      nowMs = Date.parse("2026-10-06T05:20:00.000Z");
      if (!nextUrl) {
        return {
          status: 200,
          body: pageBody({
            tickers: [rec("AAA", "CS")],
            nextUrl: `/v3/reference/tickers?cursor=p2&date=${date}`,
          }),
          request: `/v3/reference/tickers?date=${date}`,
          nextUrl: `/v3/reference/tickers?cursor=p2&date=${date}`,
          fetchedAt: "2026-10-06T04:00:00.000Z",
        };
      }
      throw new Error("SHOULD_NOT_FETCH_PAGE_2");
    },
  });
  assert.deepEqual(urls, ["FIRST"]);
  assert.equal(report.requests, 1);
  assert.ok(report.yieldedForScan?.startsWith("SCAN_GUARD_WINDOW:"));
  assert.ok(report.yieldedForScan?.includes("05:20:00"));
  assert.equal(report.dates[0]!.status, "SKIPPED_GUARD");
  assert.equal(report.dates[0]!.complete, false);
  assert.equal(report.dates[0]!.indexSealed, false);
});

test("disabled switch makes zero requests", async () => {
  let fetches = 0;
  const report = await runDatedTickerIndexBuild({
    store: new MemoryObjectClient(),
    env: {},
    now: SETTLED,
    clock,
    fetchPage: async () => {
      fetches += 1;
      throw new Error("no");
    },
  });
  assert.equal(report.enabled, false);
  assert.equal(fetches, 0);
  assert.equal(report.requests, 0);
});

test("full mode: plans months from 2024-11; probe-only does not seal; FULL alone is off", async () => {
  const now = new Date("2026-10-06T18:00:00.000Z");
  let fetches = 0;

  // FULL without DATED → phase off.
  const off = await runDatedTickerIndexBuild({
    store: new MemoryObjectClient(),
    env: { TICKER_INDEX_DATED_FULL: "true" },
    now,
    clock: () => now,
    fetchPage: async () => {
      fetches += 1;
      throw new Error("SHOULD_NOT_FETCH");
    },
  });
  assert.equal(off.enabled, false);
  assert.equal(fetches, 0);
  assert.deepEqual(off.datesPlanned, []);

  // Probe-only: single planned date, incomplete → no index seal.
  const probeStore = new MemoryObjectClient();
  const probe = await runDatedTickerIndexBuild({
    store: probeStore,
    env: { TICKER_INDEX_DATED: "true" },
    now,
    clock: () => now,
    fetchPage: async ({ date }) => ({
      status: 200,
      body: pageBody({
        tickers: [rec("AAA", "CS")],
        nextUrl: "https://api.massive.com/v3/reference/tickers?cursor=p2&apiKey=x",
      }),
      request: `/v3/reference/tickers?date=${date}`,
      nextUrl: "/v3/reference/tickers?cursor=p2",
      fetchedAt: now.toISOString(),
    }),
  });
  assert.equal(probe.mode, "probe");
  assert.deepEqual(probe.datesPlanned, [TICKER_INDEX_DATED_PROBE_DATE]);
  assert.equal(probe.dates[0]!.status, "PROBE");
  assert.equal(probe.dates[0]!.indexSealed, false);
  assert.equal((await listTickerReferenceIndexHistory(probeStore)).length, 0);

  // FULL: datesPlanned from 2024-11-01 through current month (no monthStarts override).
  // Yield immediately so we do not fetch every month in the unit test.
  const fullStore = new MemoryObjectClient();
  const full = await runDatedTickerIndexBuild({
    store: fullStore,
    env: { TICKER_INDEX_DATED: "true", TICKER_INDEX_DATED_FULL: "true" },
    now,
    clock: () => now,
    shouldYield: async () => "TEST_YIELD_AFTER_PLAN",
    fetchPage: async () => {
      fetches += 1;
      throw new Error("SHOULD_NOT_FETCH");
    },
  });
  assert.equal(full.mode, "full");
  assert.equal(full.datesPlanned[0], "2024-11-01");
  assert.equal(full.datesPlanned[full.datesPlanned.length - 1], "2026-10-01");
  assert.ok(full.datesPlanned.length >= 20);
  assert.ok(!full.datesPlanned.includes("2024-10-01"));
  assert.equal(full.dates[0]!.status, "SKIPPED_GUARD");
  assert.equal(full.requests, 0);
  assert.equal(fetches, 0);
  assert.equal((await listTickerReferenceIndexHistory(fullStore)).length, 0);

  const summary = tenMinDatedTickerSummary(full);
  assert.equal(summary.mode, "full");
  assert.equal(summary.firstPlanned, "2024-11-01");
  assert.equal(summary.lastPlanned, "2026-10-01");
  assert.equal(summary.datesPlanned, full.datesPlanned.length);
  assert.equal(summary.skippedGuard, 1);
  assert.equal(summary.sealed, 0);
  assert.equal(summary.requests, 0);
});

test("ALREADY_SEALED: second FULL run does not rewrite index or rewind asOf", async () => {
  const store = new MemoryObjectClient();
  const months = ["2024-11-01", "2024-12-01", "2025-01-01"] as const;

  async function sealMonth(date: string, tickers: ReturnType<typeof rec>[]) {
    const report = await runDatedTickerIndexBuild({
      store,
      env: { TICKER_INDEX_DATED: "true", TICKER_INDEX_DATED_FULL: "true" },
      now: SETTLED,
      clock,
      monthStarts: [date],
      fetchPage: async ({ date: d }) => ({
        status: 200,
        body: pageBody({ tickers }),
        request: `/v3/reference/tickers?date=${d}`,
        fetchedAt: "2026-10-06T18:00:00.000Z",
      }),
    });
    assert.equal(report.dates[0]!.status, "SEALED", date);
    assert.equal(report.dates[0]!.indexAsOf, date);
  }

  await sealMonth("2024-11-01", [rec("NOV", "CS"), rec("SPY", "ETF")]);
  await sealMonth("2024-12-01", [rec("DEC", "CS"), rec("SPY", "ETF")]);
  await sealMonth("2025-01-01", [rec("JAN", "CS"), rec("SPY", "ETF")]);

  const before = await loadTickerReferenceIndexAsOf(store, "2025-01-15");
  assert.ok(before);
  assert.equal(before!.asOf, "2025-01-01");
  assert.ok(before!.entries.some((e) => e.ticker === "JAN"));

  let liveManifestPuts = 0;
  const countingStore = {
    async get(key: string) {
      return store.get(key);
    },
    async put(key: string, body: Uint8Array, metadata?: object) {
      if (key === TICKER_REFERENCE_INDEX_MANIFEST_KEY) liveManifestPuts += 1;
      return store.put(key, body, metadata as never);
    },
    async head(key: string) {
      return store.head(key);
    },
    async delete(key: string) {
      return store.delete(key);
    },
    async list(prefix: string) {
      return store.list(prefix);
    },
  };

  // Yield after Nov is processed (second outer shouldYield = before Dec).
  let yieldCalls = 0;
  const report = await runDatedTickerIndexBuild({
    store: countingStore as never,
    env: { TICKER_INDEX_DATED: "true", TICKER_INDEX_DATED_FULL: "true" },
    now: SETTLED,
    clock,
    monthStarts: [...months],
    shouldYield: async () => {
      yieldCalls += 1;
      // 1 = before Nov; 2 = before Dec → stop so we only re-process Nov.
      if (yieldCalls >= 2) return "TIME_BUDGET";
      return undefined;
    },
    fetchPage: async () => {
      throw new Error("SHOULD_NOT_FETCH_ALREADY_COMPLETE");
    },
  });

  assert.equal(report.dates.length, 2); // Nov ALREADY_SEALED + Dec SKIPPED_GUARD
  assert.equal(report.dates[0]!.date, "2024-11-01");
  assert.equal(report.dates[0]!.status, "ALREADY_SEALED");
  assert.equal(report.dates[0]!.indexSealed, true);
  assert.equal(report.dates[0]!.indexAsOf, "2024-11-01");
  assert.equal(report.dates[1]!.status, "SKIPPED_GUARD");
  assert.equal(liveManifestPuts, 0, "must not rewrite live ticker reference index for ALREADY_SEALED");

  const after = await loadTickerReferenceIndexAsOf(store, "2025-01-15");
  assert.ok(after);
  assert.equal(after!.asOf, "2025-01-01", "asOf must not rewind to 2024-11-01");
  assert.ok(after!.entries.some((e) => e.ticker === "JAN"));
  assert.ok(after!.entries.some((e) => e.ticker === "SPY"));
});
