import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SecurityMasterRecord, TenMinuteRangeReply } from "./contracts";
import { securityId } from "./identity";
import { MemoryObjectClient, type ObjectMetadata } from "./object-store";
import {
  DEFAULT_TENMIN_HISTORY_WINDOW_START,
  lastCompletedSessionDate,
  planTenMinHistoryRanges,
  runTenMinHistory,
  runTenMinHistoryFromEnv,
  universeForTenMinRange,
} from "./tenmin-history";
import {
  readTenMinRangeManifest,
  tenMinRangeFileKey,
  tenMinRangeManifestKey,
  writeTenMinRangeReplyDust,
} from "./tenmin-range-reply-dust";

const PROVIDER = "massive-stocks";
const FROM = "2024-10-07";
const TO = "2024-11-30";
const AT = "2026-10-06T08:00:00.000Z";
const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";
const id = (symbol: string) => securityId(PROVIDER, symbol, "STOCK");
const encoder = new TextEncoder();

function pageBody(symbol: string, n = 1): string {
  return `{"ticker":"${symbol}","adjusted":false,"results":[{"v":1,"o":1,"c":1,"h":1,"l":1,"t":1730000000000,"n":1}],"status":"OK","request_id":"SYNTHETIC-${symbol}-p${n}","count":1}`;
}

