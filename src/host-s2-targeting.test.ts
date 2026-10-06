import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  CanonicalDailyBar,
  CorporateAction,
  MarketProvider,
  ProviderSecurityRecord,
} from "./contracts";
import { collectionDue } from "./scheduler";
import {
  forwardFreezeAllowed,
  nextEligibleSession,
  previousEligibleSession,
  runScannerHost,
} from "./host";
import { etCalendarDate, etWallClockToUtc } from "./et-time";
import { securityId } from "./identity";
import { MarketStorage } from "./storage";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

function providerRecord(
  providerSecurityId: string,
  symbol: string,
  assetType: "STOCK" | "ETF" = "STOCK",
): ProviderSecurityRecord {
  return {
    provider: "fixture-provider",
    providerSecurityId,
    symbol,
    assetType,
    country: "US",
    exchange: "NYSE",
    active: true,
    tradable: true,
  };
}

function bar(id: string, sessionDate: string, close: number): CanonicalDailyBar {
  return {
    securityId: id,
    sessionDate,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1_000_000,
    observedAt: `${sessionDate}T21:00:00.000Z`,
    ingestedAt: `${sessionDate}T21:05:00.000Z`,
    dataQuality: "GOOD",
    corporateActionIds: [],
    flags: [],
    schemaVersion: "foundation-d-v0",
    revision: 1,
    provenance: {
      provider: "fixture-provider",
      dataset: "daily-ohlcv",
      retrievalId: `r-${sessionDate}-${id.slice(0, 8)}`,
      ingestionVersion: "test",
      normalizerVersion: "test",
    },
  };
}

/** Records each getDailyBars session once per host collection. */
class RecordingProvider implements MarketProvider {
  readonly providerName = "fixture-provider";
  readonly barSessions: string[] = [];
  private readonly universe: ProviderSecurityRecord[];
  private readonly bars: CanonicalDailyBar[];

  constructor(sessions: readonly string[]) {
    const aaa = providerRecord("issuer-1", "AAA");
    const spy = providerRecord("issuer-spy", "SPY", "ETF");
    this.universe = [aaa, spy];
    const aaaId = securityId("fixture-provider", "issuer-1", "STOCK");
    const spyId = securityId("fixture-provider", "issuer-spy", "ETF");
    this.bars = sessions.flatMap((d, i) => [
      bar(aaaId, d, 100 + i),
      bar(spyId, d, 400 + i),
    ]);
  }

  async listApprovedSecurities(): Promise<ProviderSecurityRecord[]> {
    return this.universe;
  }
  async getDailyBars(sessionDate: string, ids: string[]): Promise<CanonicalDailyBar[]> {
    this.barSessions.push(sessionDate);
    return this.bars.filter((b) => b.sessionDate === sessionDate && ids.includes(b.securityId));
  }
  async getCorporateActions(): Promise<CorporateAction[]> {
    return [];
  }
}

async function seedCursor(root: string, lastObservedSessionDate: string, nowIso: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "scheduler-host-state.json"),
    `${JSON.stringify(
      {
        schemaVersion: "peaceai-markets-scheduler-host:v1",
        forwardClockStartedAt: nowIso,
        lastObservedSessionDate,
      },
      null,
      2,
    )}\n`,
  );
}

async function readCursor(root: string): Promise<string> {
  const state = JSON.parse(await readFile(join(root, "scheduler-host-state.json"), "utf8")) as {
    lastObservedSessionDate: string;
  };
  return state.lastObservedSessionDate;
}

function modesOf(result: Awaited<ReturnType<typeof runScannerHost>>): Array<{
  session: string;
  mode: "FORWARD" | "EVIDENCE_ONLY";
}> {
  return result.reports.map((r) => ({
    session: r.session.sessionDate,
    mode: r.predictionReason === "EVIDENCE_ONLY" ? ("EVIDENCE_ONLY" as const) : ("FORWARD" as const),
  }));
}

