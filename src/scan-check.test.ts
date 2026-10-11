import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TenMinuteRangeReply } from "./contracts";
import { securityId } from "./identity";
import { MemoryObjectClient } from "./object-store";
import {
  SCAN_CHECK_INTERVAL_MS,
  createScanYieldCheck,
  isScanCheckFailure,
  rateLimitInfo,
  scanYieldReason,
} from "./scan-yield";
import { planTenMinAlert } from "./tenmin-alert";
import type { TenMinHistoryRunReport } from "./tenmin-history";
import {
  TENMIN_STOP_SCAN_CHECK_FAILED,
  decideTenMinRedispatch,
  tenMinRunOutcome,
  tenMinScanCheckFailure,
} from "./tenmin-redispatch";
import { writeTenMinRangeReplyDust } from "./tenmin-range-reply-dust";

const PROVIDER = "massive-stocks";
const pinnedZstd = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";
const encoder = new TextEncoder();
const ENV = {
  GITHUB_TOKEN: "t",
  GITHUB_REPOSITORY: "PeaceG03/PeaceSTOCKS",
  GITHUB_WORKFLOW_REF: "PeaceG03/PeaceSTOCKS/.github/workflows/scanner.yml@refs/heads/main",
  GITHUB_RUN_ID: "1",
  GITHUB_API_URL: "https://api.test",
} as NodeJS.ProcessEnv;

function pagesFor(security: { securityId: string; symbol: string }, from: string, to: string): TenMinuteRangeReply[] {
  return [
    {
      page: 1,
      request: `/v2/aggs/ticker/${security.symbol}/range/10/minute/${from}/${to}`,
      fetchedAt: "2026-10-11T06:00:00.000Z",
      body: encoder.encode(
        `{"ticker":"${security.symbol}","adjusted":false,"results":[{"v":1,"o":1,"c":1,"h":1,"l":1,"t":1730000000000,"n":1}],"status":"OK","request_id":"S-${security.symbol}","count":1}`,
      ),
      rangeFrom: from,
      rangeTo: to,
      securityId: security.securityId,
      symbol: security.symbol,
    },
  ];
}

/** Fake clock + fake GitHub runs API with a per-hour primary limit (403, x-ratelimit-remaining 0). */
function fakeGitHub(opts: { startIso: string; limitPerHour: number; runs?: unknown[] }) {
  let nowMs = Date.parse(opts.startIso);
  const windowStart = nowMs;
  let used = 0;
  const api = {
    calls: 0,
    clock: () => new Date(nowMs),
    advance: (ms: number) => {
      nowMs += ms;
    },
    fetchImpl: (async () => {
      api.calls += 1;
      const reset = Math.floor((windowStart + 3_600_000) / 1000);
      if (used >= opts.limitPerHour)
        return new Response('{"message":"API rate limit exceeded for installation."}', {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
        });
      used += 1;
      return new Response(JSON.stringify({ workflow_runs: opts.runs ?? [{ id: 1, status: "in_progress", event: "workflow_dispatch" }] }), {
        status: 200,
        headers: { "x-ratelimit-remaining": String(opts.limitPerHour - used) },
      });
    }) as typeof fetch,
  };
  return api;
}