function pagesFor(security: { securityId: string; symbol: string }, from: string, to: string): TenMinuteRangeReply[] {
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
  const securityIdValue = fields.securityId ?? id(symbol);
  const history =
    fields.history ??
    fields.historicalSymbols ??
    [{ symbol, effectiveFrom: fields.listingDate ?? "2020-01-01", source: PROVIDER }];
  return {
    securityId: securityIdValue,
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

test("planTenMinHistoryRanges: first range 2024-10-07..2024-11-30, two-month alignment, current excluded", () => {
  assert.equal(DEFAULT_TENMIN_HISTORY_WINDOW_START, "2024-10-07");
  const ranges = planTenMinHistoryRanges({
    windowStart: "2024-10-07",
    lastCompletedSession: "2025-04-15",
  });
  assert.deepEqual(ranges, [
    { from: "2024-10-07", to: "2024-11-30" },
    { from: "2024-12-01", to: "2025-01-31" },
    { from: "2025-02-01", to: "2025-03-31" },
  ]);
  // Last completed 2025-04-15: Apr-May 2025 ends 2025-05-31 which is NOT < 2025-04-15 → excluded.
  assert.equal(ranges.at(-1)?.to, "2025-03-31");
  // With a later last-completed, Apr-May appears.
  assert.deepEqual(
    planTenMinHistoryRanges({ windowStart: "2024-10-07", lastCompletedSession: "2025-06-02" }).slice(0, 4),
    [
      { from: "2024-10-07", to: "2024-11-30" },
      { from: "2024-12-01", to: "2025-01-31" },
      { from: "2025-02-01", to: "2025-03-31" },
      { from: "2025-04-01", to: "2025-05-31" },
    ],
  );
  assert.ok(ranges.every((r) => r.to < "2025-04-15"));
  // Oldest first.
  for (let i = 1; i < ranges.length; i += 1) assert.ok(ranges[i - 1]!.from < ranges[i]!.from);
  // Current incomplete Oct-Nov 2026 excluded when last completed is mid Oct-Nov pair.
  const mid = planTenMinHistoryRanges({
    windowStart: "2024-10-07",
    lastCompletedSession: "2026-10-05",
  });
  assert.ok(!mid.some((r) => r.from.startsWith("2026-10") || r.to === "2026-11-30"));
  assert.equal(mid.at(-1)?.to, "2026-09-30");
});

test("lastCompletedSessionDate is the prior eligible ET session", () => {
  // Tuesday 2026-10-06 ET morning → prior session Monday 2026-10-05.
  assert.equal(lastCompletedSessionDate(new Date("2026-10-06T12:00:00.000Z")), "2026-10-05");
  // Saturday → Friday.
  assert.equal(lastCompletedSessionDate(new Date("2026-10-10T18:00:00.000Z")), "2026-10-09");
});

test("universe overlap includes delisted names and picks max-coverage historical ticker", () => {
  const active = master("NEW", {
    listingDate: "2023-01-01",
    history: [
      // OLD covers most of Oct 7..Nov 30; NEW only the last 5 days.
      { symbol: "OLD", effectiveFrom: "2023-01-01", effectiveTo: "2024-11-25", source: PROVIDER },
      { symbol: "NEW", effectiveFrom: "2024-11-26", source: PROVIDER },
    ],
  });
  const delisted = master("GONE", {
    listingDate: "2022-01-01",
    delistedAt: "2024-11-15",
    status: "DELISTED",
    tradable: false,
    history: [{ symbol: "GONE", effectiveFrom: "2022-01-01", effectiveTo: "2024-11-15", source: PROVIDER }],
  });
  const future = master("FUT", { listingDate: "2025-01-01" });
  const noHist = master("GAP", {
    listingDate: "2020-01-01",
    history: [{ symbol: "GAP", effectiveFrom: "2025-01-01", source: PROVIDER }], // no overlap with Oct-Nov 2024
  });
  const plan = universeForTenMinRange([active, delisted, future, noHist], FROM, TO, AT);
  assert.equal(plan.securities.find((s) => s.securityId === id("NEW"))?.symbol, "OLD");
  assert.equal(plan.securities.find((s) => s.securityId === id("NEW"))?.symbolChoice, "MAX_COVERAGE");
  assert.equal(plan.securities.find((s) => s.securityId === id("GONE"))?.symbol, "GONE");
  assert.equal(plan.securities.find((s) => s.securityId === id("GONE"))?.symbolChoice, "SOLE_OVERLAP");
  assert.equal(plan.securities.length, 2);
  assert.ok(!plan.securities.some((s) => s.securityId === id("FUT")));
  assert.deepEqual(plan.gaps, [
    { securityId: id("GAP"), symbol: "", reason: "NO_HISTORICAL_SYMBOL", at: AT },
  ]);
});

test("one security MASSIVE_RANGE_PAGE_CAP becomes a gap and the range still seals", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    let fetches = 0;
    const good = { securityId: id("AAA"), symbol: "AAA" };
    const bad = { securityId: id("BAD"), symbol: "BAD" };
    const result = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: FROM,
      to: TO,
      securities: [good, bad],
      zstdVersionProbe: pinnedZstd,
      now: () => AT,
      fetchPages: async (security, from, to) => {
        fetches += 1;
        if (security.symbol === "BAD") throw new Error(`MASSIVE_RANGE_PAGE_CAP:BAD:${from}:${to}`);
        return pagesFor(security, from, to);
      },
    });
    assert.equal(result.sealed, true);
    assert.equal(result.alreadySealed, false);
    assert.equal(fetches, 2);
    assert.deepEqual(result.gaps, [
      { securityId: id("BAD"), symbol: "BAD", reason: "MASSIVE_RANGE_PAGE_CAP", at: AT },
    ]);
    const manifest = (await readTenMinRangeManifest(store, FROM, TO))!;
    assert.equal(manifest.securityCount, 1);
    assert.equal(manifest.gaps?.length, 1);
    assert.ok(await store.get(tenMinRangeManifestKey(FROM, TO)));
  });
});

test("401 aborts the run without gapping every security", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    let fetches = 0;
    await assert.rejects(
      () =>
        writeTenMinRangeReplyDust({
          store,
          root,
          provider: PROVIDER,
          from: FROM,
          to: TO,
          securities: [
            { securityId: id("A"), symbol: "A" },
            { securityId: id("B"), symbol: "B" },
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
    assert.equal(await readTenMinRangeManifest(store, FROM, TO), undefined);
  });
});

test("store error during resume throws with zero new fetches", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const security = { securityId: id("AAA"), symbol: "AAA" };
    await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: FROM,
      to: TO,
      securities: [security],
      zstdVersionProbe: pinnedZstd,
      fetchPages: (s, f, t) => Promise.resolve(pagesFor(s, f, t)),
    });
    // Unseal by deleting manifest so the next run resumes from stored pages.
    await store.delete(tenMinRangeManifestKey(FROM, TO));
    let fetches = 0;
    const failing = {
      get: (key: string) => store.get(key),
      put: (key: string, body: Uint8Array, metadata?: ObjectMetadata) => store.put(key, body, metadata),
      head: (key: string) => store.head(key),
      list: async () => {
        throw new Error("R2_LIST_FAILED");
      },
    };
    await assert.rejects(
      () =>
        writeTenMinRangeReplyDust({
          store: failing,
          root,
          provider: PROVIDER,
          from: FROM,
          to: TO,
          securities: [security, { securityId: id("BBB"), symbol: "BBB" }],
          zstdVersionProbe: pinnedZstd,
          fetchPages: async (s, f, t) => {
            fetches += 1;
            return pagesFor(s, f, t);
          },
        }),
      /R2_LIST_FAILED/,
    );
    assert.equal(fetches, 0);
  });
});

