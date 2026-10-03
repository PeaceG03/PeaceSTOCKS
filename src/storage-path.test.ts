import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CanonicalDailyBar, MassiveAggregateBar } from "./contracts";
import { normalizeMassiveTenMinuteBars } from "./intraday";
import { MARKET_SCHEDULER_HOST_PATH_ERROR, runScannerHost } from "./host";
import { DustReader, MARKET_DUST_PATH_ERROR, writeSealedDustSession } from "./reader";
import { MARKET_STORAGE_PATH_ERROR, MarketStorage } from "./storage";
import { EphemeralValidationBuffer, MARKET_VALIDATION_BUFFER_PATH_ERROR } from "./validation";
import {
  MARKET_BACKFILL_PATH_ERROR,
  saveBackfillState,
  loadBackfillState,
  type BackfillState,
} from "./backfill";
import {
  MARKET_INTRADAY_BACKFILL_PATH_ERROR,
  saveIntradayBackfillState,
  loadIntradayBackfillState,
  type IntradayBackfillState,
} from "./intraday-backfill";

function bar(securityIdValue: string, date: string, close: number): CanonicalDailyBar {
  return {
    securityId: securityIdValue,
    sessionDate: date,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1000,
    observedAt: `${date}T21:00:00Z`,
    ingestedAt: `${date}T22:00:00Z`,
    dataQuality: "GOOD",
    corporateActionIds: [],
    flags: [],
    schemaVersion: "foundation-d-v0",
    revision: 1,
    provenance: {
      provider: "fixture-provider",
      dataset: "daily-ohlcv",
      retrievalId: `retrieval-${date}`,
      ingestionVersion: "test",
      normalizerVersion: "test",
    },
  };
}

function aggregate(symbol: string, iso: string, close: number): MassiveAggregateBar {
  return {
    symbol,
    timestamp: Date.parse(iso),
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 100,
    vwap: close - 0.25,
    transactionCount: 3,
  };
}

function backfillState(provider = "fixture-provider"): BackfillState {
  return {
    schemaVersion: "markets-scanner-backfill-v1",
    provider,
    from: "2026-01-05",
    to: "2026-01-06",
    completedSessions: ["2026-01-05"],
    failedSessions: {},
    updatedAt: "2026-01-06T00:00:00.000Z",
  };
}

function intradailyState(provider = "fixture-provider"): IntradayBackfillState {
  return {
    schemaVersion: "markets-scanner-intraday-backfill-v1",
    provider,
    from: "2026-01-05",
    to: "2026-01-06",
    completedSessions: ["2026-01-05"],
    failedSessions: {},
    updatedAt: "2026-01-06T00:00:00.000Z",
  };
}

test("market storage fails closed when its store root is replaced", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peaceai-market-storage-path-"));
  try {
    const storage = new MarketStorage(root);
    await storage.initialize();
    await storage.appendBars([bar("sec:1", "2026-01-05", 100)]);
    assert.equal((await storage.loadBars()).length, 1);
    fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(root, "replaced", "utf8");
    await assert.rejects(() => storage.loadBars(), new RegExp(MARKET_STORAGE_PATH_ERROR, "u"));
    await assert.rejects(
      () => storage.appendBars([bar("sec:2", "2026-01-06", 101)]),
      new RegExp(MARKET_STORAGE_PATH_ERROR, "u"),
    );
    await assert.rejects(
      () => storage.loadSecurities(),
      new RegExp(MARKET_STORAGE_PATH_ERROR, "u"),
    );
    await assert.rejects(
      () => storage.measureStorage(),
      new RegExp(MARKET_STORAGE_PATH_ERROR, "u"),
    );
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      fs.rmSync(root, { force: true });
    }
  }
});

test("market storage rejects empty or whitespace roots", () => {
  assert.throws(() => new MarketStorage(""), new RegExp(MARKET_STORAGE_PATH_ERROR, "u"));
  assert.throws(() => new MarketStorage("   "), new RegExp(MARKET_STORAGE_PATH_ERROR, "u"));
});