test("previous/next eligible and forwardFreezeAllowed honor calendar + 09:30 ET open", () => {
  assert.equal(previousEligibleSession("2026-10-05"), "2026-10-02"); // Mon → prior Fri
  assert.equal(previousEligibleSession("2026-09-07"), "2026-09-04"); // Labor Day → prior Fri
  assert.equal(nextEligibleSession("2026-10-05"), "2026-10-06");
  assert.equal(nextEligibleSession("2026-09-04"), "2026-09-08"); // Fri before Labor Day → Tue
  // 05:30Z Wed 10-07 = before Tue? due 10-06 → next open Wed 10-07 09:30 ET
  const before = new Date("2026-10-07T05:30:00.000Z");
  assert.equal(forwardFreezeAllowed("2026-10-06", before), true);
  const after = new Date("2026-10-07T14:00:00.000Z"); // 10:00 ET
  assert.equal(forwardFreezeAllowed("2026-10-06", after), false);
  // Open instant itself is not allowed (strictly before).
  const open = etWallClockToUtc("2026-10-07", 9, 30);
  assert.equal(forwardFreezeAllowed("2026-10-06", open), false);
  assert.equal(forwardFreezeAllowed("2026-10-06", new Date(open.getTime() - 1)), true);
});

test("S2 host: 21:30Z Tue 10-06 lastObserved 10-04 → 10-05 EVIDENCE_ONLY once; no 10-06; no FORWARD", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-s2-a-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    const now = new Date("2026-10-06T21:30:00.000Z");
    assert.equal(etCalendarDate(now), "2026-10-06");
    assert.equal(collectionDue({ now }).session.sessionDate, "2026-10-05");
    await seedCursor(root, "2026-10-04", now.toISOString());
    const provider = new RecordingProvider(["2026-10-02", "2026-10-05", "2026-10-06"]);
    const result = await runScannerHost({ now, storageRoot: root, provider });
    assert.deepEqual(modesOf(result), [{ session: "2026-10-05", mode: "EVIDENCE_ONLY" }]);
    assert.deepEqual(provider.barSessions, ["2026-10-05"]);
    assert.equal(result.reports.length, 1);
    const storage = new MarketStorage(root);
    assert.equal((await storage.loadPredictions("2026-10-05")).length, 0);
    assert.equal((await storage.loadBeliefs("2026-10-05")).length, 0);
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
});

test("S2 host: 05:30Z Wed 10-07 lastObserved 10-05 → 10-06 FORWARD once", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-s2-b-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    const now = new Date("2026-10-07T05:30:00.000Z");
    assert.equal(collectionDue({ now }).session.sessionDate, "2026-10-06");
    await seedCursor(root, "2026-10-05", now.toISOString());
    const provider = new RecordingProvider(["2026-10-05", "2026-10-06", "2026-10-07"]);
    const result = await runScannerHost({ now, storageRoot: root, provider });
    assert.deepEqual(modesOf(result), [{ session: "2026-10-06", mode: "FORWARD" }]);
    assert.deepEqual(provider.barSessions, ["2026-10-06"]);
    const storage = new MarketStorage(root);
    assert.ok((await storage.loadPredictionStatuses("2026-10-06")).some((s) => s.status === "FROZEN"));
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
});

test("S2 host: 05:30Z Wed 10-07 lastObserved 10-02 → 10-05 EVIDENCE_ONLY then 10-06 FORWARD, each once", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-s2-c-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    const now = new Date("2026-10-07T05:30:00.000Z");
    await seedCursor(root, "2026-10-02", now.toISOString());
    const provider = new RecordingProvider(["2026-10-02", "2026-10-05", "2026-10-06"]);
    const result = await runScannerHost({ now, storageRoot: root, provider });
    assert.deepEqual(modesOf(result), [
      { session: "2026-10-05", mode: "EVIDENCE_ONLY" },
      { session: "2026-10-06", mode: "FORWARD" },
    ]);
    assert.deepEqual(provider.barSessions, ["2026-10-05", "2026-10-06"]);
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
});

test("S2 host: 05:30Z Sat after Friday → Friday FORWARD once", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-s2-d-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    // Fri 2026-10-02; Sat 2026-10-03 05:30Z
    const now = new Date("2026-10-03T05:30:00.000Z");
    assert.equal(etCalendarDate(now), "2026-10-03");
    assert.equal(collectionDue({ now }).session.sessionDate, "2026-10-02");
    await seedCursor(root, "2026-10-01", now.toISOString());
    const provider = new RecordingProvider(["2026-10-01", "2026-10-02", "2026-10-05"]);
    const result = await runScannerHost({ now, storageRoot: root, provider });
    assert.deepEqual(modesOf(result), [{ session: "2026-10-02", mode: "FORWARD" }]);
    assert.deepEqual(provider.barSessions, ["2026-10-02"]);
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
});