async function withRange<T>(stored: number, fresh: number, run: (ctx: { store: MemoryObjectClient; root: string; fetches: { securityId: string; symbol: string; fetchFrom: string; fetchTo: string }[] }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-scan-check-"));
  try {
    const store = new MemoryObjectClient();
    const symbols = Array.from({ length: stored + fresh }, (_, i) => `T${String(i).padStart(4, "0")}`);
    const fetches = symbols.map((symbol) => ({
      securityId: securityId(PROVIDER, symbol, "STOCK"),
      symbol,
      fetchFrom: "2024-11-01",
      fetchTo: "2024-12-31",
    }));
    // A previous run stored the first `stored` fetches, then stopped (no seal).
    let made = 0;
    const seed = await writeTenMinRangeReplyDust({
      store,
      root,
      provider: PROVIDER,
      from: "2024-11-01",
      to: "2024-12-31",
      fetches,
      zstdVersionProbe: pinnedZstd,
      shouldYield: async () => (made >= stored ? "TIME_BUDGET:seed" : undefined),
      fetchPages: async (s, f, t) => {
        made += 1;
        return pagesFor(s, f, t);
      },
    });
    assert.equal(seed.sealed, false);
    // Fresh root: the next runner has no local progress hints, like a new Actions runner.
    await rm(root, { recursive: true, force: true });
    return await run({ store, root, fetches });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Run 38117572660 (Oct 11 2026): ~4,963 stored fetches re-verified, one runs-API call before each,
// GITHUB_TOKEN rate limit used up, 403, 0 Massive requests. Scaled down: 60 stored, limit 40/hour,
// ~0.7 s per verified fetch.
test("incident repro: a per-fetch API check over re-verified fetches hits the rate limit; the throttled check does not", async () => {
  await withRange(60, 3, async ({ store, root, fetches }) => {
    const old = fakeGitHub({ startIso: "2026-10-11T06:18:00Z", limitPerHour: 40 });
    let oldMassive = 0;
    const before = await writeTenMinRangeReplyDust({
      store, root, provider: PROVIDER, from: "2024-11-01", to: "2024-12-31", fetches, zstdVersionProbe: pinnedZstd,
      shouldYield: async () => {
        old.advance(700);
        return scanYieldReason({ env: ENV, now: old.clock, fetchImpl: old.fetchImpl });
      },
      fetchPages: async (s, f, t) => {
        oldMassive += 1;
        return pagesFor(s, f, t);
      },
    });
    assert.equal(before.yieldedForScan, "SCAN_CHECK_FAILED:http-403:rate-limited");
    assert.equal(oldMassive, 0, "the old check stopped the run before any Massive request");
    assert.equal(old.calls, 41);

    const gh = fakeGitHub({ startIso: "2026-10-11T06:18:00Z", limitPerHour: 40 });
    const check = createScanYieldCheck({ env: ENV, now: gh.clock, fetchImpl: gh.fetchImpl, sleep: async () => assert.fail("no retry needed") });
    let massive = 0;
    const after = await writeTenMinRangeReplyDust({
      store, root, provider: PROVIDER, from: "2024-11-01", to: "2024-12-31", fetches, zstdVersionProbe: pinnedZstd,
      shouldYield: async () => {
        gh.advance(700);
        return check();
      },
      fetchPages: async (s, f, t) => {
        massive += 1;
        gh.advance(12_500); // shared Massive pace
        return pagesFor(s, f, t);
      },
    });
    assert.equal(after.yieldedForScan, undefined);
    assert.equal(after.sealed, true);
    assert.equal(massive, 3);
    // 63 checks over ~81 s of fake time: one API call per SCAN_CHECK_INTERVAL_MS, not one per fetch.
    assert.ok(gh.calls <= 3, `api calls ${gh.calls}`);
  });
});

test("throttle: at most one API call per interval while clear; guard windows need no API call", async () => {
  const gh = fakeGitHub({ startIso: "2026-10-11T07:00:00Z", limitPerHour: 1000 });
  const check = createScanYieldCheck({ env: ENV, now: gh.clock, fetchImpl: gh.fetchImpl });
  // 5,000 checks, 0.69 s apart (the incident's pace): ~57 min.
  for (let i = 0; i < 5000; i += 1) {
    assert.equal(await check(), undefined);
    gh.advance(690);
  }
  assert.ok(gh.calls <= Math.ceil((5000 * 690) / SCAN_CHECK_INTERVAL_MS) + 1, `api calls ${gh.calls}`);
  assert.ok(gh.calls >= 50);
  const guard = fakeGitHub({ startIso: "2026-10-11T09:20:00Z", limitPerHour: 1000 });
  const guarded = createScanYieldCheck({ env: ENV, now: guard.clock, fetchImpl: guard.fetchImpl });
  assert.match((await guarded()) ?? "", /^SCAN_GUARD_WINDOW:/u);
  assert.equal(guard.calls, 0);
});

test("a waiting scan is never cached: the next call asks again", async () => {
  let waiting = false;
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({ workflow_runs: waiting ? [{ id: 7, status: "queued", event: "schedule", display_title: "Scanner" }] : [] });
  }) as typeof fetch;
  let t = Date.parse("2026-10-11T07:00:00Z");
  const check = createScanYieldCheck({ env: ENV, now: () => new Date(t), fetchImpl });
  assert.equal(await check(), undefined);
  waiting = true;
  t += 30_000;
  assert.equal(await check(), undefined, "within the interval the clear result stands (no call)");
  assert.equal(calls, 1);
  t += 30_000;
  assert.equal(await check(), "SCAN_RUN_WAITING:7:schedule:queued");
  t += 1_000;
  assert.equal(await check(), "SCAN_RUN_WAITING:7:schedule:queued");
  assert.equal(calls, 3);
});

test("fail closed: a rate limit resetting in 40 min stops at once (no sleep), with a stop + alert", async () => {
  const fetchImpl = (async () =>
    new Response('{"message":"API rate limit exceeded"}', {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Date.parse("2026-10-11T07:55:00Z") / 1000) },
    })) as typeof fetch;
  const slept: number[] = [];
  const check = createScanYieldCheck({ env: ENV, now: () => new Date("2026-10-11T07:15:00Z"), fetchImpl, sleep: async (ms) => void slept.push(ms) });
  const reason = await check();
  assert.equal(reason, "SCAN_CHECK_FAILED:http-403:rate-limited:attempts=1");
  assert.deepEqual(slept, []);
  assert.equal(isScanCheckFailure(reason), true);
  assert.equal(isScanCheckFailure("SCAN_GUARD_WINDOW:x"), false);
});

