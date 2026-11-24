import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SecurityMasterRecord, TenMinuteRangeReply } from "./contracts";
import { sha256Hex } from "./intraday-reply-dust";
import { MemoryObjectClient } from "./object-store";
import { securityId } from "./identity";
import {
  TENMIN_SEAL_REFUSED_DAY_RETRYING,
  tenMinDailyIndexKey,
  tenMinHistoryDailyStepHold,
  tenMinRangeSealRefusal,
} from "./tenmin-daily-liquid";
import { runTenMinHistory, tradingSessionsBetween } from "./tenmin-history";
import { TENMIN_WAIT_DAILY_STEP, tenMinRunOutcome } from "./tenmin-redispatch";
import { readTenMinRangeManifest, tenMinRangeManifestKey, writeTenMinRangeReplyDust } from "./tenmin-range-reply-dust";

const PROVIDER = "massive-stocks";
const AT = "2026-10-06T08:00:00.000Z";
const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";
const encoder = new TextEncoder();
const id = (symbol: string) => securityId(PROVIDER, symbol, "STOCK");

async function putIndex(store: MemoryObjectClient, sessionDate: string, extra: Record<string, unknown>): Promise<void> {
  const body = {
    schemaVersion: "tenmin-daily-liquid-index-v1",
    sessionDate,
    rangeFrom: "2026-09-01",
    rangeTo: "2026-10-31",
    provider: PROVIDER,
    rule: { n: 1, lookbackSessions: 20, method: "m", trailingSessions: [] },
    selectedAt: "t",
    selected: [{ rank: 1, securityId: "sec_a", symbol: "A", dollarVolume: 1, sessions: 20 }],
    stored: [{ securityId: "sec_a", fetch: {}, bars: 38 }],
    gaps: [],
    ...extra,
    updatedAt: "t",
  };
  const checksum = sha256Hex(encoder.encode(JSON.stringify(body)));
  await store.put(tenMinDailyIndexKey(sessionDate), encoder.encode(JSON.stringify({ ...body, checksum })));
}

function pagesFor(security: { securityId: string; symbol: string }, from: string, to: string): TenMinuteRangeReply[] {
  const body = `{"ticker":"${security.symbol}","adjusted":false,"results":[{"v":1,"o":1,"c":1,"h":1,"l":1,"t":1730000000000,"n":1}],"status":"OK","request_id":"SYNTHETIC-${security.symbol}","count":1}`;
  return [
    {
      page: 1,
      request: `/v2/aggs/ticker/${security.symbol}/range/10/minute/${from}/${to}`,
      fetchedAt: AT,
      body: encoder.encode(body),
      rangeFrom: from,
      rangeTo: to,
      securityId: security.securityId,
      symbol: security.symbol,
    },
  ];
}

test("seal guard: a range seals only when every tracked day is full or STUCK_SHORT", async () => {
  const store = new MemoryObjectClient();
  const opts = { lastCompletedSession: "2026-10-09", catchupSessions: 3 };
  // Window = 10-07, 10-08, 10-09. Older days with no index are history-only.
  await putIndex(store, "2026-10-07", { done: { at: "t", expectedBars: 39 } });
  await putIndex(store, "2026-10-08", { notDoneRuns: 6, stuckShort: { status: "STUCK_SHORT", at: "t", passes: 6, dayBars: "38/39", dailyBars: "1/1", shortNames: 1, missingDailyBars: 0 } });
  await putIndex(store, "2026-10-09", { done: { at: "t", expectedBars: 39 } });
  assert.equal(await tenMinRangeSealRefusal(store, "2026-09-01", "2026-10-31", opts), undefined, "full + STUCK_SHORT days may seal");

  // A day still retrying refuses the seal, with its count.
  await putIndex(store, "2026-10-09", { notDoneRuns: 2 });
  assert.equal(await tenMinRangeSealRefusal(store, "2026-09-01", "2026-10-31", opts), `${TENMIN_SEAL_REFUSED_DAY_RETRYING}:2026-10-09:38/39`);

  // A window day the daily step has not tried yet must wait for it.
  const untried = new MemoryObjectClient();
  assert.equal(await tenMinRangeSealRefusal(untried, "2026-09-01", "2026-10-31", opts), `${TENMIN_SEAL_REFUSED_DAY_RETRYING}:2026-10-07:not-tried`);
  // A range wholly older than the window has no daily-step days: its own checks apply.
  assert.equal(await tenMinRangeSealRefusal(untried, "2026-07-01", "2026-08-31", opts), undefined);
});

