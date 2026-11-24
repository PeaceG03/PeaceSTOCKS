// The freeze gate and predictedAt use the clock at the write, not the host start. Run 45339628953 started at
// 06:20:10Z and wrote the Nov 23 picks at 06:42:58Z, but stored predictedAt 06:20:10Z because the host handed
// the scanner a clock frozen at start. A run that starts before the 09:30 ET open and writes after it must
// not freeze and must not count as on-time.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalDailyBar, CorporateAction, MarketProvider, ProviderSecurityRecord } from "./contracts";
import { hostWallClock, runScannerHost } from "./host";
import { openMarketStore } from "./object-storage";

const START = new Date("2026-11-24T06:20:10.000Z"); // 01:20 ET Tue; due session Mon Nov 23, open Tue 14:30Z

/** The bar fetch is where the time goes: the wall clock moves to `after` once bars were requested. */
class SlowProvider implements MarketProvider {
  readonly providerName = "fixture-provider";
  fetched = false;
  async listApprovedSecurities(): Promise<ProviderSecurityRecord[]> {
    return [{ provider: "fixture-provider", providerSecurityId: "i1", symbol: "AAA", assetType: "STOCK", country: "US", exchange: "NYSE", active: true, tradable: true }];
  }
  async getDailyBars(sessionDate: string, ids: string[]): Promise<CanonicalDailyBar[]> {
    this.fetched = true;
    return ids.map((id) => ({ securityId: id, sessionDate, open: 99, high: 101, low: 98, close: 100, volume: 1000, observedAt: `${sessionDate}T21:00:00Z`, ingestedAt: `${sessionDate}T22:00:00Z`, dataQuality: "GOOD", corporateActionIds: [], flags: [], schemaVersion: "foundation-d-v0", revision: 1, provenance: { provider: "fixture-provider", dataset: "daily-ohlcv", retrievalId: "r", ingestionVersion: "t", normalizerVersion: "t" } }));
  }
  async getCorporateActions(): Promise<CorporateAction[]> { return []; }
}

async function runAt(writeAt: string) {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-wclock-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "scheduler-host-state.json"),
      `${JSON.stringify({ schemaVersion: "peaceai-markets-scheduler-host:v1", forwardClockStartedAt: "2026-11-01T05:30:00.000Z", lastObservedSessionDate: "2026-11-20" }, null, 2)}\n`);
    const provider = new SlowProvider();
    const result = await runScannerHost({
      now: START,
      wallClock: () => (provider.fetched ? new Date(writeAt) : START),
      storageRoot: root,
      provider,
      completionDelayMinutes: 30,
      clock: () => 0,
      stageSink: () => {},
    });
    const store = openMarketStore(root);
    const statuses = await store.loadPredictionStatuses("2026-11-23");
    const health = JSON.parse(await readFile(join(root, "permanent/health/scan/2026-11-23.json"), "utf8").catch(() => "null")) as
      | { frozenOnTime: boolean } | null;
    return { result, statuses, health };
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
}

test("a run that starts before the open and writes after it does not freeze and is not on-time", async () => {
  const { result, statuses, health } = await runAt("2026-11-24T14:31:00.000Z");
  const report = result.reports?.find((r) => r.session.sessionDate === "2026-11-23");
  assert.ok(report, JSON.stringify(result));
  assert.equal(report.predictionStatus, "UNAVAILABLE");
  assert.equal(report.predictionReason, "FREEZE_AFTER_OPEN");
  assert.equal(report.predictedAt, "2026-11-24T14:31:00.000Z");
  assert.ok(statuses.every((s) => s.status !== "FROZEN"), JSON.stringify(statuses));
  assert.ok(statuses.some((s) => s.status === "UNAVAILABLE" && s.reason === "FREEZE_AFTER_OPEN"));
  assert.ok(health, "health record written");
  assert.equal(health.frozenOnTime, false);
});

test("predictedAt is the write time, not the host start (Nov 23: 06:42:58Z, not 06:20:10Z)", async () => {
  const { result, statuses, health } = await runAt("2026-11-24T06:42:58.000Z");
  const report = result.reports?.find((r) => r.session.sessionDate === "2026-11-23");
  assert.ok(report, JSON.stringify(result));
  assert.equal(report.predictionStatus, "FROZEN");
  assert.equal(report.predictedAt, "2026-11-24T06:42:58.000Z");
  const frozen = statuses.find((s) => s.status === "FROZEN");
  assert.equal(frozen?.predictedAt, "2026-11-24T06:42:58.000Z");
  assert.ok(health);
  assert.equal(health.frozenOnTime, true);
});

test("the production scanner clock is live, not the host start", async () => {
  const live = hostWallClock();
  const first = live().getTime();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = live().getTime();
  assert.ok(second - first >= 20, `clock moved ${second - first} ms`);
  assert.ok(Math.abs(second - Date.now()) < 1000);
  const fixed = new Date("2026-11-24T06:20:10.000Z");
  assert.equal(hostWallClock(fixed)(), fixed);
  const injected = () => new Date(0);
  assert.equal(hostWallClock(fixed, injected), injected);
});