test("fail closed: a persistent plain 403 is retried 3 times, then stops; a transient one recovers", async () => {
  let calls = 0;
  const always403 = (async () => {
    calls += 1;
    return new Response('{"message":"Resource not accessible by integration"}', { status: 403 });
  }) as typeof fetch;
  const slept: number[] = [];
  const check = createScanYieldCheck({ env: ENV, now: () => new Date("2026-10-11T07:15:00Z"), fetchImpl: always403, sleep: async (ms) => void slept.push(ms) });
  assert.equal(await check(), "SCAN_CHECK_FAILED:http-403:attempts=4");
  assert.equal(calls, 4);
  assert.deepEqual(slept, [30_000, 60_000, 120_000]);

  let n = 0;
  const flaky = (async () => {
    n += 1;
    return n === 1
      ? new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 403, headers: { "retry-after": "45" } })
      : Response.json({ workflow_runs: [] });
  }) as typeof fetch;
  const waits: number[] = [];
  const recovers = createScanYieldCheck({ env: ENV, now: () => new Date("2026-10-11T07:15:00Z"), fetchImpl: flaky, sleep: async (ms) => void waits.push(ms) });
  assert.equal(await recovers(), undefined);
  assert.deepEqual(waits, [45_000], "honors retry-after when longer than the planned wait");
});

test("rateLimitInfo: primary, secondary, and non-rate-limit 403s", () => {
  const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k] ?? null });
  const now = Date.parse("2026-10-11T07:15:00Z");
  assert.deepEqual(rateLimitInfo({ status: 403, headers: headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 600) }) }, "", now), {
    failure: "http-403:rate-limited",
    retryAfterMs: 600_000,
  });
  assert.deepEqual(rateLimitInfo({ status: 429, headers: headers({ "retry-after": "60" }) }, "", now), { failure: "http-429:rate-limited", retryAfterMs: 60_000 });
  assert.deepEqual(rateLimitInfo({ status: 403, headers: headers({}) }, "secondary rate limit", now), { failure: "http-403:rate-limited" });
  assert.deepEqual(rateLimitInfo({ status: 403, headers: headers({ "x-ratelimit-remaining": "812" }) }, "Resource not accessible by integration", now), { failure: "http-403" });
});