test("symbol mismatch on resume warns and refetches", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const sid = id("TICK");
    await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: FROM,
      to: TO,
      securities: [{ securityId: sid, symbol: "OLD" }],
      zstdVersionProbe: pinnedZstd,
      fetchPages: (s, f, t) => Promise.resolve(pagesFor(s, f, t)),
    });
    await store.delete(tenMinRangeManifestKey(FROM, TO));
    let fetches = 0;
    const result = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: FROM,
      to: TO,
      securities: [{ securityId: sid, symbol: "NEW" }],
      zstdVersionProbe: pinnedZstd,
      fetchPages: async (s, f, t) => {
        fetches += 1;
        assert.equal(s.symbol, "NEW");
        return pagesFor(s, f, t);
      },
    });
    assert.equal(fetches, 1);
    assert.ok(result.warnings?.some((w) => w === `TENMIN_RANGE_SYMBOL_CHANGED:${sid}:OLD:NEW`));
    const manifest = (await readTenMinRangeManifest(store, FROM, TO))!;
    assert.equal(manifest.securities[0]?.symbol, "NEW");
    const head = await store.head(tenMinRangeFileKey(FROM, TO, sid, 1));
    assert.equal(head?.metadata["rd-symbol"], "NEW");
  });
});

test("reopen retries only gaps + new securities, clears resolved gaps, deterministic manifest", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const good = { securityId: id("AAA"), symbol: "AAA" };
    const gapSec = { securityId: id("GAP"), symbol: "GAP" };
    const first = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: FROM,
      to: TO,
      securities: [good, gapSec],
      zstdVersionProbe: pinnedZstd,
      now: () => AT,
      fetchPages: async (s, f, t) => {
        if (s.symbol === "GAP") throw new Error("MASSIVE_HTTP_404:requestId=x:body=not found");
        return pagesFor(s, f, t);
      },
    });
    assert.equal(first.gaps[0]?.reason, "MASSIVE_HTTP_404");
    const sealedBytes = await store.get(tenMinRangeManifestKey(FROM, TO));
    // Normal run skips sealed range: zero fetches.
    let fetches = 0;
    const skipped = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: FROM,
      to: TO,
      securities: [good, gapSec, { securityId: id("NEW"), symbol: "NEW" }],
      zstdVersionProbe: pinnedZstd,
      fetchPages: async (s, f, t) => {
        fetches += 1;
        return pagesFor(s, f, t);
      },
    });
    assert.equal(skipped.alreadySealed, true);
    assert.equal(fetches, 0);
    assert.deepEqual(await store.get(tenMinRangeManifestKey(FROM, TO)), sealedBytes);

    const reopenFetched: string[] = [];
    const reopened = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: FROM,
      to: TO,
      securities: [good, gapSec, { securityId: id("NEW"), symbol: "NEW" }],
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
    const manifest = (await readTenMinRangeManifest(store, FROM, TO))!;
    assert.equal(manifest.securityCount, 3);
    assert.deepEqual(manifest.gaps, []);
    // Deterministic: same reopen again with nothing to do yields identical bytes after a no-op reopen
    // that still rewrites; compare two independent reopen builds from the same sealed+gaps state.
    const store2 = new MemoryObjectClient();
    await withRoot(async (root2) => {
      await writeTenMinRangeReplyDust({
        store: store2,
        root: root2,
        provider: PROVIDER,
        from: FROM,
        to: TO,
        securities: [good, gapSec],
        zstdVersionProbe: pinnedZstd,
        now: () => AT,
        fetchPages: async (s, f, t) => {
          if (s.symbol === "GAP") throw new Error("MASSIVE_HTTP_404:requestId=x:body=not found");
          return pagesFor(s, f, t);
        },
      });
      const a = await writeTenMinRangeReplyDust({
        store: store2,
        root: root2,
        provider: PROVIDER,
        from: FROM,
        to: TO,
        securities: [good, gapSec, { securityId: id("NEW"), symbol: "NEW" }],
        reopen: true,
        zstdVersionProbe: pinnedZstd,
        now: () => "2026-10-06T09:00:00.000Z",
        fetchPages: (s, f, t) => Promise.resolve(pagesFor(s, f, t)),
      });
      const store3 = new MemoryObjectClient();
      await writeTenMinRangeReplyDust({
        store: store3,
        root: root2,
        provider: PROVIDER,
        from: FROM,
        to: TO,
        securities: [good, gapSec],
        zstdVersionProbe: pinnedZstd,
        now: () => AT,
        fetchPages: async (s, f, t) => {
          if (s.symbol === "GAP") throw new Error("MASSIVE_HTTP_404:requestId=x:body=not found");
          return pagesFor(s, f, t);
        },
      });
      const b = await writeTenMinRangeReplyDust({
        store: store3,
        root: root2,
        provider: PROVIDER,
        from: FROM,
        to: TO,
        securities: [good, gapSec, { securityId: id("NEW"), symbol: "NEW" }],
        reopen: true,
        zstdVersionProbe: pinnedZstd,
        now: () => "2026-10-06T09:00:00.000Z",
        fetchPages: (s, f, t) => Promise.resolve(pagesFor(s, f, t)),
      });
      assert.deepEqual(
        await store2.get(tenMinRangeManifestKey(FROM, TO)),
        await store3.get(tenMinRangeManifestKey(FROM, TO)),
      );
      assert.deepEqual(a.manifest?.checksum, b.manifest?.checksum);
    });
  });
});