test("S2 host: 05:30Z day after Labor Day 2026-09-07 → due CLOSED; no double; no FORWARD on holiday", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-s2-e-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    assert.equal(US_EQUITY_MARKET_CALENDAR.getSession("2026-09-07").kind, "CLOSED");
    const now = new Date("2026-09-08T05:30:00.000Z");
    const due = collectionDue({ now });
    assert.equal(due.session.sessionDate, "2026-09-07");
    assert.equal(due.due, false);
    assert.equal(due.reason, "CLOSED");
    // Friday already observed (would have been FORWARD on Saturday).
    await seedCursor(root, "2026-09-04", now.toISOString());
    const provider = new RecordingProvider(["2026-09-04", "2026-09-08"]);
    const result = await runScannerHost({ now, storageRoot: root, provider });
    assert.deepEqual(result.sessions, []);
    assert.deepEqual(provider.barSessions, []);
    assert.equal(result.status, "NOT_DUE");
    // Park on the CLOSED due day — never jump to today (09-08), which still needs collection later.
    assert.equal(await readCursor(root), "2026-09-07");
    assert.notEqual(await readCursor(root), "2026-09-08");
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
});

test("S2 host: 14:00Z (10:00 ET) Wed 10-07 lastObserved 10-05 → 10-06 EVIDENCE_ONLY (past open)", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-s2-f-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    const now = new Date("2026-10-07T14:00:00.000Z");
    assert.equal(etCalendarDate(now), "2026-10-07");
    await seedCursor(root, "2026-10-05", now.toISOString());
    const provider = new RecordingProvider(["2026-10-05", "2026-10-06", "2026-10-07"]);
    const result = await runScannerHost({ now, storageRoot: root, provider });
    assert.deepEqual(modesOf(result), [{ session: "2026-10-06", mode: "EVIDENCE_ONLY" }]);
    assert.deepEqual(provider.barSessions, ["2026-10-06"]);
    const storage = new MarketStorage(root);
    assert.equal((await storage.loadPredictions("2026-10-06")).length, 0);
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
});

test("S2 host: 13:29Z Wed 10-07 (09:29 EDT, 1m before open) lastObserved 10-05 → 10-06 FORWARD once with predictions", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-s2-g-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    const open = etWallClockToUtc("2026-10-07", 9, 30);
    assert.equal(open.toISOString(), "2026-10-07T13:30:00.000Z");
    const now = new Date("2026-10-07T13:29:00.000Z");
    assert.equal(now.getTime(), open.getTime() - 60_000);
    await seedCursor(root, "2026-10-05", now.toISOString());
    const provider = new RecordingProvider(["2026-10-05", "2026-10-06", "2026-10-07"]);
    const result = await runScannerHost({ now, storageRoot: root, provider });
    assert.deepEqual(modesOf(result), [{ session: "2026-10-06", mode: "FORWARD" }]);
    assert.deepEqual(provider.barSessions, ["2026-10-06"]);
    const storage = new MarketStorage(root);
    assert.ok((await storage.loadPredictions("2026-10-06")).length > 0);
    assert.ok((await storage.loadBeliefs("2026-10-06")).length > 0);
    assert.ok((await storage.loadPredictionStatuses("2026-10-06")).some((s) => s.status === "FROZEN"));
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
});