function historyReport(extra: Partial<TenMinHistoryRunReport>): TenMinHistoryRunReport {
  return {
    schemaVersion: "tenmin-history-run-v1",
    runId: "tenmin-history-1",
    provider: PROVIDER,
    configuredWindowStart: "2024-10-01",
    windowStart: "2024-11-01",
    lastCompletedSession: "2026-10-09",
    skippedBefore: [],
    reopen: false,
    securityLink: "PROVISIONAL",
    ranges: [],
    rangesPlanned: 12,
    stoppedOnError: false,
    warnings: [],
    zstdVersion: "1.5.7",
    massiveRequests: 0,
    groupedDailyRequests: 0,
    groupedDailyStored: 0,
    groupedDailyResumed: 0,
    completedAt: "2026-10-11T07:15:56.000Z",
    ...extra,
  } as TenMinHistoryRunReport;
}

test("a persistent check failure stops the chain and alerts (paused or not); a scan yield still continues", () => {
  const reason = "SCAN_CHECK_FAILED:http-403:rate-limited:attempts=1";
  const report = historyReport({ yieldedForScan: reason });
  assert.equal(tenMinScanCheckFailure(report), reason);
  const outcome = tenMinRunOutcome(report);
  assert.deepEqual([outcome.nextAction, outcome.reason], ["stop", `${TENMIN_STOP_SCAN_CHECK_FAILED}:${reason}`]);
  // Also when it happens in the dated ticker-index phase.
  const dated = historyReport({ yieldedForScan: reason, yieldedInPhase: "dated_ticker_index" } as Partial<TenMinHistoryRunReport>);
  assert.equal(tenMinRunOutcome(dated).nextAction, "stop");

  const base = { trigger: "chain" as const, outcome, nowUtc: new Date("2026-10-11T07:16:00Z"), queue: { otherActiveRuns: 0 }, chain: 8, maxChain: undefined };
  // The host fails the history step (exit 2) on this reason.
  const decision = decideTenMinRedispatch({ ...base, jobResult: "failure", killSwitch: "true" });
  assert.deepEqual([decision.dispatch, decision.nextAction], [false, "stop"]);
  assert.match(decision.reason, /^STOP_SCAN_CHECK_FAILED:/u);
  const record = { outcome, jobResult: "failure", chain: 8, githubRunId: "38117572660", finishedAt: "2026-10-11T07:15:56Z", decision };
  const alertOn = planTenMinAlert({ trigger: "chain", record, historyStep: "failure", redispatchStep: "success", nextAction: "stop", reason: decision.reason, killSwitch: "true" });
  assert.equal(alertOn.action, "alert");
  // Redispatch paused on purpose (TENMIN_AUTO_REDISPATCH false): the failed history step still alerts.
  const paused = decideTenMinRedispatch({ ...base, jobResult: "failure", killSwitch: "false" });
  const alertPaused = planTenMinAlert({ trigger: "chain", record: { ...record, decision: paused }, historyStep: "failure", redispatchStep: "success", nextAction: paused.nextAction, reason: paused.reason, killSwitch: "false" });
  assert.equal(alertPaused.action, "alert");
  // The fallback never restarts it.
  const fallback = decideTenMinRedispatch({ ...base, trigger: "fallback", jobResult: "failure", killSwitch: "true" });
  assert.equal(fallback.nextAction, "stop");

  const scanYield = tenMinRunOutcome(historyReport({ yieldedForScan: "SCAN_RUN_WAITING:42:schedule:queued" }));
  assert.equal(scanYield.nextAction, "continue");
  assert.equal(tenMinScanCheckFailure(historyReport({ yieldedForScan: "SCAN_GUARD_WINDOW:x" })), undefined);
});