test("seal guard: writeTenMinRangeReplyDust keeps the fetched work but does not seal while refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-seal-guard-"));
  try {
    const store = new MemoryObjectClient();
    let requests = 0;
    const write = (guard: string | undefined) =>
      writeTenMinRangeReplyDust({
        store,
        root,
        provider: PROVIDER,
        from: "2026-09-01",
        to: "2026-10-31",
        fetches: [{ securityId: id("AAA"), symbol: "AAA", fetchFrom: "2026-09-01", fetchTo: "2026-10-31" }],
        zstdVersionProbe: pinnedZstd,
        now: () => AT,
        sealGuard: async () => guard,
        fetchPages: async (s, f, t) => {
          requests += 1;
          return pagesFor(s, f, t);
        },
      });
    const refused = await write(`${TENMIN_SEAL_REFUSED_DAY_RETRYING}:2026-10-09:38/39`);
    assert.equal(refused.sealed, false);
    assert.equal(refused.sealRefused, `${TENMIN_SEAL_REFUSED_DAY_RETRYING}:2026-10-09:38/39`);
    assert.equal(await store.get(tenMinRangeManifestKey("2026-09-01", "2026-10-31")), undefined, "nothing sealed");
    const sealed = await write(undefined);
    assert.equal(sealed.sealed, true);
    assert.equal(requests, 1, "the stored fetch is resumed, not fetched again");
    assert.ok(await readTenMinRangeManifest(store, "2026-09-01", "2026-10-31"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function master(symbol: string): SecurityMasterRecord {
  return {
    securityId: id(symbol),
    currentSymbol: symbol,
    historicalSymbols: [{ symbol, effectiveFrom: "2020-01-01", source: PROVIDER }],
    assetType: "STOCK",
    country: "US",
    exchange: "NYSE",
    firstSeenAt: "2020-01-01",
    status: "ACTIVE",
    tradable: true,
    providerIdentities: [{ provider: PROVIDER, providerSecurityId: symbol }],
    eligibility: "LEVEL_0",
    barCount: 0,
    lastUniverseSeenAt: "2026-10-05",
  };
}

test("seal guard: a refused seal leaves the range PARTIAL and holds the chain on that day (wait, no alert)", async () => {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-seal-guard-"));
  try {
    const all = tradingSessionsBetween("2024-01-01", "2026-12-31");
    const result = await runTenMinHistory({
      root,
      store: new MemoryObjectClient(),
      securities: [master("AAA")],
      loadDailyBarSessions: async (month) => new Map([[id("AAA"), new Set(all.filter((d) => d.startsWith(`${month}-`)))]]),
      now: new Date("2026-10-06T12:00:00.000Z"),
      maxRanges: 1,
      writeReport: false,
      zstdVersionProbe: pinnedZstd,
      env: {},
      fetchGroupedDaily: async (sessionDate) => ({
        dataset: "stocks-grouped-daily",
        sessionDate,
        request: `/v2/aggs/grouped/locale/us/market/stocks/${sessionDate}`,
        fetchedAt: AT,
        body: encoder.encode(`{"queryCount":1,"resultsCount":1,"adjusted":false,"results":[{"T":"AAA","v":1,"o":1,"c":1,"h":1,"l":1,"t":${Date.parse(`${sessionDate}T21:00:00Z`)},"n":1}],"status":"OK","request_id":"G-${sessionDate}","count":1}`),
      }),
      fetchPages: async (s, f, t) => pagesFor(s, f, t),
      sealGuard: async (from) => (from === "2024-11-01" ? `${TENMIN_SEAL_REFUSED_DAY_RETRYING}:2024-12-30:38/39` : undefined),
    });
    const range = result.report.ranges[0]!;
    assert.equal(range.status, "PARTIAL");
    assert.equal(range.sealRefused, `${TENMIN_SEAL_REFUSED_DAY_RETRYING}:2024-12-30:38/39`);
    assert.equal(result.report.dailyStepHold, "2024-12-30");
    assert.equal(tenMinRunOutcome(result.report).reason, `${TENMIN_WAIT_DAILY_STEP}:2024-12-30`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("seal guard: wired into the host override with the done-day hold", () => {
  const on = tenMinHistoryDailyStepHold({ TENMIN_DAILY_ENABLED: "true", PEACESTOCKS_R2_BUCKET: "b" }, () => new MemoryObjectClient());
  assert.equal(typeof on.sealGuard, "function");
  assert.deepEqual(tenMinHistoryDailyStepHold({}), {});
});