test("yields to the scan between securities and resumes without refetching completed ones", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const secs = ["A", "B", "C"].map((s) => ({ securityId: id(s), symbol: s }));
    let checks = 0;
    let fetches = 0;
    const first = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: FROM,
      to: TO,
      securities: secs,
      zstdVersionProbe: pinnedZstd,
      shouldYield: async () => (++checks >= 3 ? "SCAN_GUARD_WINDOW:test" : undefined),
      fetchPages: async (s, f, t) => {
        fetches += 1;
        return pagesFor(s, f, t);
      },
    });
    assert.equal(first.sealed, false);
    assert.equal(first.yieldedForScan, "SCAN_GUARD_WINDOW:test");
    assert.equal(fetches, 2); // A and B written; yield before C
    assert.equal(await readTenMinRangeManifest(store, FROM, TO), undefined);
    fetches = 0;
    const second = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: FROM,
      to: TO,
      securities: secs,
      zstdVersionProbe: pinnedZstd,
      fetchPages: async (s, f, t) => {
        fetches += 1;
        assert.equal(s.symbol, "C");
        return pagesFor(s, f, t);
      },
    });
    assert.equal(second.sealed, true);
    assert.equal(fetches, 1);
    assert.deepEqual(second.securitiesResumed.sort(), [id("A"), id("B")].sort());
    assert.deepEqual(second.securitiesWritten, [id("C")]);
  });
});

test("history runner processes oldest range first and respects maxRanges", async () => {
  await withRoot(async (root) => {
    const store = new MemoryObjectClient();
    const order: string[] = [];
    const securities = [master("AAA", { listingDate: "2020-01-01" })];
    const result = await runTenMinHistory({
      root,
      store,
      securities,
      windowStart: "2024-10-07",
      lastCompletedSession: "2025-04-15",
      maxRanges: 3,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      nowIso: () => AT,
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
    assert.equal(result.report.ranges.length, 3);
    assert.ok(result.report.ranges.every((r) => r.status === "SEALED"));
    assert.equal(result.report.massiveRequests, 3);
  });
});

test("history mode is off by default when env unset", async () => {
  const result = await runTenMinHistoryFromEnv({});
  assert.equal(result, undefined);
  const result2 = await runTenMinHistoryFromEnv({ PEACESTOCKS_TENMIN_HISTORY: "0" });
  assert.equal(result2, undefined);
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