test("S2 host: exactly 13:30Z Wed 10-07 (09:30 EDT open) lastObserved 10-05 → 10-06 EVIDENCE_ONLY once; no predictions/beliefs", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-s2-h-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    const now = new Date("2026-10-07T13:30:00.000Z");
    assert.equal(etWallClockToUtc("2026-10-07", 9, 30).toISOString(), now.toISOString());
    await seedCursor(root, "2026-10-05", now.toISOString());
    const provider = new RecordingProvider(["2026-10-05", "2026-10-06", "2026-10-07"]);
    const result = await runScannerHost({ now, storageRoot: root, provider });
    assert.deepEqual(modesOf(result), [{ session: "2026-10-06", mode: "EVIDENCE_ONLY" }]);
    assert.deepEqual(provider.barSessions, ["2026-10-06"]);
    const storage = new MarketStorage(root);
    assert.equal((await storage.loadPredictions("2026-10-06")).length, 0);
    assert.equal((await storage.loadBeliefs("2026-10-06")).length, 0);
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
});

test("S3 host: after Labor Day CLOSED park, skipped Wed slots still catch 09-08 then FORWARD 09-09 on Thu", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-s3-labor-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    const tue = new Date("2026-09-08T05:30:00.000Z");
    await seedCursor(root, "2026-09-04", tue.toISOString());
    const provider = new RecordingProvider([
      "2026-09-04",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
    ]);
    const tueResult = await runScannerHost({ now: tue, storageRoot: root, provider });
    assert.deepEqual(tueResult.sessions, []);
    assert.equal(await readCursor(root), "2026-09-07");
    // Both Wednesday 09-09 slots dropped — no run. Thursday morning recovers.
    const thu = new Date("2026-09-10T05:30:00.000Z");
    assert.equal(collectionDue({ now: thu }).session.sessionDate, "2026-09-09");
    const thuResult = await runScannerHost({ now: thu, storageRoot: root, provider });
    assert.deepEqual(modesOf(thuResult), [
      { session: "2026-09-08", mode: "EVIDENCE_ONLY" },
      { session: "2026-09-09", mode: "FORWARD" },
    ]);
    assert.deepEqual(provider.barSessions, ["2026-09-08", "2026-09-09"]);
    assert.equal(await readCursor(root), "2026-09-09");
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
});

test("S3 host: PROVIDER_NOT_READY on due session parks cursor before that session (not on today)", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-s3-notready-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    // 05:30Z Wed 10-07 → due 10-06; provider refuses.
    const now = new Date("2026-10-07T05:30:00.000Z");
    await seedCursor(root, "2026-10-05", now.toISOString());
    const { MassiveMarketProvider } = await import("./massive-provider");
    const provider = new MassiveMarketProvider({
      apiKey: "test-key",
      minRequestIntervalMs: 0,
      retryBackoffMs: 0,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ message: "Attempted to request today's data before end of day" }),
          { status: 403 },
        ),
    });
    const result = await runScannerHost({ now, storageRoot: root, provider });
    assert.equal(result.status, "NOT_READY");
    assert.equal(result.reason, "PROVIDER_NOT_READY");
    assert.equal(await readCursor(root), "2026-10-05");
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
});

test("S3 host: successful FORWARD advances lastObserved to the due session only", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-s3-fwd-cursor-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    const now = new Date("2026-10-07T05:30:00.000Z");
    await seedCursor(root, "2026-10-05", now.toISOString());
    const provider = new RecordingProvider(["2026-10-05", "2026-10-06", "2026-10-07"]);
    const result = await runScannerHost({ now, storageRoot: root, provider });
    assert.deepEqual(modesOf(result), [{ session: "2026-10-06", mode: "FORWARD" }]);
    assert.equal(await readCursor(root), "2026-10-06");
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
});

test("S3 host: catch-up NOT_READY before due parks before the missed session; due is not marked observed", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-s3-miss-break-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    // due 10-06; catch-up should try 10-05 first and fail NOT_READY — must not advance to 10-06.
    const now = new Date("2026-10-07T05:30:00.000Z");
    await seedCursor(root, "2026-10-02", now.toISOString());
    const { MassiveMarketProvider } = await import("./massive-provider");
    const provider = new MassiveMarketProvider({
      apiKey: "test-key",
      minRequestIntervalMs: 0,
      retryBackoffMs: 0,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ message: "Attempted to request today's data before end of day" }),
          { status: 403 },
        ),
    });
    const result = await runScannerHost({ now, storageRoot: root, provider });
    assert.equal(result.status, "NOT_READY");
    assert.deepEqual([...result.sessions], ["2026-10-05"]);
    assert.equal(await readCursor(root), "2026-10-04");
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
});