test("sealed dust writers fail closed when their store root is replaced", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peaceai-market-dust-path-"));
  try {
    const sessionDate = "2026-01-02";
    const records = normalizeMassiveTenMinuteBars({
      sessionDate,
      securityId: "security-1",
      symbol: "AAA",
      aggregates: [aggregate("AAA", "2026-01-02T14:30:00.000Z", 100)],
      provenance: {
        provider: "fixture-massive",
        dataset: "stocks-aggregates-10m",
        retrievalId: "retrieval-path",
        ingestionVersion: "test-v1",
        normalizerVersion: "test-normalizer-v1",
      },
      observedAt: "2026-01-02T20:00:00.000Z",
    });
    await writeSealedDustSession(root, records, { provider: "fixture-massive", sessionDate });
    const reader = new DustReader(root);
    assert.equal((await reader.manifest(sessionDate)).securityCount, 1);
    fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(root, "replaced", "utf8");
    await assert.rejects(
      () => reader.manifest(sessionDate),
      new RegExp(MARKET_DUST_PATH_ERROR, "u"),
    );
    await assert.rejects(
      () => writeSealedDustSession(root, records, { provider: "fixture-massive", sessionDate }),
      new RegExp(MARKET_DUST_PATH_ERROR, "u"),
    );
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      fs.rmSync(root, { force: true });
    }
  }
});

test("scheduler host fails closed when its storage root is a non-directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peaceai-market-host-path-"));
  try {
    fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(root, "replaced", "utf8");
    await assert.rejects(
      () => runScannerHost({ storageRoot: root }),
      new RegExp(MARKET_SCHEDULER_HOST_PATH_ERROR, "u"),
    );
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      fs.rmSync(root, { force: true });
    }
  }
});

test("ephemeral validation buffer fails closed when its store root is replaced", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peaceai-market-validation-path-"));
  try {
    const buffer = new EphemeralValidationBuffer(root, "2026-01-02");
    await buffer.append([]);
    fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(root, "replaced", "utf8");
    await assert.rejects(() => buffer.load(), new RegExp(MARKET_VALIDATION_BUFFER_PATH_ERROR, "u"));
    await assert.rejects(
      () => buffer.append([]),
      new RegExp(MARKET_VALIDATION_BUFFER_PATH_ERROR, "u"),
    );
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      fs.rmSync(root, { force: true });
    }
  }
});

test("backfill state writers fail closed when their store root is replaced", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peaceai-market-backfill-path-"));
  try {
    const statePath = path.join(root, "backfill-state.json");
    await saveBackfillState(statePath, backfillState());
    const loaded = await loadBackfillState(
      statePath,
      "fixture-provider",
      "2026-01-05",
      "2026-01-06",
    );
    assert.equal(loaded.completedSessions.length, 1);
    fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(root, "replaced", "utf8");
    await assert.rejects(
      () => loadBackfillState(statePath, "fixture-provider", "2026-01-05", "2026-01-06"),
      new RegExp(MARKET_BACKFILL_PATH_ERROR, "u"),
    );
    await assert.rejects(
      () => saveBackfillState(statePath, backfillState()),
      new RegExp(MARKET_BACKFILL_PATH_ERROR, "u"),
    );
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      fs.rmSync(root, { force: true });
    }
  }
});

test("intraday-backfill state writers fail closed when their store root is replaced", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peaceai-market-intraday-backfill-path-"));
  try {
    const statePath = path.join(root, "intraday-backfill-state.json");
    await saveIntradayBackfillState(statePath, intradailyState());
    const loaded = await loadIntradayBackfillState(
      statePath,
      "fixture-provider",
      "2026-01-05",
      "2026-01-06",
    );
    assert.equal(loaded.completedSessions.length, 1);
    fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(root, "replaced", "utf8");
    await assert.rejects(
      () => loadIntradayBackfillState(statePath, "fixture-provider", "2026-01-05", "2026-01-06"),
      new RegExp(MARKET_INTRADAY_BACKFILL_PATH_ERROR, "u"),
    );
    await assert.rejects(
      () => saveIntradayBackfillState(statePath, intradailyState()),
      new RegExp(MARKET_INTRADAY_BACKFILL_PATH_ERROR, "u"),
    );
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      fs.rmSync(root, { force: true });
    }
  }
});
